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
const CONFIG_KEYS = ['demo', 'dsKey', 'dsMode', 'role', 'autostart', 'widget', 'bubbleGpt', 'bubbleWhale']

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
function loadPreset(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PRESETS, name), 'utf8'))
  } catch (err) {
    console.warn('[dsh-pet] 预设 ' + name + ' 读取失败，使用内置降级值：' + ((err && err.message) || err))
    return fallback
  }
}

// —— 音效：预设组 duck → Ya1/Ya2，fx1 → D1/D2（与插件 assets 同源同名） ——
const SOUND_SETS = { duck: ['Ya1.mp3', 'Ya2.mp3'], fx1: ['D1.mp3', 'D2.mp3'] }

// —— Codex 额度：读 ~/.codex/sessions 的 rollout-*.jsonl，取最新 token_count.rate_limits 快照 ——
// 移植自上游 dsh-whale-widget 的 codexScan()/normalizeCodexRateLimits()（lib/index.js），
// 这里只需要额度窗口（5h / 周），不需要 token 统计，所以扫描策略简化为：
// 按 mtime 从新到旧逐个文件找第一个带 rate_limits 的快照（最新会话活动必带），上限 48 个文件。
// 角色清单的唯一来源是 pet-app/presets/roles.json —— server.js 不再写死角色名与图片名。
const ROLES_FALLBACK = [{ id: 'default', name: 'gpt娘', image: 'DSniang1.png', route: '/dsh-whale/image.png' }]
const ROLES_PRESET = loadPreset('roles.json', { roles: ROLES_FALLBACK })
const PRESET_ROLES = Array.isArray(ROLES_PRESET.roles) && ROLES_PRESET.roles.length
  ? ROLES_PRESET.roles
  : ROLES_FALLBACK
const DEFAULT_ROLE_ID = PRESET_ROLES[0].id
// ⚠️ 这个 id 在代码里有语义（配额口径走 DeepSeek 余额的那个角色），不只是展示名：
//    改 presets/roles.json 里的 id 时必须同步改这里。
const DEEPSEEK_ROLE_ID = 'whale'

const codexFileCache = new Map() // file -> { size, mtimeMs, rl, rlTs }
let codexPlanCache = { at: 0, windows: null, planType: '', sessions: 0 }

function currentRoleId() {
  const id = readConfig().role
  return PRESET_ROLES.some((r) => r.id === id) ? id : DEFAULT_ROLE_ID
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
const BUBBLES_PRESET = loadPreset('bubbles.json', {})
const WHALE_DEFAULT_PRESET = loadPreset('bubble-default-whale.json', null)

function emptyQueue() { return { v: 1, tapAdvance: true, lib: [], items: [] } }
function bubblePayload() {
  const role = currentRoleId()
  const cfg = readConfig()
  if (role === DEEPSEEK_ROLE_ID) {
    if (cfg.bubbleWhale) return { ok: true, source: 'stored', config: cfg.bubbleWhale }
    const official = WHALE_DEFAULT_PRESET && Array.isArray(WHALE_DEFAULT_PRESET.items) ? WHALE_DEFAULT_PRESET.items : null
    if (official && official.length) {
      return { ok: true, source: 'upstream-extracted', config: { v: 1, tapAdvance: true, lib: [], items: official } }
    }
    if (BUBBLES_PRESET.whaleFallback) {
      return { ok: true, source: 'preset-fallback', config: BUBBLES_PRESET.whaleFallback }
    }
    return { ok: true, source: 'empty', config: emptyQueue() }
  }
  if (cfg.bubbleGpt) return { ok: true, source: 'stored', config: cfg.bubbleGpt }
  if (BUBBLES_PRESET.gpt) return { ok: true, source: 'preset', config: BUBBLES_PRESET.gpt }
  return { ok: true, source: 'empty', config: emptyQueue() }
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
      const cfg = writeConfig(out)
      dsCache = { at: 0, data: null }
      send(res, 200, JSON.stringify({ ok: true, autostart: cfg.autostart === true }), MIME['.json'])
    })
  }

  if (p === '/pet-config.json') {
    const cfg = readConfig()
    return send(res, 200, JSON.stringify({
      demo: cfg.demo === true,
      dsKey: cfg.dsKey || '',
      dsMode: cfg.dsMode === 'topup' ? 'topup' : 'total',
      autostart: cfg.autostart === true,
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
        if (includeKey && cfg.dsKey) backup.secret = { dsKey: cfg.dsKey }
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
        if (k === 'role' && !PRESET_ROLES.some((r) => r.id === src[k])) continue
        if ((k === 'widget' || k === 'bubbleGpt' || k === 'bubbleWhale') &&
          (!src[k] || typeof src[k] !== 'object' || Array.isArray(src[k]))) continue
        patch[k] = src[k]
        applied.push(k)
      }
      if (backup.secret && typeof backup.secret.dsKey === 'string' && backup.secret.dsKey.trim()) {
        patch.dsKey = backup.secret.dsKey.trim()
        applied.push('dsKey')
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
    const def = PRESET_ROLES.find((r) => r.id === DEFAULT_ROLE_ID) || PRESET_ROLES[0]
    const candidates = [def && def.image, 'DSniang1.png', 'DSniang02.png'].filter(Boolean)
    const hit = candidates.map((f) => path.join(ASSETS, String(f))).find((f) => fs.existsSync(f))
    return hit ? sendFile(res, hit) : send(res, 404, 'image missing')
  }
  if (p === '/dsh-whale/rua.gif') return sendFile(res, path.join(ASSETS, 'rua.gif'))
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
    // 前端切换角色时上报（fork 的 whale-widget.js 在 applyRole 里 fire-and-forget）
    return readBody(req, (body) => {
      let id = ''
      try { id = String(JSON.parse(body || '{}').id || '') } catch (err) {}
      writeConfig({ role: id === 'whale' ? 'whale' : 'default' })
      dsCache = { at: 0, data: null }
      send(res, 200, '{"ok":true}', MIME['.json'])
    })
  }
  if (p === '/dsh-whale/roles.json') {
    // 角色清单 = presets/roles.json（角色名/图片/顺序都改那一份即可）
    return send(res, 200, JSON.stringify({
      ok: true,
      roles: PRESET_ROLES.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.route,
        pinned: r.pinned === true,
        pinnedAt: Number(r.pinnedAt) || 0,
        createdAt: Number(r.createdAt) || 0,
        format: 'png',
      })),
    }), MIME['.json'])
  }
  if (p === '/dsh-whale/role-image.png') {
    const id = u.searchParams.get('id') || ''
    const role = PRESET_ROLES.find((r) => r.id === id)
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
  PRESET_ROLES,
}

if (require.main === module) {
  startServer((err, port) => {
    if (err) { console.error(err.message); process.exit(1) }
    console.log('dsh-pet 本地服务已启动：http://127.0.0.1:' + port + '/（浏览器打开即可预览挂件）')
    console.log('设置页：http://127.0.0.1:' + port + '/config')
  })
}
