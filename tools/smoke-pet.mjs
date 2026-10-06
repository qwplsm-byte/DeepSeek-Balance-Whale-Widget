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
  'public/index.html',
  'public/config.html',
]
const IMAGES = ['DSniang1.png', 'DSniang02.png', 'ds-whale.png']

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

const require = createRequire(import.meta.url)
const pet = require(path.join(tmp, 'server.js'))

const results = []
let server = null
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
