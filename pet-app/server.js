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
const CONFIG_FILE = path.join(ROOT, 'config.json')

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
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch (err) { return {} }
}
function writeConfig(patch) {
  const cfg = Object.assign(readConfig(), patch)
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  return cfg
}

// —— 音效：预设组 duck → Ya1/Ya2，fx1 → D1/D2（与插件 assets 同源同名） ——
const SOUND_SETS = { duck: ['Ya1.mp3', 'Ya2.mp3'], fx1: ['D1.mp3', 'D2.mp3'] }

// —— Codex 额度：读 ~/.codex/sessions 的 rollout-*.jsonl，取最新 token_count.rate_limits 快照 ——
// 移植自上游 dsh-whale-widget 的 codexScan()/normalizeCodexRateLimits()（lib/index.js），
// 这里只需要额度窗口（5h / 周），不需要 token 统计，所以扫描策略简化为：
// 按 mtime 从新到旧逐个文件找第一个带 rate_limits 的快照（最新会话活动必带），上限 48 个文件。
const ROLE_NAME = 'gpt娘'
const codexFileCache = new Map() // file -> { size, mtimeMs, rl, rlTs }
let codexPlanCache = { at: 0, windows: null, planType: '', sessions: 0 }

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
      writeConfig(out)
      send(res, 200, '{"ok":true}', MIME['.json'])
    })
  }

  if (p === '/pet-config.json') {
    const cfg = readConfig()
    return send(res, 200, JSON.stringify({ demo: cfg.demo === true }), MIME['.json'])
  }

  if (p === '/dsh-whale/widget.js') return sendFile(res, path.join(ASSETS, 'whale-widget.js'))
  if (p === '/dsh-whale/image.png') {
    const f = fs.existsSync(path.join(ASSETS, 'DSniang1.png')) ? 'DSniang1.png' : 'DSniang02.png'
    return sendFile(res, path.join(ASSETS, f))
  }
  if (p === '/dsh-whale/rua.gif') return sendFile(res, path.join(ASSETS, 'rua.gif'))
  if (p === '/dsh-whale/balance.json') {
    // 额度口径 = Codex 订阅窗口：主窗口（5h）剩余% 作为大数字，currency='%' 走前端非 CNY 分支显示「66.00 %」
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
  if (p === '/dsh-whale/roles.json') {
    return send(res, 200, JSON.stringify({
      ok: true,
      roles: [{ id: 'default', name: ROLE_NAME, url: '/dsh-whale/image.png', pinned: true, pinnedAt: 1, createdAt: 0, format: 'png' }],
    }), MIME['.json'])
  }
  if (p === '/dsh-whale/api-models.json' && req.method === 'GET') {
    return codexPlan().then(() => {
      const plan = planPayload()
      const c = codexPlanCache
      const model = {
        id: 'codex', name: 'Codex', provider: 'codex', currency: '%', keyRef: '', builtin: false,
        baseUrl: '', needsHostConfirm: false, canAdjustBalance: false, matchIds: [], settings: null,
        price: null, quota: null, balanceDesc: null, allowCustomHost: false, params: null,
        balanceMode: 'events', hasBalanceApi: false,
        balance: null, todayUsage: null, todayUsageCurrency: null, usageSource: 'none', error: null,
        planSupport: true, plan,
        codex: { ok: true, sessions: c.sessions, todayTokens: null, monthTokens: null, totalTokens: null },
      }
      return send(res, 200, JSON.stringify({ ok: true, models: [model], templates: [] }), MIME['.json'])
    })
  }
  if (p === '/dsh-whale/bubble.json') {
    // 自定义泡泡队列：标题 + Codex 额度模块（已用% · 重置倒计时）。前端气泡编辑器可再改。
    const cfg = {
      ok: true,
      config: {
        v: 1,
        tapAdvance: true,
        lib: [],
        items: [{
          kind: 'custom',
          modules: [
            { type: 'text', text: ROLE_NAME + ' · Codex 额度', size: 5, bold: true, rgb: '', color: '', bgRgb: '', bg: '', row: 1 },
            { type: 'plan', modelId: 'codex', size: 7, bold: true, tpl: '已用 {plan} · {plan_reset}重置', planWin: 'all', rgb: 'rouge', color: '', bgRgb: '', bg: '', row: 2 },
          ],
        }],
      },
    }
    return send(res, 200, JSON.stringify(cfg), MIME['.json'])
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

module.exports = { startServer }

if (require.main === module) {
  startServer((err, port) => {
    if (err) { console.error(err.message); process.exit(1) }
    console.log('dsh-pet 本地服务已启动：http://127.0.0.1:' + port + '/（浏览器打开即可预览挂件）')
    console.log('设置页：http://127.0.0.1:' + port + '/config')
  })
}
