// dsh-pet-desktop —— 本地后端
// 复刻 dsh-whale-widget 前端（assets/whale-widget.js）依赖的 /dsh-whale/* 最小契约：
//   balance.json / size.json / image.png / rua.gif / sound/*.mp3 必需；
//   bubble.json 等可选端点返回 404，前端自带默认值兜底。
// 纯 Node 零依赖；既被 Electron 主进程 require，也可以 `node server.js` 独立调试
// （独立跑时在浏览器打开打印的地址，即可在网页里看到与 DSH 内一致的挂件）。

const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { URL } = require('url')

const ROOT = __dirname
const ASSETS = path.join(ROOT, 'assets')
const PUBLIC = path.join(ROOT, 'public')
const PRESETS = path.join(ROOT, 'presets')   // 角色清单 / 台词队列的唯一来源
const CONFIG_FILE = path.join(ROOT, 'config.json')
const BACKUP_VERSION = 1

// 允许写入 / 导出 / 导入的配置键（白名单）。config.json 是用户本机文件，
// 不接受任意字段进来；新增字段时必须同时登记在这里，否则导出/导入会漏掉它。
//   · talk：只放**用户在本机改过的覆盖项**（enabled / idleMin）—— 选项池与台词在 presets/talk.json
//   · llm ：自定义 LLM 提供商（可选）。apiKey 是明文，导出时默认剔除（见 /pet-backup.json）
//   · moods：**按角色独立**的情绪（每人一格），见下方「情绪系统」
//   · mood ：旧版的单条全局情绪，只为导入老备份保留（读到会迁进 moods，之后不再写）
const CONFIG_KEYS = ['demo', 'dsKey', 'dsMode', 'role', 'autostart', 'widget', 'bubbleGpt', 'bubbleWhale', 'mood', 'talk', 'llm', 'moods']

// —— 情绪系统（已实现：点太频繁会生气，生气期间只回生气台词）——
// 规则（用户 2026-10-07 定稿）：
//   · 统计**滚动 1 分钟**内的「真点击」次数（拖拽不算，判定在前端）
//   · 25–34 次 → 1 档，气 1 分钟
//   · 35–49 次 → 2 档，气 3 分钟
//   · ≥50 次  → 3 档，气 5 分钟（封顶）
//   · 生气期间点角色仍有反应，但只回生气台词（见 presets/bubbles.json 的 gptAngry）
//   · **情绪按角色独立**（2026-10-07 追加）：每人一格，互不影响；切换角色另有"被甩下"的惩罚
// 持久化：config.json 的 moods = { [roleId]: { state, until, level, lockUntil, hideUntil, by } }
//   until/lockUntil/hideUntil 全用**绝对时间戳**而不是剩余秒数 —— 重启/关机再开都能正确续算，
//   不会因为重启白送一次时长。只在情绪变化时写盘，不是每次点击都写。
const MOOD_WINDOW_MS = 60 * 1000
const MOOD_TIERS = [
  { min: 50, level: 3, durationMs: 5 * 60 * 1000 },
  { min: 35, level: 2, durationMs: 3 * 60 * 1000 },
  { min: 25, level: 1, durationMs: 1 * 60 * 1000 },
]

// —— 情绪状态（fork 定制：聊天选项 + 吃醋把「情绪」从两态扩到四态）——
//   normal   待机
//   angry    点太频繁 → 1/2/3 档，时长由档位决定（既有规则，一字未改）
//   jealous  聊天选项里夸了别的 AI 娘 / 提到和别的 AI 娘互动（见 presets/talk.json 的 rivals）
//   sad      聊天选项被敷衍，或选项泡被无视
// `serious` / `calm` **不是**情绪，只是反应语气：serious = 回 normal 但语气变冷，calm = 消气回 normal。
const MOOD_STATES = ['normal', 'angry', 'jealous', 'sad']
// 该状态没有专属素材时借用谁（回落链）。两位在场角色的四态素材都已齐全，
// 这条链留给以后新增的角色：只做 idle/angry 两态也能上线，吃醋/伤心先借生气的。
const MOOD_STATE_FALLBACK = { jealous: 'angry', sad: 'angry' }
const MOOD_LABEL = { normal: '待机', angry: '生气', jealous: '吃醋', sad: '伤心' }
// 聊天反应 → 情绪：只有这三种反应会改情绪，serious/calm 一律回 normal
const REACTION_MOOD = { angry: 'angry', jealous: 'jealous', sad: 'sad', serious: 'normal', calm: 'normal' }
// 兜底时长/动作（presets/talk.json 的 reactions 优先，缺失时才用这里）
const REACTION_HOLD_DEFAULT = { angry: 90000, jealous: 150000, sad: 60000, serious: 0, calm: 0 }
const REACTION_ACTION_DEFAULT = { angry: 'shake', jealous: 'tremble', sad: 'shake', serious: 'jump', calm: 'jump' }

function moodTierFor(count) {
  for (const t of MOOD_TIERS) {
    if (count >= t.min) return t
  }
  return null
}

// ===== 情绪按角色独立（2026-10-07 用户定稿：gpt娘 生气不该跟着小鲸鱼一起生气）=====
// config.moods = { [roleId]: { state, until, level, lockUntil, hideUntil, by } }
//   · state/until/level：该角色自己的情绪（绝对时间戳，重启续算，与旧版口径一致）
//   · lockUntil：交互锁 —— 切回她时她还在气头上，在此之前**点她/拖她她都不理**（前端判）
//   · hideUntil：躲藏 —— 你甩下她之后她最多消失 hideMaxMs（≤3 分钟），此间**切不回她**
//   · by：'click'(连点) / 'talk'(聊天选项) / 'switch'(被切换甩下) —— 惩罚只对 by==='switch' 的情绪生效
// 旧版的单条 mood 在第一次读到时迁进当前角色名下（只迁一次，之后不再读写 mood）。
function readMoods() {
  const cfg = readConfig()
  if (cfg.moods && typeof cfg.moods === 'object' && !Array.isArray(cfg.moods)) return cfg.moods
  if (cfg.mood && typeof cfg.mood === 'object' && !Array.isArray(cfg.mood)) {
    // 迁移：老的全局情绪 → 当前角色（谁在场算谁的）
    const m = {}
    m[currentRoleId()] = cfg.mood
    writeConfig({ moods: m })
    console.log('[dsh-pet] 旧版全局情绪已迁移到角色 ' + currentRoleId() + ' 名下')
    return m
  }
  return {}
}
function writeMood(roleId, slot) {
  const m = readMoods()
  if (slot) m[roleId] = slot
  else delete m[roleId]
  writeConfig({ moods: m })
}
/** 某角色的情绪槽（纯读，不迁移不写盘）；没有就是 null。 */
function moodSlot(roleId) {
  const s = readMoods()[roleId]
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : null
}

/** 读**当前角色**的情绪；已到期则返回 normal（不写盘，写盘交给调用方决定）。 */
function currentMood() {
  const s = moodSlot(currentRoleId())
  const lockUntil = s ? (Number(s.lockUntil) || 0) : 0
  const hideUntil = s ? (Number(s.hideUntil) || 0) : 0
  const state = s && MOOD_STATES.indexOf(s.state) >= 0 ? s.state : 'normal'
  if (state === 'normal') return { state: 'normal', level: 0, until: 0, remainingMs: 0, lockUntil, hideUntil }
  const until = Number(s.until) || 0
  const remainingMs = until - Date.now()
  if (remainingMs <= 0) return { state: 'normal', level: 0, until: 0, remainingMs: 0, expired: true, lockUntil, hideUntil }
  return { state: state, level: Number(s.level) || 1, until, remainingMs, lockUntil, hideUntil }
}

/**
 * 直接设定**当前角色**的情绪（聊天选项的反应走这里）。
 * holdMs <= 0 或不认识的 state ⇒ 清掉她的情绪；angry 的**档位**仍由 recordMoodClick 维护。
 * 她在跟你对话 = 已经给了台阶 → 交互锁一并取消（躲藏字段是"被甩下"的，切回来时早已不适用，一并清掉）。
 */
function setMoodState(state, holdMs, meta) {
  const roleId = currentRoleId()
  const st = MOOD_STATES.indexOf(state) >= 0 ? state : 'normal'
  const ms = Number(holdMs) || 0
  if (st === 'normal' || ms <= 0) {
    writeMood(roleId, null)
    console.log('[dsh-pet] ' + roleId + ' 情绪消解 → 待机' +
      (meta && meta.reason ? '（' + meta.reason + '）' : ''))
  } else {
    writeMood(roleId, {
      state: st, until: Date.now() + ms, level: Number((meta && meta.level) || 0),
      by: 'talk', lockUntil: 0, hideUntil: 0,
    })
    console.log('[dsh-pet] ' + roleId + ' 情绪切换：' + MOOD_LABEL[st] + '，持续 ' + Math.round(ms / 1000) + ' 秒' +
      (meta && meta.reason ? '（' + meta.reason + '）' : ''))
  }
  return currentMood()
}

// 点击时刻缓冲：**只留内存、不落盘**，且**按角色各记各的**（点 gpt娘 不该让小鲸鱼也生气）。
// 若每次点击都写 config.json，25 次点击就是 25 次磁盘写入；而且这是"最近 1 分钟"的短时状态，
// 重启后重新计数是合理的。
const moodClicks = {} // roleId -> [timestamp]

/** 记一次当前角色的点击，必要时升级情绪。返回当前情绪快照。 */
function recordMoodClick() {
  const now = Date.now()
  const roleId = currentRoleId()
  const cur = currentMood()
  // 交互锁内 = 她背过身去不理你：连点击都不记（不重置情绪，不攒档位）
  if (cur.lockUntil > now) return cur
  moodClicks[roleId] = (moodClicks[roleId] || []).filter((t) => now - t < MOOD_WINDOW_MS)
  const buf = moodClicks[roleId]
  buf.push(now)

  // 吃醋/伤心不该被连点悄悄覆盖掉：要么自然到期，要么被聊天选项改掉。
  if (cur.state !== 'normal' && cur.state !== 'angry') return cur
  const tier = moodTierFor(buf.length)

  if (cur.state === 'angry') {
    // 已经生气：继续点不延长时长（已定稿口径）。
    // 但档位可以**升高** —— 否则"越点越气"永远到不了 2/3 档：
    // 25 次触发 1 档后若把计数清零，下一个 35 次窗口又要重新数，中间必然先撞 25 再触发，
    // 永远停在 1 档（实测踩过）。所以保留缓冲，并在档位升高时换更长的时长。
    if (tier && tier.level > cur.level) {
      const until = now + tier.durationMs
      writeMood(roleId, { state: 'angry', until, level: tier.level, by: 'click', lockUntil: 0, hideUntil: 0 })
      console.log('[dsh-pet] ' + roleId + ' 情绪升档：1 分钟内点击 ' + buf.length + ' 次 → 生气 ' +
        tier.level + ' 档，持续 ' + Math.round(tier.durationMs / 1000) + ' 秒')
      return currentMood()
    }
    return cur
  }

  if (!tier) return cur

  const until = now + tier.durationMs
  writeMood(roleId, { state: 'angry', until, level: tier.level, by: 'click', lockUntil: 0, hideUntil: 0 })
  console.log('[dsh-pet] ' + roleId + ' 情绪升级：1 分钟内点击 ' + buf.length + ' 次 → 生气 ' + tier.level +
    ' 档，持续 ' + Math.round(tier.durationMs / 1000) + ' 秒')
  return currentMood()
}

/**
 * 到期则清掉情绪（**遍历所有角色** —— 每人一格，换着气也要到点消）。
 * 躲藏期（hideUntil）独立计时：情绪过了但还没到 3 分钟的，她照样躲着。
 * 返回是否有角色（特指当前角色）回到 normal，用于决定要不要走写盘/提示。
 */
function expireMoodIfNeeded() {
  const moods = readMoods()
  const now = Date.now()
  let dirty = false
  let currentChanged = false
  for (const id of Object.keys(moods)) {
    const s = moods[id]
    if (!s || typeof s !== 'object') continue
    const st = MOOD_STATES.indexOf(s.state) >= 0 ? s.state : 'normal'
    if (st !== 'normal' && (Number(s.until) || 0) <= now) {
      // 只清情绪，保留躲藏（躲藏有自己的倒计时）
      moods[id] = { state: 'normal', until: 0, level: 0, by: s.by, lockUntil: Number(s.lockUntil) || 0, hideUntil: Number(s.hideUntil) || 0 }
      dirty = true
      if (id === currentRoleId()) currentChanged = true
      console.log('[dsh-pet] ' + id + ' 情绪到点，回到 normal')
    }
  }
  if (dirty) writeConfig({ moods })
  return currentChanged
}

// ===== 切换惩罚：没打招呼就切走 → 被甩下的那位吃醋/伤心（见 presets/talk.json 的 switchAway）=====
function switchAwaySpec() {
  const sa = (presetTalk().switchAway) || {}
  const clampMs = (v, d, lo, hi) => {
    const n = Number(v)
    return isFinite(n) && n >= lo ? Math.min(hi, Math.round(n)) : d
  }
  const pct = (v, d) => {
    const n = Number(v)
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : d
  }
  return {
    enabled: sa.enabled !== false,
    sadChance: pct(sa.sadChance, 0.5),                        // 伤心概率（否则吃醋）
    // holdMs 下限是 0：0 = 关掉"被甩下"这条惩罚（冒烟测试用它让切换完全无副作用）
    holdMs: clampMs(sa.holdMs, 120000, 0, 30 * 60000),        // 被甩下的情绪时长（默认 2 分钟）
    lockMs: clampMs(sa.lockMs, 60000, 0, 10 * 60000),         // 切回来时的交互锁（0 = 不锁）
    hideChance: pct(sa.hideChance, 0.4),                      // 直接躲起来的概率
    hideMinMs: clampMs(sa.hideMinMs, 60000, 1000, 30 * 60000),
    // 用户定稿：消失**最多 3 分钟**（硬上限在这里夹死，改预设也超不过去）
    hideMaxMs: clampMs(sa.hideMaxMs, 180000, 1000, 180000),
  }
}

/** 你切走时，给**被甩下的角色**写入 吃醋/伤心 + 概率躲藏。返回写入的槽（便于测试）。 */
function applySwitchAway(roleId) {
  const sa = switchAwaySpec()
  if (!sa.enabled || sa.holdMs <= 0) return null   // 情绪时长 0 = 这条惩罚整体关闭，一个字段都不写
  const now = Date.now()
  const state = Math.random() < sa.sadChance ? 'sad' : 'jealous'
  const slot = { state, until: now + sa.holdMs, level: 0, by: 'switch', lockUntil: 0, hideUntil: 0 }
  if (Math.random() < sa.hideChance) {
    const span = Math.max(0, sa.hideMaxMs - sa.hideMinMs)
    slot.hideUntil = now + sa.hideMinMs + Math.floor(Math.random() * (span + 1))
  }
  writeMood(roleId, slot)
  console.log('[dsh-pet] 切换角色：' + roleId + ' 被甩下 → ' + MOOD_LABEL[state] +
    ' ' + Math.round(sa.holdMs / 1000) + 's' +
    (slot.hideUntil ? '，躲藏 ' + Math.round((slot.hideUntil - now) / 1000) + 's' : ''))
  return slot
}

/** 切回她时：她还在被甩下的情绪里 → 上交互锁（点她/拖她她都不理）。返回 lockUntil。 */
function lockOnReturn(roleId) {
  const sa = switchAwaySpec()
  if (!sa.enabled || sa.lockMs <= 0) return 0
  const now = Date.now()
  const s = moodSlot(roleId)
  if (!s || s.by !== 'switch') return 0
  if (s.state !== 'jealous' && s.state !== 'sad') return 0
  if ((Number(s.until) || 0) <= now) return 0 // 情绪已过 → 正常对待
  s.lockUntil = now + sa.lockMs
  writeMood(roleId, s)
  console.log('[dsh-pet] ' + roleId + ' 切回来还在气头上 → 交互锁 ' + Math.round(sa.lockMs / 1000) + 's（点她/拖她都不理）')
  return s.lockUntil
}

/** 该角色还躲着吗（>0 表示还剩多少毫秒）。躲藏中的角色切不回去。 */
function roleHiddenMs(roleId) {
  const s = moodSlot(roleId)
  if (!s) return 0
  return Math.max(0, (Number(s.hideUntil) || 0) - Date.now())
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (err) {
    if (err && err.code !== 'ENOENT') console.warn('[dsh-pet] config.json 读取失败（按空配置继续）：' + err.message)
    return {}
  }
}

// 配置变更订阅：主进程用它同步「开机自启」等需要操作系统配合的项。
const configListeners = new Set()
function onConfigChanged(fn) {
  configListeners.add(fn)
  return () => configListeners.delete(fn)
}

// 原子写：先写临时文件再 rename，避免写一半崩溃把 config.json 变成半截 JSON
// （那会让 readConfig() 静默回落成 {}，用户看到的是"设置全丢"）。
function writeConfig(patch) {
  const cfg = Object.assign(readConfig(), patch)
  const tmp = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, CONFIG_FILE)
  for (const fn of configListeners) {
    try { fn(cfg) } catch (err) { console.warn('[dsh-pet] 配置监听器报错：' + ((err && err.message) || err)) }
  }
  return cfg
}

// 预设（单一来源）：读 pet-app/presets/*.json。读不到只降级不崩，但会打日志 ——
// 静默降级正是这个 fork 之前最难查的一类问题（台词变少 / 角色消失都不报错）。
//
// ⭐ 预设**按需缓存 + 支持热重载**：原先是模块顶层的 const（启动读一次），
//    改 presets/*.json 必须重启进程。现在改成带 mtime 的惰性读取，
//    文件没变就命中缓存（不重复读盘），变了就自动重读 —— 配合 /dsh-whale/reload，
//    改台词/角色/情绪素材都不再需要重启。
const ROLES_FALLBACK = [{ id: 'default', name: 'gpt娘', image: 'DSniang1.png', route: '/dsh-whale/image.png' }]
const presetCache = new Map() // name -> { mtimeMs, size, data }
function loadPreset(name, fallback, opts) {
  const force = !!(opts && opts.force)
  const abs = path.join(PRESETS, name)
  try {
    const st = fs.statSync(abs)
    const hit = presetCache.get(name)
    if (!force && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'))
    presetCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, data })
    if (hit && force) console.log('[dsh-pet] 预设已重载：' + name)
    return data
  } catch (err) {
    // 读失败时：若缓存里有上一次成功的值就继续用（比降级到 fallback 更安全）
    const hit = presetCache.get(name)
    if (hit) {
      console.warn('[dsh-pet] 预设 ' + name + ' 读取失败，沿用上一次成功的值：' + ((err && err.message) || err))
      return hit.data
    }
    console.warn('[dsh-pet] 预设 ' + name + ' 读取失败，使用内置降级值：' + ((err && err.message) || err))
    return fallback
  }
}

// 预设的"当前值"一律走这两个访问器（不要缓存成模块级常量，否则热重载失效）
function presetRoles() {
  const p = loadPreset('roles.json', { roles: ROLES_FALLBACK })
  return Array.isArray(p.roles) && p.roles.length ? p.roles : ROLES_FALLBACK
}
function defaultRoleId() {
  const rs = presetRoles()
  return rs[0].id
}
function presetBubbles() { return loadPreset('bubbles.json', {}) }
function presetWhaleDefaults() { return loadPreset('bubble-default-whale.json', null) }
/** presets/talk.json 的 talk 段（聊天选项 + 吃醋）。读不到就给空对象 → 功能自动关闭。 */
function presetTalk() {
  const p = loadPreset('talk.json', {})
  return (p && p.talk && typeof p.talk === 'object') ? p.talk : {}
}

// 热重载：清缓存后强制重读全部预设（文件缺失/写坏时 loadPreset 会沿用上次成功的值）
function clearPresetCache() { presetCache.clear() }
function reloadPresets() {
  clearPresetCache()
  const names = ['roles.json', 'bubbles.json', 'bubble-default-whale.json', 'talk.json']
  const out = {}
  for (const n of names) loadPreset(n, null, { force: true })
  out.roles = presetRoles().length
  out.bubbles = Object.keys(presetBubbles()).length
  out.whaleItems = (presetWhaleDefaults() || {}).count || 0
  out.talkOptions = (presetTalk().options || []).length
  console.log('[dsh-pet] 预设已热重载：角色 ' + out.roles + ' 个 / 泡泡池 ' + out.bubbles +
    ' 组 / 上游默认台词 ' + out.whaleItems + ' 项 / 聊天选项 ' + out.talkOptions + ' 条')
  // Codex 额度缓存也一并失效：改完预设/素材后重新探测一次，免得看到旧值
  codexPlanCache = { at: 0, windows: null, planType: '', sessions: 0 }
  return out
}

// —— 音效：预设组 duck → Ya1/Ya2，fx1 → D1/D2（与插件 assets 同源同名） ——
const SOUND_SETS = { duck: ['Ya1.mp3', 'Ya2.mp3'], fx1: ['D1.mp3', 'D2.mp3'] }

// —— Codex 额度：读 ~/.codex/sessions 的 rollout-*.jsonl，取最新 token_count.rate_limits 快照 ——
// 移植自上游 dsh-whale-widget 的 codexScan()/normalizeCodexRateLimits()（lib/index.js），
// 这里只需要额度窗口（5h / 周），不需要 token 统计，所以扫描策略简化为：
// 按 mtime 从新到旧逐个文件找第一个带 rate_limits 的快照（最新会话活动必带），上限 48 个文件。
// 角色清单的唯一来源是 pet-app/presets/roles.json（经 presetRoles() 读取，支持热重载）。
// ⚠️ 下面这个 id 在代码里有语义（配额口径走 DeepSeek 余额的那个角色），不只是展示名：
//    改 presets/roles.json 里的 id 时必须同步改这里。
const DEEPSEEK_ROLE_ID = 'whale'

const codexFileCache = new Map() // file -> { size, mtimeMs, rl, rlTs }
let codexPlanCache = { at: 0, windows: null, planType: '', sessions: 0 }

function currentRoleId() {
  const id = readConfig().role
  return presetRoles().some((r) => r.id === id) ? id : defaultRoleId()
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}
async function listCodexFiles(home) {
  const out = []
  async function walk(dir, depth) {
    let ents
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (err) { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (depth < 4) await walk(p, depth + 1) }
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p)
    }
  }
  await walk(path.join(home, 'sessions'), 0)
  await walk(path.join(home, 'archived_sessions'), 0)
  return out
}
function parseCodexRl(text) {
  let rl = null, rlTs = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue
    let o = null
    try { o = JSON.parse(line) } catch (err) { continue }
    const ts = Date.parse(String(o.timestamp || '')) || 0
    const p = o && o.payload ? o.payload : o
    const cand = p && typeof p.rate_limits === 'object' ? p.rate_limits : null
    if (cand && (cand.primary || cand.secondary || cand.plan_type || cand.credits) && ts >= rlTs) { rl = cand; rlTs = ts }
  }
  return { rl, rlTs }
}
function normalizeCodexWindow(w) {
  if (!w || typeof w !== 'object') return null
  const pick = (keys) => {
    for (const k of keys) {
      const raw = w[k]
      if (raw === null || raw === undefined || raw === '') continue
      const n = Number(raw)
      if (isFinite(n)) return n
    }
    return null
  }
  let usedPct = pick(['used_percent', 'usedPercent', 'percent', 'used_pct', 'usage_percent', 'usagePercent'])
  const remainPct = pick(['remaining_percent', 'remainingPercent', 'left_percent', 'remaining_pct'])
  if (usedPct === null && remainPct !== null) usedPct = Math.max(0, 100 - remainPct)
  let resetAt = null
  const secs = pick(['resets_in_seconds', 'resetsInSeconds', 'reset_after_seconds', 'reset_in_seconds', 'seconds_until_reset'])
  if (secs !== null && secs >= 0) resetAt = Date.now() + secs * 1000
  else {
    const abs = w.resets_at || w.reset_at || w.reset_time || w.next_reset || w.resetAt || w.nextResetTime
    if (typeof abs === 'number' && isFinite(abs)) resetAt = abs < 1e12 ? abs * 1000 : abs
    else if (typeof abs === 'string' && abs) { const t = Date.parse(abs); if (isFinite(t)) resetAt = t }
  }
  const windowMinutes = pick(['window_minutes', 'windowMinutes', 'window', 'period_minutes'])
  if (usedPct === null && resetAt === null) return null
  return { usedPct, resetAt, windowMinutes }
}
function winLabel(minutes) {
  const m = Number(minutes) || 0
  if (m >= 10080) return '月'
  if (m >= 1440) return Math.round(m / 1440) + '天'
  if (m >= 60) return Math.round(m / 60) + 'h'
  return m + '分钟'
}
async function codexPlan() {
  const now = Date.now()
  if (codexPlanCache.windows && now - codexPlanCache.at < 30000) return codexPlanCache
  if (!codexPlanCache._p) {
    codexPlanCache._p = (async () => {
      const home = codexHome()
      const files = await listCodexFiles(home)
      const stats = []
      for (const f of files) {
        try { const st = await fs.promises.stat(f); stats.push({ f, size: st.size, mtimeMs: st.mtimeMs }) } catch (err) {}
      }
      stats.sort((a, b) => b.mtimeMs - a.mtimeMs)
      let bestRl = null, bestTs = 0
      let budget = 48
      for (const s of stats) {
        if (budget-- <= 0 || s.size > 32 * 1024 * 1024) continue
        const prev = codexFileCache.get(s.f)
        let entry = (prev && prev.size === s.size && prev.mtimeMs === s.mtimeMs) ? prev : null
        if (!entry) {
          try {
            const text = await fs.promises.readFile(s.f, 'utf8')
            const r = parseCodexRl(text)
            entry = { size: s.size, mtimeMs: s.mtimeMs, rl: r.rl, rlTs: r.rlTs }
          } catch (err) { entry = { size: s.size, mtimeMs: s.mtimeMs, rl: null, rlTs: 0 } }
          codexFileCache.set(s.f, entry)
        }
        if (entry.rl && entry.rlTs >= bestTs) { bestRl = entry.rl; bestTs = entry.rlTs; break }
      }
      const windows = []
      if (bestRl) {
        const prim = normalizeCodexWindow(bestRl.primary)
        const sec = normalizeCodexWindow(bestRl.secondary)
        if (prim) windows.push({ key: 'rolling', label: prim.windowMinutes ? winLabel(prim.windowMinutes) : '5h', usedPct: prim.usedPct, resetAt: prim.resetAt })
        if (sec) windows.push({ key: 'weekly', label: '周', usedPct: sec.usedPct, resetAt: sec.resetAt })
      }
      codexPlanCache = { at: now, windows: windows.length ? windows : null, planType: bestRl && bestRl.plan_type ? String(bestRl.plan_type) : '', sessions: stats.length }
    })().finally(() => { codexPlanCache._p = null })
  }
  await codexPlanCache._p
  return codexPlanCache
}
function planPayload() {
  const c = codexPlanCache
  return {
    ok: !!c.windows,
    windows: c.windows || undefined,
    planType: c.planType || undefined,
    error: c.windows ? undefined : '未找到 Codex 额度快照（需要 ChatGPT 订阅 provider 的 Codex 会话日志）',
  }
}

// —— DeepSeek 余额（小鲸鱼角色的额度口径）：api.deepseek.com/user/balance，Key 在设置页填 ——
// dsMode 两种口径：'total' = 账户总额（充值+赠金）；'topup' = 仅充值余额（不含赠金）
let dsCache = { at: 0, data: null }
function fetchDsBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/user/balance',
      method: 'GET',
      timeout: 15000,
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (err) { reject(new Error('余额接口返回不是 JSON（HTTP ' + res.statusCode + '）')) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('余额接口超时')) })
    req.on('error', reject)
    req.end()
  })
}
async function dsBalance(force) {
  const cfg = readConfig()
  if (cfg.demo) return { ok: true, totalBalance: 366.64, currency: 'CNY', usageLabel: 'DeepSeek（演示）' }
  if (!cfg.dsKey) return { ok: false, code: 'NO_KEY', error: '未配置 DeepSeek API Key（托盘 → 设置）' }
  const age = Date.now() - dsCache.at
  if (!force && dsCache.data && age < 60 * 1000) return dsCache.data
  try {
    const raw = await fetchDsBalance(String(cfg.dsKey).trim())
    const infos = Array.isArray(raw && raw.balance_infos) ? raw.balance_infos : []
    if (!infos.length) return { ok: false, code: 'SHAPE', error: '余额接口没有返回 balance_infos' }
    const pick = infos.find((x) => x && x.currency === 'CNY') || infos[0]
    const mode = cfg.dsMode === 'topup' ? 'topup' : 'total'
    const data = {
      ok: true,
      totalBalance: Number(mode === 'topup' ? pick.topped_up_balance : pick.total_balance) || 0,
      currency: pick.currency || 'CNY',
      bonusBalance: isFinite(Number(pick.granted_balance)) ? Number(pick.granted_balance) : null,
      rechargeBalance: isFinite(Number(pick.topped_up_balance)) ? Number(pick.topped_up_balance) : null,
      usageLabel: mode === 'topup' ? 'DeepSeek 仅充值' : 'DeepSeek 账户',
      stale: raw.is_available === false,
    }
    dsCache = { at: Date.now(), data }
    return data
  } catch (err) {
    return { ok: false, code: 'FETCH', error: String((err && err.message) || err) }
  }
}

// —— 泡泡队列：按角色下发（台词单一来源：pet-app/presets/） ——
// gpt娘  ：presets/bubbles.json 的 gpt —— 第 1 泡 = Codex 额度 + 重置倒计时（无标题、单行小字号防溢出），
//          第 2 泡起 = 随机台词。台词按社区 GPT 娘人设维护（优等生、爱列点、过度道歉、
//          "作为一只语言模型"口癖，与 DeepSeek 娘的直率毒舌形成反差）。
// 小鲸鱼：气泡编辑器存过的 > presets/bubble-default-whale.json（构建期由
//          tools/extract-bubble-defaults.mjs 从上游前端 BUBBLE_DEFAULT_ITEMS 抽取）
//          > presets/bubbles.json 的 whaleFallback。
// 注意：这里刻意不在运行时长扫描上游前端源码 —— 上游一改写法就会静默降级成"台词变少"，
//       抽取已挪到构建期，并由 tools/verify-fork.mjs 断言同步。
// 两个预设都在读取时经 presetBubbles() / presetWhaleDefaults() 惰性加载，支持热重载。

function emptyQueue() { return { v: 1, tapAdvance: true, lib: [], items: [] } }

// 情绪素材的文件名前缀：角色 id → pet-app/assets/mood/<前缀>-{idle,angry}.png
// default（gpt娘）用 gpt 前缀，whale（小鲸鱼）用 whale 前缀。
// 没登记的角色返回 null，由调用方回退到角色图。
const MOOD_IMAGE_PREFIX = {
  default: 'gpt',
  whale: 'whale',
}
function moodImagePrefix(roleId) {
  return MOOD_IMAGE_PREFIX[roleId] || null
}

/**
 * 情绪台词泡泡：按**当前情绪**取 presets/bubbles.json 的台词池。
 * 不高兴期间点角色仍有反应（不装死），但只回这些台词，不再走正常的余额/额度队列。
 *
 * 台词池按角色分，且两种形状都要支持：
 *   · 生气：`gptAngry` / `whaleAngry` 是**按档位**分组的对象 `{"1":[...], "2":[...], "3":[...]}`
 *   · 吃醋/伤心：`gptJealous` / `gptSad`（以及 whale 对应两组）是**扁平数组**（这两种情绪没有档位）
 * 某个状态没有专属池时回落到同角色的生气池（按档位取），再取不到返回 null
 * —— 调用方会继续走正常队列，不会静默变哑巴。
 */
function moodQueue(mood) {
  const preset = presetBubbles()
  const whale = currentRoleId() === DEEPSEEK_ROLE_ID
  const state = (mood && MOOD_STATES.indexOf(mood.state) >= 0 && mood.state !== 'normal') ? mood.state : 'angry'
  const level = String((mood && mood.level) || 1)
  const pools = whale
    ? { angry: preset.whaleAngry, jealous: preset.whaleJealous, sad: preset.whaleSad }
    : { angry: preset.gptAngry, jealous: preset.gptJealous, sad: preset.gptSad }
  const pick = (p) => {
    if (Array.isArray(p)) return p
    if (p && typeof p === 'object') return p[level] || p['1'] || null
    return null
  }
  let pool = pick(pools[state])
  if ((!Array.isArray(pool) || !pool.length) && state !== 'angry') pool = pick(pools.angry)
  if (!Array.isArray(pool) || !pool.length) return null
  return {
    v: 1,
    tapAdvance: false,
    lib: [],
    items: [
      {
        kind: 'custom',
        modules: [
          {
            type: 'random',
            lines: pool.map((l) => ({ t: l.t, w: Number(l.w) || 8, bold: true, size: 11 })),
          },
        ],
      },
    ],
  }
}

function bubblePayloadInner() {
  const role = currentRoleId()
  const cfg = readConfig()
  const preset = presetBubbles()
  // 不高兴优先：生气/吃醋/伤心期间只回对应情绪的台词（吃醋/伤心没有专属池时回落到生气池）
  const mood = currentMood()
  if (mood.state !== 'normal') {
    const q = moodQueue(mood)
    if (q) return { ok: true, source: mood.state === 'angry' ? 'angry' : mood.state, config: q, mood }
  }
  if (role === DEEPSEEK_ROLE_ID) {
    if (cfg.bubbleWhale) return { ok: true, source: 'stored', config: cfg.bubbleWhale }
    const whaleDefaults = presetWhaleDefaults()
    const official = whaleDefaults && Array.isArray(whaleDefaults.items) ? whaleDefaults.items : null
    if (official && official.length) {
      return { ok: true, source: 'upstream-extracted', config: { v: 1, tapAdvance: true, lib: [], items: official } }
    }
    if (preset.whaleFallback) {
      return { ok: true, source: 'preset-fallback', config: preset.whaleFallback }
    }
    return { ok: true, source: 'empty', config: emptyQueue() }
  }
  if (cfg.bubbleGpt) return { ok: true, source: 'stored', config: cfg.bubbleGpt }
  if (preset.gpt) return { ok: true, source: 'preset', config: preset.gpt }
  return { ok: true, source: 'empty', config: emptyQueue() }
}

// 主动说话（idle chatter）配置：顶层字段，**不进 config** ——
// config 会被气泡编辑器原样保存回存档（bubbleGpt/bubbleWhale），chatter 属于
// presets 的出厂配置，混进去会被用户存档固化、之后改 presets 就不生效了。
function bubblePayload() {
  const base = bubblePayloadInner()
  const ch = presetBubbles().chatter
  if (ch && typeof ch === 'object') {
    base.chatter = {
      enabled: ch.enabled !== false,
      everyMin: Number(ch.everyMin) > 0 ? Number(ch.everyMin) : 4,
      everyMax: Number(ch.everyMax) > 0 ? Number(ch.everyMax) : 9,
      lines: Array.isArray(ch.lines) ? ch.lines : [],
    }
    if (base.chatter.everyMax < base.chatter.everyMin) base.chatter.everyMax = base.chatter.everyMin
  }
  // 聊天选项 + 吃醋：同样走**顶层字段、不进 config**（理由同 chatter）。
  // 这里只下发"要不要开、隔多久、给几个、现在走预设还是 LLM"，选项正文在 open 时才取
  // （见 /dsh-whale/talk.json）—— 省得每次拿泡泡配置都搬一遍选项池。
  const tk = talkSpec()
  const cfgLlm = llmConfig()
  base.talk = {
    enabled: !!(tk && tk.enabled !== false && Object.keys(tk).length),
    idleMin: Number(tk.idleMin) > 0 ? Number(tk.idleMin) : 5,
    optionCount: Math.max(1, Math.min(5, Number(tk.optionCount) || 3)),
    answerTimeoutMs: Number(tk.answerTimeoutMs) > 0 ? Number(tk.answerTimeoutMs) : 90000,
    angryRepeatMin: Number(tk.angryRepeatMin) > 0 ? Number(tk.angryRepeatMin) : 3,
    // "正在想"那句：接了 LLM 时要等回包，先垫一句避免干等
    pending: ((tk.opening && Array.isArray(tk.opening.pending)) ? tk.opening.pending : [])
      .map((l) => ({ t: String(l.t || ''), w: Number(l.w) || 8 })),
    mode: cfgLlm ? 'llm' : 'preset',
  }
  return base
}

// ===== 聊天选项 + 吃醋（fork 定制）=====
// 契约（前端只认这三条）：
//   GET  /dsh-whale/talk.json                          → 规格 + 当前情绪（诊断 / 设置页 / 前端兜底）
//   POST /dsh-whale/talk.json {action:'open'}          → { token, opening, options, source }
//   POST /dsh-whale/talk.json {action:'choose', ...}   → { reaction, jealous, mood, lines, action, source }
//
// 两个设计决定：
//   ① 选项池、开场白、反应文案、人设提示词的**唯一来源**是 presets/talk.json；
//      config.json 的 talk 只放用户在本机改过的覆盖项（enabled / idleMin）。
//   ② LLM 是**可选后端**：没配 / 超时 / HTTP 非 2xx / 返回不合法 JSON / 形状不对，
//      一律静默回落预设（只在 console 留一行 warn，并把 source 标成 'preset'）。
//      ⇒ 功能永远可用，接了 LLM 只是"每次选项都不一样"。
let talkRecent = []   // 最近出现过的选项 id（环，长度 = spec.noRepeat）
let talkLastSet = []  // 上一轮抽出的 id（排序），用来保证"每轮都不一样"
let talkOpen = null   // { token, mood, options, at, source }

/** 出厂规格（presets/talk.json 的 talk 段）+ 本机覆盖项（config.talk）。 */
function talkSpec() {
  const spec = Object.assign({}, presetTalk())
  const c = readConfig().talk
  if (c && typeof c === 'object') {
    for (const k of ['enabled', 'idleMin', 'optionCount', 'noRepeat', 'angryRepeatMin',
      'answerTimeoutMs', 'maxOptionChars', 'maxLineChars', 'maxLines']) {
      if (c[k] !== undefined) spec[k] = c[k]
    }
  }
  return spec
}

function talkFill(tpl, map) {
  return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? String(map[k]) : m))
}

/** 你选的那句话里有没有别的 AI 娘的名字（大小写无关的子串匹配）。命中返回命中的别名。 */
function talkRivalHit(text, rivals) {
  const t = String(text || '').toLowerCase()
  if (!t) return null
  const list = Array.isArray(rivals) ? rivals : []
  for (const r of list) {
    const k = String(r || '').trim().toLowerCase()
    if (k && t.indexOf(k) >= 0) return String(r)
  }
  return null
}

// 加权随机（无放回）：Efraimidis–Spirakis，key = U^(1/w) 取最大。
// 选项没写 w 就按 8（等价均匀），跟 bubbles.json 里台词权重的口吻一致。
function talkWeightedShuffle(list) {
  return list
    .map((o) => ({ o: o, k: Math.pow(Math.random(), 1 / Math.max(0.0001, Number(o.w) || 8)) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.o)
}

/** 抽 optionCount 条：先按当前情绪过滤 when，再避开最近 noRepeat 条，且不与上一轮完全相同。 */
function talkPick(spec, mood) {
  const n = Math.max(1, Math.min(5, Number(spec.optionCount) || 3))
  const all = Array.isArray(spec.options) ? spec.options.filter((o) => o && o.id && o.t) : []
  const state = (mood && mood.state) || 'normal'
  const elig = all.filter((o) => !o.when || o.when === 'any' || o.when === state)
  if (elig.length < n) return []
  let picked = []
  for (let attempt = 0; attempt < 5; attempt++) {
    const fresh = elig.filter((o) => talkRecent.indexOf(o.id) < 0)
    const src = fresh.length >= n ? fresh : elig
    picked = talkWeightedShuffle(src).slice(0, n)
    const ids = picked.map((o) => o.id).sort()
    if (talkLastSet.join(',') !== ids.join(',')) break
  }
  return picked
}

function talkRemember(spec, ids) {
  const cap = Math.max(3, Number(spec.noRepeat) || 8)
  for (const id of ids) {
    talkRecent = talkRecent.filter((x) => x !== id)
    talkRecent.push(id)
  }
  while (talkRecent.length > cap) talkRecent.shift()
}

/** 开场白：优先当前情绪那组，**只取 1 句** —— 泡泡文本框只有 677u×448u，选项行要占掉大半。 */
function talkOpening(spec, mood) {
  const op = (spec.opening && typeof spec.opening === 'object') ? spec.opening : {}
  const state = (mood && mood.state) || 'normal'
  let pool = Array.isArray(op[state]) ? op[state] : []
  if (!pool.length) pool = [].concat(op.normal || [], op.angry || [])
  if (!pool.length) return []
  return talkWeightedShuffle(pool).slice(0, 1).map((l) => ({ t: String(l.t || ''), w: Number(l.w) || 8 }))
}

// —— 可选 LLM 后端（OpenAI 兼容 /chat/completions；零依赖，照 fetchDsBalance 的写法）——
function normalizeLlm(c) {
  if (!c || c.enabled !== true) return null
  const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '')
  const model = String(c.model || '').trim()
  const apiKey = String(c.apiKey || '').trim()
  if (!baseUrl || !model || !apiKey) return null
  let u
  try { u = new URL(baseUrl) } catch (err) { return null }
  // 只允许 http/https：别让用户把 file:/ftp: 之类塞进来当"提供商地址"
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const timeoutMs = Math.max(1000, Math.min(60000, Number(c.timeoutMs) || 8000))
  return { baseUrl: baseUrl, model: model, apiKey: apiKey, timeoutMs: timeoutMs }
}
function llmConfig() { return normalizeLlm(readConfig().llm) }

/** 发一次 chat/completions。**永不 reject**：失败返回 null，调用方回落预设。 */
function llmChat(cfg, messages) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(cfg.baseUrl + '/chat/completions') } catch (err) { return resolve(null) }
    const mod = u.protocol === 'https:' ? https : http
    const payload = JSON.stringify({
      model: cfg.model,
      messages: messages,
      temperature: 0.9,
      max_tokens: 400,
      stream: false,
    })
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: cfg.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: 'Bearer ' + cfg.apiKey,
        Accept: 'application/json',
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy() })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.warn('[dsh-pet] LLM 返回 HTTP ' + res.statusCode + '，聊天选项回落到预设')
          return resolve(null)
        }
        resolve(body)
      })
    })
    req.on('timeout', () => req.destroy(new Error('LLM 请求超时')))
    req.on('error', (err) => {
      console.warn('[dsh-pet] LLM 请求失败（聊天选项回落到预设）：' + ((err && err.message) || err))
      resolve(null)
    })
    req.write(payload)
    req.end()
  })
}

/** 从模型回复里抠出 JSON 对象（容忍 ```json 围栏与前后废话）。抠不出返回 null。 */
function llmJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let text = raw
  try {
    const d = JSON.parse(raw)
    const ch = d && Array.isArray(d.choices) ? d.choices[0] : null
    const msg = ch && (ch.message || ch.delta)
    if (msg && typeof msg.content === 'string') text = msg.content
  } catch (err) { /* 不是 OpenAI 响应体：按纯文本处理 */ }
  text = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(text.slice(a, b + 1)) } catch (err) { return null }
}

/** 让 LLM 生成一组选项。形状不合法（数量/长度/重复）就整体作废 → 回落预设。 */
async function talkLlmOptions(spec, mood, cfg) {
  const p = (spec.llmPrompt && typeof spec.llmPrompt === 'object') ? spec.llmPrompt : {}
  if (!String(p.open || '').trim()) return null
  const n = Math.max(1, Math.min(5, Number(spec.optionCount) || 3))
  const maxChars = Math.max(6, Number(spec.maxOptionChars) || 40)
  const raw = await llmChat(cfg, [
    { role: 'system', content: String(p.system || '') },
    {
      role: 'user',
      content: talkFill(p.open, {
        mood: MOOD_LABEL[mood.state] || mood.state,
        n: n,
        maxChars: maxChars,
        rivals: (Array.isArray(spec.rivals) ? spec.rivals : []).slice(0, 8).join('、'),
      }),
    },
  ])
  const obj = llmJson(raw)
  if (!obj || !Array.isArray(obj.options)) return null
  const options = []
  for (const v of obj.options) {
    const t = String(v == null ? '' : v).trim()
    if (!t || t.length > maxChars) continue
    if (options.some((x) => x.t === t)) continue
    options.push({ id: 'llm' + (options.length + 1), t: t, reaction: '', lines: null })
    if (options.length >= n) break
  }
  if (options.length < n) return null
  const opening = (typeof obj.opening === 'string' && obj.opening.trim())
    ? [{ t: obj.opening.trim().slice(0, maxChars * 2), w: 10 }]
    : null
  return { options: options, opening: opening }
}

/** 让 LLM 定一次反应语气与台词。reaction 必须是五个合法值之一，否则作废。 */
async function talkLlmReaction(spec, mood, cfg, text) {
  const p = (spec.llmPrompt && typeof spec.llmPrompt === 'object') ? spec.llmPrompt : {}
  if (!String(p.react || '').trim()) return null
  const maxChars = Math.max(6, Number(spec.maxLineChars) || 60)
  const maxLines = Math.max(1, Math.min(6, Number(spec.maxLines) || 4))
  const raw = await llmChat(cfg, [
    { role: 'system', content: String(p.system || '') },
    {
      role: 'user',
      content: talkFill(p.react, {
        mood: MOOD_LABEL[mood.state] || mood.state,
        option: text,
        maxChars: maxChars,
        maxLines: maxLines,
      }),
    },
  ])
  const obj = llmJson(raw)
  if (!obj) return null
  const reaction = String(obj.reaction || '').trim()
  if (!REACTION_MOOD[reaction]) return null
  const lines = []
  for (const v of (Array.isArray(obj.lines) ? obj.lines : [])) {
    const t = String(v == null ? '' : v).trim()
    if (!t || t.length > maxChars) continue
    lines.push({ t: t, w: 10 })
    if (lines.length >= maxLines) break
  }
  return { reaction: reaction, lines: lines.length ? lines : null }
}

/** open：抽选项（必要时让 LLM 生成）+ 开场白，并把本轮锁进 talkOpen（token 一次性）。 */
async function talkOpenPayload(spec, mood) {
  const picked = talkPick(spec, mood)
  if (!picked.length) return null
  const token = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  let options = picked.map((o) => ({
    id: o.id,
    t: String(o.t),
    reaction: REACTION_MOOD[o.reaction] ? o.reaction : '',
    lines: Array.isArray(o.lines) && o.lines.length ? o.lines : null,
    mentionsOther: o.mentionsOther === true,
  }))
  let opening = talkOpening(spec, mood)
  let source = 'preset'
  const cfg = llmConfig()
  if (cfg) {
    const r = await talkLlmOptions(spec, mood, cfg)
    if (r) {
      source = 'llm'
      options = r.options
      if (r.opening) opening = r.opening
    }
  }
  if (!options.length) return null
  const fill = { idle: Number(spec.idleMin) > 0 ? Number(spec.idleMin) : 5 }
  opening = opening.map((l) => ({ t: talkFill(l.t, fill), w: l.w }))
  // 只有预设 id 进"最近出现"环（LLM 选项每次本来就不一样，占环只会挤掉预设的名额）
  talkRemember(spec, options.map((o) => o.id).filter((id) => String(id).indexOf('llm') !== 0))
  talkLastSet = options.map((o) => String(o.id)).sort()
  talkOpen = { token: token, mood: { state: mood.state, level: mood.level }, options: options, at: Date.now(), source: source }
  return {
    ok: true,
    token: token,
    source: source,
    opening: opening,
    options: options.map((o) => ({ id: o.id, t: o.t })),
    mood: currentMood(),
  }
}

/**
 * choose：定反应 + 落情绪。
 * 判定顺序（见 presets/talk.json 的 _说明）：
 *   ① 你选的话命中 rivals（夸了/提到了别的 AI 娘）→ jealous（覆盖一切）
 *   ② 选项自带 mentionsOther → jealous
 *   ③ 选项自带的 reaction（预设）→ 用它
 *   ④ 以上都没有（LLM 生成的选项）→ 问 LLM；LLM 不可用则"以牙还牙"用当前情绪，最后兜 serious
 * cause='ignored'（点掉泡泡 / 90 秒不理）→ sad。
 */
async function talkResolve(spec, mood, option, cause) {
  const ignored = !option || cause === 'ignored'
  let reaction = ''
  let lines = null
  let source = 'preset'
  let rival = null
  if (ignored) {
    // 点掉泡泡 / 90 秒不理她 = 被无视 → 伤心（**注意这里也要落情绪**，否则界面上看着伤心、
    // 配置里还停在上一个状态，重启后变回原样 —— 实测踩过）
    reaction = 'sad'
  } else {
    rival = talkRivalHit(option.t, spec.rivals)
    reaction = rival ? 'jealous' : (option.mentionsOther ? 'jealous' : (REACTION_MOOD[option.reaction] ? option.reaction : ''))
    lines = Array.isArray(option.lines) && option.lines.length ? option.lines : null
    const cfg = llmConfig()
    if (cfg && (!reaction || !lines)) {
      const r = await talkLlmReaction(spec, mood, cfg, option.t)
      if (r) {
        source = 'llm'
        if (!reaction) reaction = r.reaction
        if (!lines && r.lines) lines = r.lines
      }
    }
  }
  if (!reaction) reaction = REACTION_MOOD[mood.state] ? mood.state : 'serious'
  if (!lines) {
    const rl = (spec.reactions && spec.reactions[reaction]) || {}
    lines = Array.isArray(rl.lines) && rl.lines.length ? rl.lines : null
  }
  const rr = (spec.reactions && spec.reactions[reaction]) || {}
  const holdMs = rr.holdMs !== undefined ? Number(rr.holdMs) : (REACTION_HOLD_DEFAULT[reaction] || 0)
  const action = rr.action || REACTION_ACTION_DEFAULT[reaction] || 'jump'
  const next = setMoodState(REACTION_MOOD[reaction] || 'normal', holdMs, {
    reason: 'talk:' + reaction + (rival ? '(rival:' + rival + ')' : (ignored ? '(ignored)' : '')),
  })
  return {
    reaction: reaction,
    jealous: reaction === 'jealous',
    source: source,
    rival: rival,
    optionId: option ? option.id : null,
    text: option ? option.t : null,
    lines: lines,
    action: action,
    mood: next,
  }
}

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
  res.end(buf)
}
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found')
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
  })
}
function readBody(req, cb) {
  let body = ''
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
  req.on('end', () => cb(body))
}

function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = u.pathname

  if (p === '/' || p === '/index.html') return sendFile(res, path.join(PUBLIC, 'index.html'))
  if (p === '/config' && req.method === 'GET') return sendFile(res, path.join(PUBLIC, 'config.html'))
  if (p === '/config' && req.method === 'POST') {
    return readBody(req, (body) => {
      let patch = {}
      try { patch = JSON.parse(body) } catch (err) { return send(res, 400, '{"ok":false}', MIME['.json']) }
      const out = {}
      if (typeof patch.demo === 'boolean') out.demo = patch.demo
      if (typeof patch.dsKey === 'string') out.dsKey = patch.dsKey.trim()
      if (patch.dsMode === 'total' || patch.dsMode === 'topup') out.dsMode = patch.dsMode
      if (typeof patch.autostart === 'boolean') out.autostart = patch.autostart
      // 聊天选项：只收"用户覆盖项"，选项池本体在 presets/talk.json
      const curCfg = readConfig()
      if (patch.talk && typeof patch.talk === 'object' && !Array.isArray(patch.talk)) {
        const cur = (curCfg.talk && typeof curCfg.talk === 'object') ? curCfg.talk : {}
        const next = Object.assign({}, cur)
        if (typeof patch.talk.enabled === 'boolean') next.enabled = patch.talk.enabled
        const im = Number(patch.talk.idleMin)
        if (isFinite(im) && im >= 1) next.idleMin = Math.min(120, Math.round(im))
        out.talk = next
      }
      // 自定义 LLM：apiKey 采用"留空=不改、null=清空"的写法，**不回显明文**
      if (patch.llm && typeof patch.llm === 'object' && !Array.isArray(patch.llm)) {
        const cur = (curCfg.llm && typeof curCfg.llm === 'object') ? curCfg.llm : {}
        const next = Object.assign({}, cur)
        if (typeof patch.llm.enabled === 'boolean') next.enabled = patch.llm.enabled
        if (typeof patch.llm.baseUrl === 'string') next.baseUrl = patch.llm.baseUrl.trim()
        if (typeof patch.llm.model === 'string') next.model = patch.llm.model.trim()
        if (patch.llm.apiKey === null) next.apiKey = ''
        else if (typeof patch.llm.apiKey === 'string' && patch.llm.apiKey.trim()) next.apiKey = patch.llm.apiKey.trim()
        const ms = Number(patch.llm.timeoutMs)
        if (isFinite(ms) && ms > 0) next.timeoutMs = Math.max(1000, Math.min(60000, Math.round(ms)))
        out.llm = next
      }
      const cfg = writeConfig(out)
      dsCache = { at: 0, data: null }
      send(res, 200, JSON.stringify({ ok: true, autostart: cfg.autostart === true }), MIME['.json'])
    })
  }

  if (p === '/pet-config.json') {
    const cfg = readConfig()
    const LlmRaw = (cfg.llm && typeof cfg.llm === 'object') ? cfg.llm : {}
    const TalkRaw = (cfg.talk && typeof cfg.talk === 'object') ? cfg.talk : {}
    const spec = talkSpec()
    return send(res, 200, JSON.stringify({
      demo: cfg.demo === true,
      dsKey: cfg.dsKey || '',
      dsMode: cfg.dsMode === 'topup' ? 'topup' : 'total',
      autostart: cfg.autostart === true,
      // 聊天选项：出厂默认来自 presets/talk.json，这里是"本机是否覆盖过 / 现在生效的值"
      talk: {
        enabled: spec.enabled !== false,
        idleMin: Number(spec.idleMin) > 0 ? Number(spec.idleMin) : 5,
        optionCount: Math.max(1, Math.min(5, Number(spec.optionCount) || 3)),
        overridden: Object.keys(TalkRaw).length > 0,
      },
      // 自定义 LLM：**绝不回显明文 Key**，只告诉设置页"有没有存过"
      llm: {
        enabled: LlmRaw.enabled === true,
        baseUrl: String(LlmRaw.baseUrl || ''),
        model: String(LlmRaw.model || ''),
        hasKey: !!String(LlmRaw.apiKey || '').trim(),
        timeoutMs: Number(LlmRaw.timeoutMs) || 8000,
        ready: !!normalizeLlm(LlmRaw),
      },
    }), MIME['.json'])
  }

  // —— 一键导出 / 导入（备份、换机、迁移） ——
  // 导出 GET /pet-backup.json[?includeKey=1]：默认不含 API Key，避免"随手分享备份"泄露凭据。
  // 导入 POST /pet-restore，body 为导出内容本身或 { backup: <导出内容> }。
  // 两侧都只认 CONFIG_KEYS 白名单，未知字段一律忽略。
  if (p === '/pet-backup.json' && req.method === 'GET') {
    const cfg = readConfig()
    const includeKey = u.searchParams.get('includeKey') === '1'
    const backup = {
      app: 'dsh-pet-desktop',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      includesKey: includeKey,
      config: {},
    }
    for (const k of CONFIG_KEYS) {
      if (k === 'dsKey') {
        if (includeKey && cfg.dsKey) backup.secret = Object.assign(backup.secret || {}, { dsKey: cfg.dsKey })
        continue
      }
      if (k === 'llm') {
        // 自定义 LLM 配置里含**明文 API Key**：默认整体剔除 apiKey，勾了 includeKey 才进 secret。
        // 与 dsKey 同规则 —— "随手分享备份"不该顺带泄露凭据。
        const L = (cfg.llm && typeof cfg.llm === 'object') ? Object.assign({}, cfg.llm) : null
        if (L) {
          const key = String(L.apiKey || '')
          delete L.apiKey
          backup.config.llm = L
          if (includeKey && key) backup.secret = Object.assign(backup.secret || {}, { llm: { apiKey: key } })
        }
        continue
      }
      if (cfg[k] !== undefined) backup.config[k] = cfg[k]
    }
    const body = JSON.stringify(backup, null, 2)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="dsh-pet-backup.json"',
    })
    return res.end(body)
  }
  if (p === '/pet-restore' && req.method === 'POST') {
    return readBody(req, (body) => {
      let parsed = null
      try {
        parsed = JSON.parse(body || '{}')
      } catch (err) {
        return send(res, 400, '{"ok":false,"error":"body 不是合法 JSON"}', MIME['.json'])
      }
      const backup = parsed && parsed.backup && typeof parsed.backup === 'object' ? parsed.backup : parsed
      if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
        return send(res, 400, '{"ok":false,"error":"缺少 backup 内容"}', MIME['.json'])
      }
      const src = backup.config && typeof backup.config === 'object' ? backup.config : {}
      const patch = {}
      const applied = []
      for (const k of CONFIG_KEYS) {
        if (k === 'dsKey' || src[k] === undefined) continue
        if ((k === 'demo' || k === 'autostart') && typeof src[k] !== 'boolean') continue
        if (k === 'dsMode' && src[k] !== 'total' && src[k] !== 'topup') continue
        if (k === 'role' && !presetRoles().some((r) => r.id === src[k])) continue
        if ((k === 'widget' || k === 'bubbleGpt' || k === 'bubbleWhale') &&
          (!src[k] || typeof src[k] !== 'object' || Array.isArray(src[k]))) continue
        // mood 也允许随备份走：换机后"继续生气"能还原（until 是绝对时间戳，过期即自动消气）
        if (k === 'mood' && (!src[k] || typeof src[k] !== 'object' || Array.isArray(src[k]))) continue
        if (k === 'talk' && (!src[k] || typeof src[k] !== 'object' || Array.isArray(src[k]))) continue
        // llm 单独处理：它可能带 apiKey，不跟着 config 循环无条件落盘
        if (k === 'llm') continue
        patch[k] = src[k]
        applied.push(k)
      }
      if (backup.secret && typeof backup.secret.dsKey === 'string' && backup.secret.dsKey.trim()) {
        patch.dsKey = backup.secret.dsKey.trim()
        applied.push('dsKey')
      }
      // 自定义 LLM：config 部分（不含 Key）照常还原；Key 只从 secret 里取
      if (src.llm && typeof src.llm === 'object' && !Array.isArray(src.llm)) {
        const prev = (readConfig().llm && typeof readConfig().llm === 'object') ? readConfig().llm : {}
        patch.llm = Object.assign({}, prev, src.llm)
        applied.push('llm')
      }
      if (backup.secret && backup.secret.llm && typeof backup.secret.llm.apiKey === 'string' && backup.secret.llm.apiKey.trim()) {
        patch.llm = Object.assign({}, patch.llm || readConfig().llm || {}, { apiKey: backup.secret.llm.apiKey.trim() })
        if (applied.indexOf('llm') < 0) applied.push('llm')
      }
      if (!applied.length) {
        return send(res, 400, '{"ok":false,"error":"备份里没有可应用的字段"}', MIME['.json'])
      }
      writeConfig(patch)
      dsCache = { at: 0, data: null }
      send(res, 200, JSON.stringify({ ok: true, applied }), MIME['.json'])
    })
  }

  if (p === '/dsh-whale/widget.js') return sendFile(res, path.join(ASSETS, 'whale-widget.js'))
  if (p === '/dsh-whale/image.png') {
    // 默认角色图取自 presets/roles.json（单一来源）；文件缺失时兼容旧文件名
    const rs = presetRoles()
    const def = rs.find((r) => r.id === defaultRoleId()) || rs[0]
    const candidates = [def && def.image, 'DSniang1.png', 'DSniang02.png'].filter(Boolean)
    const hit = candidates.map((f) => path.join(ASSETS, String(f))).find((f) => fs.existsSync(f))
    return hit ? sendFile(res, hit) : send(res, 404, 'image missing')
  }
  // —— 小鲸鱼：测试 DeepSeek Key（设置页「测试连接」用）——
  // 与 /dsh-whale/balance.json 的区别：强制绕过缓存、不改角色、把原始字段一并回给设置页，
  // 便于对照「接口返回了什么」与「界面显示了什么」。传入 key 时用传入值（未保存也能试）。
  if (p === '/pet-test-ds' && req.method === 'POST') {
    return readBody(req, (body) => {
      let raw = ''
      try { const b = JSON.parse(body || '{}'); raw = typeof b.dsKey === 'string' ? b.dsKey.trim() : '' } catch (err) {}
      const key = raw || String(readConfig().dsKey || '').trim()
      if (!key) {
        return send(res, 200, JSON.stringify({ ok: false, code: 'NO_KEY', error: '还没有填 DeepSeek API Key' }), MIME['.json'])
      }
      fetchDsBalance(key).then((data) => {
        const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
        if (!infos.length) {
          return send(res, 200, JSON.stringify({
            ok: false, code: 'SHAPE',
            error: '接口没有返回 balance_infos（Key 可能无效，或账号没有余额钱包）',
            raw: JSON.stringify(data).slice(0, 400),
          }), MIME['.json'])
        }
        const pick = infos.find((x) => x && x.currency === 'CNY') || infos[0]
        send(res, 200, JSON.stringify({
          ok: true,
          currency: pick.currency || 'CNY',
          totalBalance: Number(pick.total_balance),
          toppedUpBalance: Number(pick.topped_up_balance),
          grantedBalance: Number(pick.granted_balance),
          isAvailable: data && data.is_available !== false,
          wallets: infos.map((x) => ({ currency: x.currency, total: x.total_balance, toppedUp: x.topped_up_balance, granted: x.granted_balance })),
        }), MIME['.json'])
      }).catch((err) => {
        send(res, 200, JSON.stringify({ ok: false, code: 'FETCH', error: String((err && err.message) || err).slice(0, 300) }), MIME['.json'])
      })
    })
  }

  // —— 自定义 LLM：测试连接（设置页用）——
  // 与 /pet-test-ds 同思路：用**输入框里的值优先、留空则用已保存的**真发一次请求，
  // 把"配好了没 / 端点通不通 / 返回能不能用"直接显示出来，不用先保存。
  // 只回生成结果与错误码，不回显 Key。
  if (p === '/pet-test-llm' && req.method === 'POST') {
    return readBody(req, (body) => {
      let patch = {}
      try { patch = JSON.parse(body || '{}') || {} } catch (err) {}
      const saved = (readConfig().llm && typeof readConfig().llm === 'object') ? readConfig().llm : {}
      const merged = Object.assign({}, saved, { enabled: true })
      if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) merged.baseUrl = patch.baseUrl.trim()
      if (typeof patch.model === 'string' && patch.model.trim()) merged.model = patch.model.trim()
      if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) merged.apiKey = patch.apiKey.trim()
      const cfg = normalizeLlm(merged)
      if (!cfg) {
        return send(res, 200, JSON.stringify({
          ok: false, code: 'NO_LLM',
          error: '还没配齐：baseUrl / 模型名 / API Key 三项都要有（地址必须是 http/https）',
        }), MIME['.json'])
      }
      const spec = talkSpec()
      talkLlmOptions(spec, currentMood(), cfg).then((r) => {
        if (!r) {
          return send(res, 200, JSON.stringify({
            ok: false, code: 'LLM_FAIL',
            error: '调用失败，或返回不符合格式（已自动回落预设）。检查 baseUrl / 模型名 / Key 是否正确',
            model: cfg.model,
          }), MIME['.json'])
        }
        send(res, 200, JSON.stringify({
          ok: true, model: cfg.model, opening: r.opening, options: r.options.map((x) => x.t),
        }), MIME['.json'])
      }).catch((err) => {
        send(res, 200, JSON.stringify({
          ok: false, code: 'LLM_FATAL', error: String((err && err.message) || err).slice(0, 300),
        }), MIME['.json'])
      })
    })
  }

  // —— 热重载 ——
  // GET /dsh-whale/reload：清预设缓存并强制重读（前端发现文件变化时自动调；也可手动调）
  // 返回各预设的条目数，便于确认"到底重载到了什么"。纯读操作，不改任何用户配置。
  if (p === '/dsh-whale/reload') {
    let result = null
    try {
      result = reloadPresets()
    } catch (err) {
      return send(res, 500, JSON.stringify({ ok: false, error: String((err && err.message) || err) }), MIME['.json'])
    }
    return send(res, 200, JSON.stringify({ ok: true, reloadedAt: Date.now(), presets: result }), MIME['.json'])
  }

  if (p === '/dsh-whale/rua.gif') return sendFile(res, path.join(ASSETS, 'rua.gif'))

  // —— 情绪系统 ——
  // GET  /dsh-whale/mood.json       读**当前角色**的情绪（前端初始化/消气判断/交互锁）
  // POST /dsh-whale/mood.json       记一次点击 {"click":true}；越阈值则升级并在响应里告知
  // GET  /dsh-whale/mood-image.png  当前情绪对应的角色图（不高兴 → mood/<态>.png，其余 → 角色图）
  // 响应里的 lockUntil = 交互锁（她背过身去的时段，前端据此对点她/拖她装聋）；
  // hideUntil 是给**其他**角色的（角色面板用），当前角色永远不隐藏，一并回显无妨。
  if (p === '/dsh-whale/mood.json') {
    if (req.method === 'POST') {
      return readBody(req, (body) => {
        let click = false
        try { click = JSON.parse(body || '{}').click === true } catch (err) {}
        const mood = click ? recordMoodClick() : currentMood()
        const buf = moodClicks[currentRoleId()] || []
        send(res, 200, JSON.stringify(Object.assign({ ok: true }, mood, {
          clicks: buf.length,
          tier: moodTierFor(buf.length) ? moodTierFor(buf.length).min : 0,
        })), MIME['.json'])
      })
    }
    expireMoodIfNeeded()
    const buf0 = moodClicks[currentRoleId()] || []
    return send(res, 200, JSON.stringify(Object.assign({ ok: true }, currentMood(), {
      clicks: buf0.length,
      thresholds: MOOD_TIERS.map((t) => t.min),
    })), MIME['.json'])
  }
  if (p === '/dsh-whale/mood-image.png') {
    // 情绪素材按角色成套：gpt娘 → gpt-{idle,angry,jealous,sad}.png，小鲸鱼 → whale-*.png。
    // 文件名前缀就是 presets/roles.json 里的角色 id（default 用 gpt 前缀，与生成脚本的 --prefix 对应）。
    // 取图走**回落链**：state → 该 state 的借用目标（如未来某角色没做吃醋素材 → 借生气）→ idle → 角色图。
    // 两位在场角色的四态素材都已齐全；回落链留给以后新增角色（可以只做 idle/angry 两态就上线）。
    const mood = currentMood()
    const prefix = moodImagePrefix(currentRoleId())
    const chain = []
    const want = mood.state === 'normal' ? 'idle' : mood.state
    chain.push(want)
    if (MOOD_STATE_FALLBACK[want]) chain.push(MOOD_STATE_FALLBACK[want])
    if (chain.indexOf('idle') < 0) chain.push('idle')
    for (const s of chain) {
      const f = path.join(ASSETS, 'mood', prefix + '-' + s + '.png')
      if (fs.existsSync(f)) return sendFile(res, f)
    }
    // 该角色没有成套素材 → 回退到它的角色图（等价于"永远待机"，不会 404）
    const role = presetRoles().find((r) => r.id === currentRoleId())
    if (role && role.image && fs.existsSync(path.join(ASSETS, String(role.image)))) {
      return sendFile(res, path.join(ASSETS, String(role.image)))
    }
    const rs = presetRoles()
    const def = rs.find((r) => r.id === defaultRoleId()) || rs[0]
    const candidates = [def && def.image, 'DSniang1.png', 'DSniang02.png'].filter(Boolean)
    const hit = candidates.map((x) => path.join(ASSETS, String(x))).find((x) => fs.existsSync(x))
    return hit ? sendFile(res, hit) : send(res, 404, 'image missing')
  }

  // —— 聊天选项 + 吃醋（桌宠端；DSH 插件端只登记路由、返回 enabled:false）——
  // GET  = 规格 + 当前情绪（设置页 / 诊断 / 前端兜底）
  // POST = {action:'open'} 抽选项；{action:'choose', token, id} 定反应并落情绪
  //        id 为空或 cause:'ignored' = 「被无视」（点掉泡泡 / 90 秒不理她）→ 走 sad
  if (p === '/dsh-whale/talk.json') {
    const spec = talkSpec()
    if (req.method === 'GET') {
      const cfgLlm = llmConfig()
      return send(res, 200, JSON.stringify({
        ok: true,
        scope: 'pet-app',
        enabled: !!(spec.enabled !== false && Object.keys(spec).length),
        idleMin: Number(spec.idleMin) > 0 ? Number(spec.idleMin) : 5,
        optionCount: Math.max(1, Math.min(5, Number(spec.optionCount) || 3)),
        answerTimeoutMs: Number(spec.answerTimeoutMs) > 0 ? Number(spec.answerTimeoutMs) : 90000,
        angryRepeatMin: Number(spec.angryRepeatMin) > 0 ? Number(spec.angryRepeatMin) : 3,
        pending: ((spec.opening && Array.isArray(spec.opening.pending)) ? spec.opening.pending : [])
          .map((l) => ({ t: String(l.t || ''), w: Number(l.w) || 8 })),
        mode: cfgLlm ? 'llm' : 'preset',
        mood: currentMood(),
        recent: talkRecent.slice(),
        options: (Array.isArray(spec.options) ? spec.options : []).length,
      }), MIME['.json'])
    }
    if (req.method !== 'POST') return send(res, 405, '{"ok":false}', MIME['.json'])
    return readBody(req, (body) => {
      let reqBody = {}
      try { reqBody = JSON.parse(body || '{}') || {} } catch (err) { return send(res, 400, '{"ok":false,"error":"body 不是合法 JSON"}', MIME['.json']) }
      if (spec.enabled === false || !Object.keys(spec).length) {
        return send(res, 200, JSON.stringify({ ok: false, enabled: false, error: '聊天选项未启用' }), MIME['.json'])
      }
      const mood = currentMood()
      if (reqBody.action === 'choose') {
        if (!talkOpen || reqBody.token !== talkOpen.token) {
          // token 一次性：重复点同一条选项（双击/连点）在这里被挡住，不会连着降两次情绪
          return send(res, 409, JSON.stringify({ ok: false, error: '选项已过期（token 不匹配）' }), MIME['.json'])
        }
        const cause = reqBody.cause === 'ignored' ? 'ignored' : ''
        const id = reqBody.id == null ? '' : String(reqBody.id)
        let option = null
        if (!cause && id) {
          option = (Array.isArray(talkOpen.options) ? talkOpen.options : []).find((o) => o.id === id) || null
          if (!option) return send(res, 400, JSON.stringify({ ok: false, error: '没有这个选项' }), MIME['.json'])
        }
        const openMood = talkOpen.mood || { state: mood.state, level: mood.level }
        const used = talkOpen
        talkOpen = null
        return talkResolve(spec, openMood, option, cause || (id ? '' : 'ignored')).then((r) => {
          console.log('[dsh-pet] 聊天选项：' + (r.optionId ? r.optionId + ' ' : '(被无视) ') +
            '→ ' + r.reaction + '（' + r.source + '）')
          send(res, 200, JSON.stringify(Object.assign({ ok: true, optionCount: (used.options || []).length }, r)), MIME['.json'])
        }).catch((err) => {
          console.warn('[dsh-pet] 聊天反应解析失败：' + ((err && err.message) || err))
          send(res, 200, JSON.stringify({ ok: false, error: '反应解析失败' }), MIME['.json'])
        })
      }
      // action === 'open'（缺省也是 open）
      if (talkOpen && Date.now() - talkOpen.at < 1000 * 30) {
        // 30 秒内已经开过一轮：**复用**同一个 token（避免前端重复请求把选项换掉）
        return send(res, 200, JSON.stringify({
          ok: true,
          token: talkOpen.token,
          source: talkOpen.source,
          opening: talkOpening(spec, mood),
          options: talkOpen.options.map((o) => ({ id: o.id, t: o.t })),
          mood: currentMood(),
          reused: true,
        }), MIME['.json'])
      }
      return talkOpenPayload(spec, mood).then((payload) => {
        if (!payload) return send(res, 200, JSON.stringify({ ok: false, error: '没有可用的聊天选项（检查 presets/talk.json）' }), MIME['.json'])
        send(res, 200, JSON.stringify(payload), MIME['.json'])
      }).catch((err) => {
        console.warn('[dsh-pet] 聊天选项生成失败：' + ((err && err.message) || err))
        send(res, 200, JSON.stringify({ ok: false, error: '聊天选项生成失败' }), MIME['.json'])
      })
    })
  }

  if (p === '/dsh-whale/balance.json') {
    // 额度口径随角色：gpt娘 → Codex 订阅窗口（主窗口剩余%，currency='%'）；
    // 小鲸鱼 → DeepSeek 账户余额（dsMode：total=账户总额 / topup=仅充值）
    if (currentRoleId() === 'whale') {
      return dsBalance(u.searchParams.get('refresh') === '1').then((d) => send(res, 200, JSON.stringify(d), MIME['.json']))
    }
    return codexPlan().then((c) => {
      let data
      if (c.windows && c.windows.length) {
        const used = Number(c.windows[0].usedPct)
        data = {
          ok: true,
          totalBalance: isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null,
          currency: '%',
          usageLabel: 'Codex ' + (c.windows[0].label || '5h') + ' 窗口',
          bonusBalance: null,
          rechargeBalance: null,
          stale: false,
        }
      } else if (readConfig().demo) {
        data = { ok: true, totalBalance: 88.5, currency: '%', usageLabel: 'Codex 窗口（演示）' }
      } else {
        data = { ok: false, code: 'NO_CODEX', error: '未找到 Codex 额度快照（~/.codex 会话日志里没有 rate_limits；订阅 provider 的会话才有）' }
      }
      return send(res, 200, JSON.stringify(data), MIME['.json'])
    })
  }
  if (p === '/dsh-whale/role-current.json' && (req.method === 'PUT' || req.method === 'POST')) {
    // 前端切换角色时上报（fork 的 whale-widget.js 在 applyRole 里上报）。
    // 这里是「切换惩罚」的唯一落点（2026-10-07 用户定稿）：
    //   · 没打招呼就切走 → 被甩下的那位吃醋/伤心（+ 概率躲藏 hideMaxMs ≤ 3 分钟）
    //   · 躲藏中的角色**切不回去** → { ok:false, hidden:true }（前端回退，面板同时置灰）
    //   · 切回还气着的她 → 上交互锁（前端对点她/拖她装聋 lockMs）
    // 启动时前端会用**同一个 id** 上报一次（prev === requested），不会误触发。
    return readBody(req, (body) => {
      let id = ''
      let farewell = false
      try { const b = JSON.parse(body || '{}'); id = String(b.id || ''); farewell = b.farewell === true || b.farewell === 1 } catch (err) {}
      const requested = id === 'whale' ? 'whale' : 'default'
      const prev = currentRoleId()
      if (requested !== prev) {
        const hiddenMs = roleHiddenMs(requested)
        if (hiddenMs > 0) {
          // 她躲起来了：不切（角色面板一般已置灰；这里兜手动请求/脚本直改）
          return send(res, 200, JSON.stringify({
            ok: false, hidden: true, id: prev, hiddenMs,
            reason: '她躲起来了，' + Math.ceil(hiddenMs / 1000) + 's 后才会回来',
          }), MIME['.json'])
        }
        // 告别（farewell:true = 走之前打过招呼）→ 跳过切换惩罚：不吃醋/不伤心/不躲藏
        if (!farewell) applySwitchAway(prev)   // 被甩下的那位 → 吃醋/伤心（+ 概率躲藏）
        writeConfig({ role: requested })
        dsCache = { at: 0, data: null }
        const lockUntil = lockOnReturn(requested)  // 切回来的这位：还在气头上就锁交互
        return send(res, 200, JSON.stringify({
          ok: true, id: requested, lockUntil, mood: currentMood(),
        }), MIME['.json'])
      }
      send(res, 200, JSON.stringify({ ok: true, id: requested, lockUntil: currentMood().lockUntil }), MIME['.json'])
    })
  }
  if (p === '/dsh-whale/roles.json') {
    // 角色清单 = presets/roles.json（角色名/图片/顺序都改那一份即可）。
    // 附带**每人自己的情绪**：面板据此把躲藏中的角色置灰（hideUntil 是绝对时间戳，
    // 面板自己每秒重算剩余，不用轮询接口）。
    return send(res, 200, JSON.stringify({
      ok: true,
      roles: presetRoles().map((r) => {
        const s = moodSlot(r.id)
        const st = s && MOOD_STATES.indexOf(s.state) >= 0 &&
          (Number(s.until) || 0) > Date.now() ? s.state : 'normal'
        return {
          id: r.id,
          name: r.name,
          url: r.route,
          pinned: r.pinned === true,
          pinnedAt: Number(r.pinnedAt) || 0,
          createdAt: Number(r.createdAt) || 0,
          format: 'png',
          moodState: st,
          hideUntil: Math.max(0, (s && Number(s.hideUntil)) || 0),
        }
      }),
    }), MIME['.json'])
  }
  if (p === '/dsh-whale/role-image.png') {
    const id = u.searchParams.get('id') || ''
    const role = presetRoles().find((r) => r.id === id)
    if (!role) return send(res, 404, 'unknown role')
    const file = path.join(ASSETS, String(role.image || ''))
    if (!fs.existsSync(file)) return send(res, 404, 'role image missing: ' + role.image)
    return sendFile(res, file)
  }
  if (p === '/dsh-whale/api-models.json' && req.method === 'GET') {
    return Promise.all([codexPlan(), currentRoleId() === 'whale' ? dsBalance(false) : Promise.resolve(null)]).then(([_, ds]) => {
      const plan = planPayload()
      const c = codexPlanCache
      const models = [{
        id: 'codex', name: 'Codex', provider: 'codex', currency: '%', keyRef: '', builtin: false,
        baseUrl: '', needsHostConfirm: false, canAdjustBalance: false, matchIds: [], settings: null,
        price: null, quota: null, balanceDesc: null, allowCustomHost: false, params: null,
        balanceMode: 'events', hasBalanceApi: false,
        balance: null, todayUsage: null, todayUsageCurrency: null, usageSource: 'none', error: null,
        planSupport: true, plan,
        codex: { ok: true, sessions: c.sessions, todayTokens: null, monthTokens: null, totalTokens: null },
      }]
      if (ds) {
        models.push({
          id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', currency: 'CNY', keyRef: '', builtin: false,
          baseUrl: '', needsHostConfirm: false, canAdjustBalance: true, matchIds: [], settings: null,
          price: null, quota: null, balanceDesc: null, allowCustomHost: false, params: null,
          balanceMode: 'api', hasBalanceApi: true,
          balance: ds.ok ? ds.totalBalance : null,
          todayUsage: null, todayUsageCurrency: 'CNY', usageSource: 'none',
          error: ds.ok ? null : (ds.error || null),
        })
      }
      return send(res, 200, JSON.stringify({ ok: true, models, templates: [] }), MIME['.json'])
    })
  }
  if (p === '/dsh-whale/bubble.json') {
    if (req.method === 'PUT' || req.method === 'POST') {
      // 气泡编辑器保存：按角色分别落盘
      return readBody(req, (body) => {
        try {
          const parsed = JSON.parse(body || '{}')
          if (parsed && parsed.config) {
            writeConfig(currentRoleId() === DEEPSEEK_ROLE_ID ? { bubbleWhale: parsed.config } : { bubbleGpt: parsed.config })
            return send(res, 200, '{"ok":true}', MIME['.json'])
          }
        } catch (err) {}
        send(res, 400, '{"ok":false}', MIME['.json'])
      })
    }
    const b = bubblePayload()
    return send(res, 200, JSON.stringify(b), MIME['.json'])
  }
  // 挂件的全部外观/音效/吸附设置：原样透传存取（前端字段很多且随版本演进，不做白名单）
  if (p === '/dsh-whale/size.json') {
    if (req.method === 'GET') return send(res, 200, JSON.stringify(readConfig().widget || {}), MIME['.json'])
    if (req.method === 'PUT') {
      return readBody(req, (body) => {
        let patch = {}
        try { patch = JSON.parse(body) } catch (err) {}
        writeConfig({ widget: Object.assign({}, readConfig().widget || {}, patch) })
        send(res, 200, '{"ok":true}', MIME['.json'])
      })
    }
  }
  if (p === '/dsh-whale/sound/press.mp3' || p === '/dsh-whale/sound/release.mp3') {
    const set = SOUND_SETS[u.searchParams.get('set')] || SOUND_SETS.duck
    const file = p.endsWith('press.mp3') ? set[0] : set[1]
    return sendFile(res, path.join(ASSETS, file))
  }
  // 可选端点：前端自带默认值，404 即可（角色/音频/泡泡图编辑面板会显示为空）
  if (p === '/dsh-whale/usage-settings.json') {
    // 前端在它的成功回调里顺带首次加载 api-models（plan 模块的数据源），所以这里要给合法空设置
    return send(res, 200, '{"ok":true,"settings":{}}', MIME['.json'])
  }
  if (p.startsWith('/dsh-whale/')) return send(res, 404, 'optional endpoint unavailable on standalone pet')

  send(res, 404, 'not found')
}

function startServer(cb) {
  const server = http.createServer(handle)
  const preferred = Number(readConfig().port) || 37890
  let port = preferred
  server.on('error', () => {
    if (port < preferred + 20) {
      port += 1
      server.listen(port, '127.0.0.1')
    } else if (cb) cb(new Error('没有可用端口'))
  })
  server.listen(port, '127.0.0.1', () => { if (cb) cb(null, port) })
  return server
}

module.exports = {
  startServer,
  readConfig,
  writeConfig,
  onConfigChanged,
  CONFIG_PATH: CONFIG_FILE,
  // 角色清单通过访问器暴露（支持热重载；不要在这里快照成数组）
  presetRoles,
  defaultRoleId,
  // 热重载：供 main.js 的监听器与本机工具调用
  reloadPresets,
  clearPresetCache,
  // 情绪系统：供 tools/smoke-pet.mjs 等测试读取/重置。
  // resetMoodState() 清掉**所有角色**的情绪槽（含交互锁/躲藏）与各角色的点击缓冲，
  // 外加聊天选项的内存态；不碰其它设置。
  currentMood,
  moodSlot,          // 原始槽（按角色）：测试用来看**别的角色**此刻的情绪
  resetMoodState() {
    for (const k of Object.keys(moodClicks)) delete moodClicks[k]
    // 聊天选项的"最近出现过"环也是纯内存态，一并清掉，让测试不受上一例影响
    talkRecent = []
    talkLastSet = []
    talkOpen = null
    writeConfig({ moods: {} })
    return currentMood()
  },
  MOOD_TIERS,
  MOOD_STATES,
  // 聊天选项 + 吃醋：供测试直接读取规格/切情绪（HTTP 路由见 /dsh-whale/talk.json）
  setMoodState,
  talkSpec,
  switchAwaySpec,   // 切换惩罚的有效参数（presets/talk.json 的 switchAway 经钳制后的值）
}

if (require.main === module) {
  startServer((err, port) => {
    if (err) { console.error(err.message); process.exit(1) }
    console.log('dsh-pet 本地服务已启动：http://127.0.0.1:' + port + '/（浏览器打开即可预览挂件）')
    console.log('设置页：http://127.0.0.1:' + port + '/config')
  })
}
