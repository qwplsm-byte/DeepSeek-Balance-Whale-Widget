// dsh-pet-desktop —— 本地后端
// 复刻 dsh-whale-widget 前端（assets/whale-widget.js）依赖的 /dsh-whale/* 最小契约：
//   balance.json / size.json / image.png / rua.gif / sound/*.mp3 必需；
//   bubble.json 等可选端点返回 404，前端自带默认值兜底。
// 纯 Node 零依赖；既被 Electron 主进程 require，也可以 `node server.js` 独立调试
// （独立跑时在浏览器打开打印的地址，即可在网页里看到与 DSH 内一致的挂件）。

const http = require('http')
const https = require('https')
const fs = require('fs')
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

// —— DeepSeek 余额（api.deepseek.com/user/balance，Bearer Key 来自 config.json） ——
// 响应形如 { is_available, balance_infos: [{currency, total_balance, granted_balance, topped_up_balance}] }
let balanceCache = { at: 0, data: null }
function fetchBalance(apiKey) {
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

async function buildBalance(force) {
  const cfg = readConfig()
  if (cfg.demo) {
    return { ok: true, totalBalance: 366.64, currency: 'CNY', usageLabel: '演示模式' }
  }
  if (!cfg.apiKey) {
    return { ok: false, code: 'NO_KEY', error: '未配置 API Key（右键托盘 → 设置）' }
  }
  const age = Date.now() - balanceCache.at
  if (!force && balanceCache.data && age < 60 * 1000) return balanceCache.data
  try {
    const raw = await fetchBalance(String(cfg.apiKey).trim())
    const infos = Array.isArray(raw && raw.balance_infos) ? raw.balance_infos : []
    if (!infos.length) {
      const data = { ok: false, code: 'SHAPE', error: '余额接口没有返回 balance_infos' }
      return data
    }
    const pick = infos.find((x) => x && x.currency === 'CNY' && Number(x.total_balance) > 0)
      || infos.find((x) => x && x.currency === 'CNY')
      || infos[0]
    const data = {
      ok: true,
      totalBalance: Number(pick.total_balance) || 0,
      currency: pick.currency || 'CNY',
      bonusBalance: isFinite(Number(pick.granted_balance)) ? Number(pick.granted_balance) : null,
      rechargeBalance: isFinite(Number(pick.topped_up_balance)) ? Number(pick.topped_up_balance) : null,
      usageLabel: 'DeepSeek 官方',
      stale: raw.is_available === false,
    }
    balanceCache = { at: Date.now(), data }
    return data
  } catch (err) {
    return { ok: false, code: 'FETCH', error: String((err && err.message) || err) }
  }
}

// —— 音效：预设组 duck → Ya1/Ya2，fx1 → D1/D2（与插件 assets 同源同名） ——
const SOUND_SETS = { duck: ['Ya1.mp3', 'Ya2.mp3'], fx1: ['D1.mp3', 'D2.mp3'] }

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
      if (typeof patch.apiKey === 'string') out.apiKey = patch.apiKey.trim()
      if (typeof patch.demo === 'boolean') out.demo = patch.demo
      writeConfig(out)
      balanceCache = { at: 0, data: null }
      send(res, 200, '{"ok":true}', MIME['.json'])
    })
  }

  if (p === '/pet-config.json') {
    const cfg = readConfig()
    return send(res, 200, JSON.stringify({ apiKey: cfg.apiKey || '', demo: cfg.demo === true }), MIME['.json'])
  }

  if (p === '/dsh-whale/widget.js') return sendFile(res, path.join(ASSETS, 'whale-widget.js'))
  if (p === '/dsh-whale/image.png') {
    const f = fs.existsSync(path.join(ASSETS, 'DSniang1.png')) ? 'DSniang1.png' : 'DSniang02.png'
    return sendFile(res, path.join(ASSETS, f))
  }
  if (p === '/dsh-whale/rua.gif') return sendFile(res, path.join(ASSETS, 'rua.gif'))
  if (p === '/dsh-whale/balance.json') {
    return buildBalance(u.searchParams.get('refresh') === '1').then((d) => send(res, 200, JSON.stringify(d), MIME['.json']))
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
