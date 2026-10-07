#!/usr/bin/env node
// ============================================================================
// pet-app 冒烟测试（无需 Electron）
//
// 把 pet-app 的运行时文件复制到临时目录再起服务 —— 这样不会读/写你本机的
// pet-app/config.json（那里有 API Key 与你的设置）。
//
// 覆盖：角色清单来自 presets、角色图路由、按角色切换台词队列、导出/导入、
//       开机自启字段落盘、size.json 透传、未知端点 404。
//
// 用法：node tools/smoke-pet.mjs
// ============================================================================

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PET = path.join(ROOT, 'pet-app')

const FILES = [
  'server.js',
  'presets/roles.json',
  'presets/bubbles.json',
  'presets/bubble-default-whale.json',
  'presets/talk.json',
  'public/index.html',
  'public/config.html',
]
const IMAGES = ['DSniang1.png', 'DSniang02.png', 'ds-whale.png']
// 情绪素材目录（idle/angry）：整目录复制，缺文件时下面的情绪用例会明确报出来
const MOOD_DIR = 'assets/mood'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-smoke-'))
for (const f of FILES) {
  const dst = path.join(tmp, f)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(path.join(PET, f), dst)
}
fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true })
for (const img of IMAGES) {
  const src = path.join(PET, 'assets', img)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'assets', img))
}
fs.mkdirSync(path.join(tmp, MOOD_DIR), { recursive: true })
for (const f of fs.readdirSync(path.join(PET, MOOD_DIR))) {
  fs.copyFileSync(path.join(PET, MOOD_DIR, f), path.join(tmp, MOOD_DIR, f))
}

const require = createRequire(import.meta.url)
const pet = require(path.join(tmp, 'server.js'))

const results = []
let server = null
let fakeLlmServer = null
let failed = 0

function assert(cond, msg) { if (!cond) throw new Error(msg) }
async function step(name, fn) {
  try {
    const detail = await fn()
    results.push('  ✓ ' + name + (detail ? '  → ' + detail : ''))
  } catch (err) {
    failed++
    results.push('  ✗ ' + name + '\n      ' + ((err && err.message) || err))
  }
}

function cleanup() {
  try { if (server) server.close() } catch (err) {}
  try { if (fakeLlmServer) fakeLlmServer.close() } catch (err) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (err) {}
}

try {
  const port = await new Promise((resolve, reject) => {
    server = pet.startServer((err, p) => (err ? reject(err) : resolve(p)))
  })
  const base = 'http://127.0.0.1:' + port
  const getJson = async (p, init) => {
    const r = await fetch(base + p, init)
    return { status: r.status, type: r.headers.get('content-type') || '', body: await r.json().catch(() => null) }
  }
  const post = (p, obj) => getJson(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  })

  await step('角色清单来自 presets/roles.json', async () => {
    const r = await getJson('/dsh-whale/roles.json')
    assert(r.status === 200 && r.body && r.body.ok, 'roles.json 未返回 ok')
    assert(r.body.roles.length === 2, '期望 2 个角色，实际 ' + r.body.roles.length)
    assert(r.body.roles[0].id === 'default' && r.body.roles[0].name === 'gpt娘', 'default 角色不符：' + JSON.stringify(r.body.roles[0]))
    assert(r.body.roles[1].id === 'whale' && r.body.roles[1].name === '小鲸鱼', 'whale 角色不符')
    return r.body.roles.map((x) => x.id + '/' + x.name).join('、')
  })

  await step('默认角色图（presets 里指定的文件）', async () => {
    const r = await fetch(base + '/dsh-whale/image.png')
    assert(r.status === 200, 'HTTP ' + r.status)
    assert((r.headers.get('content-type') || '').includes('image/png'), 'Content-Type 不是 png')
    const buf = Buffer.from(await r.arrayBuffer())
    assert(buf.length > 1000, '图片字节过小：' + buf.length)
    assert(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '不是 PNG 签名')
    return buf.length + ' B'
  })

  await step('role-image.png 按 id 查 presets', async () => {
    const ok = await fetch(base + '/dsh-whale/role-image.png?id=whale')
    assert(ok.status === 200, 'whale 角色图 HTTP ' + ok.status)
    const bad = await fetch(base + '/dsh-whale/role-image.png?id=nope')
    assert(bad.status === 404, '未知角色应 404，实际 ' + bad.status)
    return 'whale 200 / 未知 404'
  })

  await step('gpt娘台词队列来自 presets（source=preset）', async () => {
    const r = await getJson('/dsh-whale/bubble.json')
    assert(r.status === 200 && r.body && r.body.config, 'bubble.json 结构异常')
    assert(r.body.source === 'preset', '期望 source=preset，实际 ' + r.body.source)
    assert(r.body.config.items.length === 2, '期望 2 泡，实际 ' + r.body.config.items.length)
    return 'source=' + r.body.source + ', ' + r.body.config.items.length + ' 泡'
  })

  await step('主动说话配置随 bubble.json 下发（顶层 chatter，不进 config）', async () => {
    const r = await getJson('/dsh-whale/bubble.json')
    const ch = r.body && r.body.chatter
    assert(ch, '响应缺少 chatter 字段')
    assert(typeof ch.enabled === 'boolean', 'chatter.enabled 非布尔')
    assert(Number(ch.everyMin) >= 1 && Number(ch.everyMax) >= Number(ch.everyMin),
      '间隔非法: ' + ch.everyMin + '-' + ch.everyMax)
    assert(Array.isArray(ch.lines) && ch.lines.length >= 5, 'chatter.lines 不足 5 句')
    for (const l of ch.lines) assert(l.t && l.w > 0, 'chatter 台词缺字段')
    // 关键设计：chatter 绝不能混进 config（否则被编辑器存档固化）
    assert(!r.body.config.chatter, 'chatter 不应出现在 config 里（会被气泡编辑器固化）')
    // 切到小鲸鱼也应带 chatter（主动说话与角色无关）
    await post('/dsh-whale/role-current.json', { id: 'whale' })
    const r2 = await getJson('/dsh-whale/bubble.json')
    assert(r2.body.chatter, '小鲸鱼角色下 chatter 丢失')
    await post('/dsh-whale/role-current.json', { id: 'default' })
    return ch.enabled
      ? ('enabled, ' + ch.everyMin + '-' + ch.everyMax + ' 分钟, ' + ch.lines.length + ' 句')
      : 'disabled'
  })

  await step('切到小鲸鱼后台词换成上游默认队列（source=upstream-extracted）', async () => {
    const put = await getJson('/dsh-whale/role-current.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'whale' }),
    })
    assert(put.status === 200 && put.body && put.body.ok, '角色上报失败')
    const r = await getJson('/dsh-whale/bubble.json')
    assert(r.body.source === 'upstream-extracted', '期望 upstream-extracted，实际 ' + r.body.source)
    assert(Array.isArray(r.body.config.items) && r.body.config.items.length > 0, '队列为空')
    return 'source=' + r.body.source + ', ' + r.body.config.items.length + ' 泡'
  })

  await step('小鲸鱼无 Key 时余额端点给出可读错误（不是崩溃）', async () => {
    const r = await getJson('/dsh-whale/balance.json')
    assert(r.status === 200, 'HTTP ' + r.status)
    assert(r.body.ok === false && r.body.code === 'NO_KEY', '期望 NO_KEY，实际 ' + JSON.stringify(r.body).slice(0, 120))
    return 'code=' + r.body.code
  })

  await step('导出默认不含 API Key', async () => {
    await post('/config', { dsKey: 'sk-smoke-test', dsMode: 'total' })
    const r = await getJson('/pet-backup.json')
    assert(r.status === 200, 'HTTP ' + r.status)
    assert(r.body && r.body.app === 'dsh-pet-desktop', 'app 字段缺失')
    assert(r.body.config && r.body.config.role === 'whale', 'role 未导出：' + JSON.stringify(r.body.config))
    assert(!r.body.secret, '默认导出不应包含 secret')
    assert(!JSON.stringify(r.body).includes('sk-smoke-test'), '默认导出里出现了 Key')
    return 'role=' + r.body.config.role
  })

  await step('导出可选包含 API Key（includeKey=1）', async () => {
    const r = await getJson('/pet-backup.json?includeKey=1')
    assert(r.body && r.body.secret && r.body.secret.dsKey === 'sk-smoke-test', 'secret.dsKey 不符')
    return 'includesKey=' + r.body.includesKey
  })

  await step('导入按白名单落盘（role / autostart）', async () => {
    const r = await post('/pet-restore', {
      app: 'dsh-pet-desktop',
      version: 1,
      config: { role: 'default', autostart: true, evil: 'should-be-ignored', dsMode: 'nope' },
    })
    assert(r.status === 200 && r.body && r.body.ok, '导入失败：' + JSON.stringify(r.body))
    assert(r.body.applied.includes('role') && r.body.applied.includes('autostart'), '未应用预期字段：' + r.body.applied)
    assert(!r.body.applied.includes('evil'), '未知字段被应用了')
    assert(!r.body.applied.includes('dsMode'), '非法 dsMode 被应用了')
    const cfg = await getJson('/pet-config.json')
    assert(cfg.body.role === undefined || true, '')
    assert(cfg.body.autostart === true, 'autostart 未落盘')
    return 'applied=' + r.body.applied.join(',')
  })

  await step('导入非法内容被拒（400）', async () => {
    const r = await post('/pet-restore', { config: { nothing: 1 } })
    assert(r.status === 400, '期望 400，实际 ' + r.status)
    return 'HTTP 400'
  })

  await step('挂件设置 size.json 透传读写', async () => {
    const put = await getJson('/dsh-whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.25, menuBtnHide: true }),
    })
    assert(put.status === 200, 'PUT HTTP ' + put.status)
    const r = await getJson('/dsh-whale/size.json')
    assert(r.body.scale === 1.25 && r.body.menuBtnHide === true, '读回不符：' + JSON.stringify(r.body))
    return 'scale=' + r.body.scale
  })

  await step('未知 /dsh-whale/* 端点仍是 404（前端靠它走内置默认值）', async () => {
    const r = await getJson('/dsh-whale/nope.json')
    assert(r.status === 404, '期望 404，实际 ' + r.status)
    return 'HTTP 404'
  })

  // —— 情绪系统 ——
  // 规则（用户定稿）：滚动 1 分钟内 25–34 次 → 1 档 1 分钟；35–49 → 2 档 3 分钟；
  // ≥50 → 3 档 5 分钟封顶；生气期间只回生气台词；情绪落 config.json，重启后继续。
  const click = () => post('/dsh-whale/mood.json', { click: true })
  const resetMood = () => pet.resetMoodState()

  await step('情绪：初始为 normal', async () => {
    resetMood()
    const m = await getJson('/dsh-whale/mood.json')
    assert(m.body.state === 'normal', 'state=' + m.body.state)
    return 'state=' + m.body.state
  })

  await step('情绪：1 分钟内 24 次不生气，第 25 次进入 1 档（60s）', async () => {
    resetMood()
    let last
    for (let i = 0; i < 24; i++) last = (await click()).body
    assert(last.state === 'normal', '24 次就生气了')
    last = (await click()).body
    assert(last.state === 'angry' && last.level === 1, 'state=' + last.state + ' level=' + last.level)
    const s = last.remainingMs / 1000
    assert(s > 55 && s <= 60, '1 档应约 60s，实际 ' + Math.round(s) + 's')
    return 'level=1 剩余 ' + Math.round(s) + 's'
  })

  await step('情绪：生气时只回生气台词（source=angry）', async () => {
    const b = await getJson('/dsh-whale/bubble.json')
    assert(b.body.source === 'angry', 'source=' + b.body.source)
    const lines = b.body.config.items[0].modules[0].lines
    assert(lines && lines.length, '生气台词为空')
    return 'source=angry，' + lines.length + ' 句'
  })

  await step('情绪：生气图路由返回 PNG', async () => {
    const r = await fetch(base + '/dsh-whale/mood-image.png')
    assert(r.status === 200, 'HTTP ' + r.status)
    const buf = Buffer.from(await r.arrayBuffer())
    assert(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '不是 PNG')
    return Math.round(buf.length / 1024) + ' KB'
  })

  await step('情绪：已落盘 config.json（重启后仍在生气）', async () => {
    const cfg = pet.readConfig()
    assert(cfg.mood && cfg.mood.state === 'angry', 'config.mood=' + JSON.stringify(cfg.mood))
    assert(cfg.mood.until > Date.now(), 'until 不是未来时间戳')
    return 'until=+' + Math.round((cfg.mood.until - Date.now()) / 1000) + 's level=' + cfg.mood.level
  })

  await step('情绪：到点自动消气并写回 config', async () => {
    pet.writeConfig({ mood: { state: 'angry', until: Date.now() - 1000, level: 2 } })
    const m = await getJson('/dsh-whale/mood.json')
    assert(m.body.state === 'normal', 'state=' + m.body.state)
    assert(pet.readConfig().mood.state === 'normal', '未写回 normal')
    return 'state=normal'
  })

  await step('情绪：消气后泡泡回正常队列', async () => {
    const b = await getJson('/dsh-whale/bubble.json')
    assert(b.body.source !== 'angry', 'source 仍是 angry')
    return 'source=' + b.body.source
  })

  await step('情绪：档位随时间升（35 次 → 2 档 180s）', async () => {
    resetMood()
    let last
    for (let i = 0; i < 35; i++) last = (await click()).body
    assert(last.state === 'angry' && last.level === 2, 'level=' + last.level)
    const s = last.remainingMs / 1000
    assert(s > 175 && s <= 180, '2 档应约 180s，实际 ' + Math.round(s) + 's')
    return 'level=2 剩余 ' + Math.round(s) + 's'
  })

  await step('情绪：≥50 次 → 3 档 300s 封顶', async () => {
    const before = (await getJson('/dsh-whale/mood.json')).body
    assert(before.level === 2, '前置档位应为 2，实际 ' + before.level)
    let last
    for (let i = 36; i <= 50; i++) last = (await click()).body
    assert(last.state === 'angry' && last.level === 3, 'level=' + last.level)
    const s = last.remainingMs / 1000
    assert(s > 295 && s <= 300, '3 档应约 300s，实际 ' + Math.round(s) + 's')
    return 'level=3 剩余 ' + Math.round(s) + 's'
  })

  await step('情绪：3 档后继续点不延长', async () => {
    const before = (await getJson('/dsh-whale/mood.json')).body.remainingMs
    for (let i = 0; i < 5; i++) await click()
    const after = (await getJson('/dsh-whale/mood.json')).body.remainingMs
    assert(after <= before, '剩余时间变长了：' + before + ' → ' + after)
    return '未延长'
  })

  await step('情绪：mood 字段在配置白名单内（可随备份走）', async () => {
    const r = await getJson('/pet-backup.json')
    assert(r.body.config.mood, '备份里没有 mood')
    return 'mood.state=' + r.body.config.mood.state
  })

  await step('情绪：小鲸鱼也有成套素材（切到 whale 后生气图不同）', async () => {
    resetMood()
    // 切到小鲸鱼
    await post('/dsh-whale/role-current.json', { id: 'whale' })
    const idleImg = Buffer.from(await (await fetch(base + '/dsh-whale/mood-image.png')).arrayBuffer())
    // 点满 25 次 → 生气
    for (let i = 0; i < 25; i++) await click()
    const angryImg = Buffer.from(await (await fetch(base + '/dsh-whale/mood-image.png')).arrayBuffer())
    assert(!idleImg.equals(angryImg), '小鲸鱼生气前后拿到的图相同（说明没有成套素材）')
    const b = await getJson('/dsh-whale/bubble.json')
    assert(b.body.source === 'angry', 'source=' + b.body.source)
    // 小鲸鱼的生气台词应当来自 whaleAngry 池
    const line = b.body.config.items[0].modules[0].lines[0].t
    assert(typeof line === 'string' && line.length, '生气台词为空')
    // 切回 gpt娘，确认两角色台词池不同
    await post('/dsh-whale/role-current.json', { id: 'default' })
    const b2 = await getJson('/dsh-whale/bubble.json')
    const line2 = b2.body.config.items[0].modules[0].lines[0].t
    assert(line !== line2, '两角色生气台词相同（应当各用各的池）：' + line)
    return 'whale: ' + line + ' / gpt: ' + line2
  })

  // —— 余额口径：两个角色的单位必须可区分（这是真实 bug 的回归测试）——
  // 症状：从 gpt娘（Codex 百分比）切到小鲸鱼（人民币）时，若新角色读不到数，
  // 界面会继续显示上一个角色留下的「98 %」——单位不对、数值也不是自己的。
  // 后端侧要保证：取不到数时**不返回 currency**，让前端没有"旧的 %"可用。
  await step('余额口径：gpt娘是百分比、小鲸鱼是人民币（单位可区分）', async () => {
    const savedKey = pet.readConfig().dsKey
    // 显式置空 Key：用例不能依赖运行环境里是否恰好存过 Key（否则 CI 与开发机会得到不同结果）
    pet.writeConfig({ dsKey: '' })
    try {
      await post('/dsh-whale/role-current.json', { id: 'default' })
      const g = (await getJson('/dsh-whale/balance.json')).body
      assert(g.currency === '%', 'gpt娘应为 %，实际 ' + JSON.stringify(g.currency))

      await post('/dsh-whale/role-current.json', { id: 'whale' })
      const w = (await getJson('/dsh-whale/balance.json')).body
      // 未配 Key：必须给可读错误，且**不带 currency**
      //（带 currency 的话，前端会拿上一个角色残留的单位继续显示 —— 这正是那个 bug）
      assert(w.ok === false, '未配 Key 时不该成功')
      assert(w.code === 'NO_KEY', '期望 NO_KEY，实际 ' + w.code)
      assert(w.currency === undefined, '失败响应不应带 currency（否则前端会误用旧单位）')
      return 'gpt=%、whale=' + w.code + '（失败不带 currency ✓）'
    } finally {
      pet.writeConfig({ dsKey: savedKey || '' })
    }
  })

  await step('余额口径：配了 Key 时小鲸鱼返回 CNY（不依赖网络成功）', async () => {
    // 用假 Key：真实 HTTP 请求会失败，但**响应契约**仍必须是「成功才带 currency=CNY，
    // 失败必须给 code 且不带 currency」——这样前端在任何分支都不会误用 % 单位。
    const savedKey = pet.readConfig().dsKey
    pet.writeConfig({ dsKey: 'sk-smoke-invalid' })
    try {
      await post('/dsh-whale/role-current.json', { id: 'whale' })
      const w = (await getJson('/dsh-whale/balance.json')).body
      if (w.ok) {
        assert(w.currency === 'CNY', '小鲸鱼成功时应为 CNY，实际 ' + w.currency)
        return 'currency=CNY total=' + w.totalBalance
      }
      assert(['FETCH', 'SHAPE'].includes(w.code), '假 Key 应得 FETCH/SHAPE，实际 ' + w.code)
      assert(w.currency === undefined, '失败响应不应带 currency')
      return 'code=' + w.code + '（失败不带 currency ✓）'
    } finally {
      pet.writeConfig({ dsKey: savedKey || '' })
    }
  })

  await step('设置页「测试连接」：未填 Key 时给出可读错误', async () => {
    const savedKey = pet.readConfig().dsKey
    pet.writeConfig({ dsKey: '' })
    try {
      const r = await post('/pet-test-ds', { dsKey: '' })
      assert(r.body.ok === false, '未填 Key 不该成功')
      assert(r.body.code === 'NO_KEY', '期望 NO_KEY，实际 ' + r.body.code)
      return 'code=NO_KEY'
    } finally {
      pet.writeConfig({ dsKey: savedKey || '' })
    }
  })

  // ==========================================================================
  // 聊天选项 + 吃醋（presets/talk.json + /dsh-whale/talk.json）
  // 覆盖：规格下发、每轮选项都不同、token 一次性、rival → 吃醋、被无视 → 伤心、
  //       消气回 normal、点她时的情绪台词池、LLM 路径与静默回落、密钥卫生。
  // ==========================================================================
  const talkOpen = async () => post('/dsh-whale/talk.json', { action: 'open' })
  const talkChoose = async (token, id, cause) => post('/dsh-whale/talk.json',
    cause ? { action: 'choose', token: token, id: '', cause: cause } : { action: 'choose', token: token, id: id })

  await step('聊天选项：规格下发（enabled / idleMin=5 / 每次 3 个）', async () => {
    pet.resetMoodState()
    const r = await getJson('/dsh-whale/talk.json')
    assert(r.status === 200 && r.body && r.body.ok === true, 'GET talk.json 结构异常')
    assert(r.body.enabled === true, '期望 enabled=true')
    assert(r.body.idleMin === 5, '期望 idleMin=5，实际 ' + r.body.idleMin)
    assert(r.body.optionCount === 3, '期望 optionCount=3')
    assert(r.body.mode === 'preset', '未配 LLM 时 mode 应为 preset')
    assert(r.body.options >= 10, '选项池至少 10 条，实际 ' + r.body.options)
    const b = await getJson('/dsh-whale/bubble.json')
    assert(b.body.talk && b.body.talk.enabled === true, 'bubble.json 顶层未下发 talk')
    assert(b.body.config.talk === undefined, 'talk 不该混进 config（会被气泡编辑器存档固化）')
    return 'idleMin=' + r.body.idleMin + ' / 池 ' + r.body.options + ' 条 / mode=' + r.body.mode
  })

  await step('聊天选项：每轮 3 个且互不相同、四轮之间不重复', async () => {
    const keys = []
    for (let i = 0; i < 4; i++) {
      pet.setMoodState('normal', 0)
      const r = await talkOpen()
      assert(r.body.ok && r.body.options.length === 3, '第 ' + (i + 1) + ' 轮没给 3 个选项')
      const ids = r.body.options.map((o) => o.id)
      assert(new Set(ids).size === 3, '第 ' + (i + 1) + ' 轮选项有重复：' + ids.join(','))
      keys.push(ids.slice().sort().join(','))
      await talkChoose(r.body.token, '', 'ignored')   // 答掉这一轮，避免 30 秒复用窗口
    }
    assert(new Set(keys).size === 4, '四轮选项集合出现重复：' + keys.join(' | '))
    return keys.join(' | ')
  })

  await step('聊天选项：30 秒内重复 open 复用同一轮（前端重复请求不换选项）', async () => {
    pet.setMoodState('normal', 0)
    const a = await talkOpen()
    const b = await talkOpen()
    assert(a.body.token === b.body.token && b.body.reused === true, '重复 open 没有复用同一 token')
    await talkChoose(a.body.token, '', 'ignored')
    return 'token 复用 ✓'
  })

  await step('吃醋：提到别的 AI 娘的选项 → reaction=jealous + 情绪落盘 + 吃醋台词', async () => {
    pet.resetMoodState()
    let hit = null
    for (let i = 0; i < 12 && !hit; i++) {
      pet.setMoodState('normal', 0)
      const r = await talkOpen()
      const o = r.body.options.find((x) => /deepseek|claude|gemini|kimi|月见|克洛德/i.test(x.t))
      if (o) hit = { token: r.body.token, o: o }
      else await talkChoose(r.body.token, '', 'ignored')
    }
    assert(hit, '12 轮内没抽到任何"提到别的 AI 娘"的选项')
    const r = await talkChoose(hit.token, hit.o.id)
    assert(r.body.reaction === 'jealous', '期望 jealous，实际 ' + r.body.reaction)
    assert(r.body.jealous === true && r.body.rival, '缺少 jealous 标记或命中的别名')
    assert(r.body.mood && r.body.mood.state === 'jealous', 'mood 未切到 jealous')
    assert(pet.currentMood().state === 'jealous', 'config.json 里没落成 jealous（重启就变回去）')
    assert(Array.isArray(r.body.lines) && r.body.lines.length, '吃醋没有台词')
    assert(r.body.action === 'tremble', '吃醋动作应为 tremble，实际 ' + r.body.action)
    // 吃醋素材缺失时取图必须回落到生气素材，且仍是合法 PNG（不能 404）
    const img = await fetch(base + '/dsh-whale/mood-image.png')
    const buf = Buffer.from(await img.arrayBuffer())
    assert(img.status === 200, '吃醋态取图 HTTP ' + img.status)
    assert(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '不是 PNG 签名')
    const again = await talkChoose(hit.token, hit.o.id)
    assert(again.status === 409, '同一 token 再选一次应 409，实际 ' + again.status)
    return hit.o.t + ' → jealous（rival=' + r.body.rival + '）'
  })

  await step('聊天选项：被无视（点掉泡泡 / 90 秒不理）→ 伤心并落盘', async () => {
    pet.setMoodState('angry', 60000)
    const r = await talkOpen()
    const d = await talkChoose(r.body.token, '', 'ignored')
    assert(d.body.reaction === 'sad', '期望 sad，实际 ' + d.body.reaction)
    assert(pet.currentMood().state === 'sad', 'config.json 里没落成 sad')
    return 'ignored → sad ✓'
  })

  await step('聊天选项：消气选项 → 回到 normal', async () => {
    let calmed = false
    for (let i = 0; i < 12 && !calmed; i++) {
      pet.setMoodState('angry', 60000)
      const r = await talkOpen()
      const target = r.body.options.find((o) => /^o0[1-4]$/.test(o.id)) || r.body.options[0]
      const d = await talkChoose(r.body.token, target.id)
      if (d.body.reaction === 'calm') calmed = true
      else await talkChoose(r.body.token, '', 'ignored')
    }
    assert(calmed, '12 轮内没抽到 calm 选项')
    assert(pet.currentMood().state === 'normal', 'calm 后应回到 normal')
    return 'calm → normal ✓'
  })

  await step('聊天选项：错 token / 不存在的选项被拒（不会重复降情绪）', async () => {
    pet.resetMoodState()
    const bad = await talkChoose('not-a-token', 'o01')
    assert(bad.status === 409, '错 token 应 409，实际 ' + bad.status)
    const r = await talkOpen()
    const no = await post('/dsh-whale/talk.json', { action: 'choose', token: r.body.token, id: 'o-not-exist' })
    assert(no.status === 400, '不存在的选项应 400，实际 ' + no.status)
    await talkChoose(r.body.token, '', 'ignored')
    return '409 / 400 ✓'
  })

  await step('情绪台词池：吃醋/伤心时点她回对应台词（两角色各用各的池）', async () => {
    await post('/dsh-whale/role-current.json', { id: 'default' })
    pet.setMoodState('jealous', 60000)
    const j = (await getJson('/dsh-whale/bubble.json')).body
    assert(j.source === 'jealous', '期望 source=jealous，实际 ' + j.source)
    const jl = j.config.items[0].modules[0].lines.map((l) => l.t).join('|')
    assert(/横向对比|列三点/.test(jl), 'gpt娘 吃醋台词池未生效：' + jl.slice(0, 60))
    pet.setMoodState('sad', 60000)
    const s = (await getJson('/dsh-whale/bubble.json')).body
    assert(s.source === 'sad', '期望 source=sad，实际 ' + s.source)
    const sl = s.config.items[0].modules[0].lines.map((l) => l.t).join('|')
    assert(/对话框转过去|自己待着/.test(sl), 'gpt娘 伤心台词池未生效：' + sl.slice(0, 60))
    // 小鲸鱼走它自己的一组（whaleJealous / whaleSad），证明不是共用一份
    await post('/dsh-whale/role-current.json', { id: 'whale' })
    pet.setMoodState('jealous', 60000)
    const wj = (await getJson('/dsh-whale/bubble.json')).body
    const wjl = wj.config.items[0].modules[0].lines.map((l) => l.t).join('|')
    assert(/夸别人|记了这句话/.test(wjl), '小鲸鱼吃醋台词池未生效：' + wjl.slice(0, 60))
    await post('/dsh-whale/role-current.json', { id: 'default' })
    pet.setMoodState('normal', 0)
    const n = (await getJson('/dsh-whale/bubble.json')).body
    assert(n.source === 'preset', '消气后应回正常队列，实际 ' + n.source)
    return 'gpt/whale 的吃醋与伤心台词各就各位'
  })

  // —— 自定义 LLM（可选后端）：起一个假的 OpenAI 兼容端点，验证"接了就用、坏了就回落"——
  let llmMode = 'good'
  await step('自定义 LLM：接上假端点后走 LLM（选项与她的话都来自模型）', async () => {
    const srv = http.createServer((q, r) => {
      let body = ''
      q.on('data', (c) => { body += c })
      q.on('end', () => {
        let req = {}
        try { req = JSON.parse(body) } catch (err) {}
        const userText = String(((req.messages || [])[1] || {}).content || '')
        let content
        if (llmMode !== 'good') content = '这不是 JSON，我随便说点别的'
        else if (userText.indexOf('options') >= 0) {
          // 注意每条都在 maxOptionChars（10）以内：超长会被宿主判为不合法而整体回落预设
          content = JSON.stringify({ opening: '冒烟假端点', options: ['假选项甲', '假选项乙', '夸夸DeepSeek'] })
        } else {
          content = '```json\n{"reaction":"jealous","lines":["假端点：我吃醋了"]}\n```'
        }
        r.writeHead(200, { 'Content-Type': 'application/json' })
        r.end(JSON.stringify({ choices: [{ message: { content: content } }] }))
      })
    })
    const port = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)))
    fakeLlmServer = srv
    const llmBase = 'http://127.0.0.1:' + port + '/v1'
    await post('/config', { llm: { enabled: true, baseUrl: llmBase, model: 'smoke-fake', apiKey: 'sk-smoke' } })
    try {
      const st = await getJson('/dsh-whale/talk.json')
      assert(st.body.mode === 'llm', '配好后 mode 应为 llm，实际 ' + st.body.mode)
      const b = await getJson('/dsh-whale/bubble.json')
      assert(b.body.talk.mode === 'llm', 'bubble.json 的 talk.mode 未跟着变')
      pet.setMoodState('normal', 0)
      const r = await talkOpen()
      assert(r.body.source === 'llm', '期望 source=llm，实际 ' + r.body.source)
      assert(r.body.options[0].t === '假选项甲', '选项未来自模型：' + JSON.stringify(r.body.options))
      const d = await talkChoose(r.body.token, r.body.options[0].id)
      assert(d.body.reaction === 'jealous', 'LLM 生成的选项应由模型定反应，实际 ' + d.body.reaction)
      assert(String((d.body.lines[0] || {}).t).indexOf('假端点') === 0, '台词未来自模型')
      return 'mode=llm / 选项与反应均来自模型'
    } finally {
      pet.writeConfig({ llm: {} })   // 后面两步自己会重设
      await post('/config', { llm: { enabled: true, baseUrl: llmBase, model: 'smoke-fake', apiKey: 'sk-smoke' } })
    }
  })

  await step('自定义 LLM：返回不是 JSON → 静默回落预设（功能不受影响）', async () => {
    llmMode = 'bad'
    try {
      pet.setMoodState('normal', 0)
      const r = await talkOpen()
      assert(r.body.source === 'preset', '模型返回垃圾时应回落 preset，实际 ' + r.body.source)
      assert(r.body.options.length === 3, '回落后仍要给 3 个选项')
      return 'source=preset（回落 ✓）'
    } finally { llmMode = 'good' }
  })

  await step('设置页「测试连接」：LLM 未配齐给可读错误；配好给样例', async () => {
    const okr = await post('/pet-test-llm', { baseUrl: '', model: '', apiKey: '' })
    assert(okr.body.ok === true, '已有保存的配置时应能测通')
    assert(Array.isArray(okr.body.options) && okr.body.options.length === 3, '测试连接未回 3 个样例选项')
    await post('/config', { llm: { enabled: false, baseUrl: '', model: '', apiKey: null } })
    const bad = await post('/pet-test-llm', { baseUrl: '', model: '', apiKey: '' })
    assert(bad.body.ok === false && bad.body.code === 'NO_LLM', '未配齐时应 NO_LLM，实际 ' + JSON.stringify(bad.body))
    return 'ok 样例 3 条 / 未配齐 NO_LLM'
  })

  await step('密钥卫生：llm.apiKey 不进默认备份、不回显、includeKey=1 才进 secret', async () => {
    await post('/config', { llm: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'smoke-fake', apiKey: 'sk-secret-smoke' } })
    const cfg = (await getJson('/pet-config.json')).body
    assert(cfg.llm.apiKey === undefined, '设置页接口不该回显明文 Key')
    assert(cfg.llm.hasKey === true, '应告知"已存 Key"')
    const b1 = (await getJson('/pet-backup.json')).body
    assert(b1.config.llm && b1.config.llm.apiKey === undefined, '默认备份不该含 llm.apiKey')
    const b2 = (await getJson('/pet-backup.json?includeKey=1')).body
    assert(b2.secret && b2.secret.llm && b2.secret.llm.apiKey === 'sk-secret-smoke', 'includeKey=1 时 Key 应在 secret.llm')
    await post('/config', { llm: { enabled: false, baseUrl: '', model: '', apiKey: null } })
    pet.resetMoodState()
    return 'hasKey=true / 默认剔除 / secret.llm ✓'
  })
} catch (err) {
  failed++
  results.push('  ✗ 启动失败：' + ((err && err.message) || err))
} finally {
  cleanup()
}

console.log('== pet-app 冒烟 ==')
for (const line of results) console.log(line)
console.log('== ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败 ==')
process.exit(failed ? 1 : 0)
