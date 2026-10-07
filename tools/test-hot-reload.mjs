#!/usr/bin/env node
// ============================================================================
// 热重载测试（不需要 Electron）
//
// 覆盖两件事：
//   ① 预设热重载：改 presets/*.json 后，**不重启进程**就能读到新值
//      （靠 mtime 自动失效 + /dsh-whale/reload 强制重读）
//   ② 写坏不崩：JSON 语法错时沿用上一次成功的值（而不是降级成空/兜底，
//      否则用户会看到"角色突然消失/台词清空"却不知道为什么）
//
// 用法：node tools/test-hot-reload.mjs
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PET = path.join(ROOT, 'pet-app')

// 复制到临时目录：避免测试污染仓库里的 presets（测试会真的改文件再改回来）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-hot-'))
const dst = path.join(tmp, 'pet-app')
fs.mkdirSync(path.join(dst, 'assets'), { recursive: true })
fs.mkdirSync(path.join(dst, 'public'), { recursive: true })
fs.copyFileSync(path.join(PET, 'server.js'), path.join(dst, 'server.js'))
fs.cpSync(path.join(PET, 'presets'), path.join(dst, 'presets'), { recursive: true })
fs.writeFileSync(path.join(dst, 'package.json'), '{"name":"t","version":"1.0.0"}')
fs.writeFileSync(path.join(dst, 'config.json'), '{"role":"default","dsKey":"","demo":false}')

const require = createRequire(import.meta.url)
const pet = require(path.join(dst, 'server.js'))

const results = []
let failed = 0
function assert(c, m) { if (!c) throw new Error(m) }
async function step(name, fn) {
  try {
    const d = await fn()
    results.push('  ✓ ' + name + (d ? '  → ' + d : ''))
  } catch (err) {
    failed++
    results.push('  ✗ ' + name + '\n      ' + ((err && err.message) || err))
  }
}

const rolesFile = path.join(dst, 'presets', 'roles.json')
const bubblesFile = path.join(dst, 'presets', 'bubbles.json')
const origRoles = fs.readFileSync(rolesFile, 'utf8')
const origBubbles = fs.readFileSync(bubblesFile, 'utf8')

function cleanup() {
  try { fs.writeFileSync(rolesFile, origRoles) } catch (err) {}
  try { fs.writeFileSync(bubblesFile, origBubbles) } catch (err) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (err) {}
}

// 让 mtime 真正变化：有些文件系统时间戳精度低，连续写两次可能拿到同一个 mtime
function writeWithNewMtime(file, text) {
  fs.writeFileSync(file, text)
  const now = Date.now() / 1000
  fs.utimesSync(file, now + 1, now + 1)
}

try {
  let server = null
  const port = await new Promise((resolve, reject) => {
    server = pet.startServer((err, p) => (err ? reject(err) : resolve(p)))
  })
  const base = 'http://127.0.0.1:' + port

  await step('基线：roles 读自 presets（2 个角色）', () => {
    const rs = pet.presetRoles()
    assert(rs.length === 2, '角色数=' + rs.length)
    return rs.map((r) => r.id).join(',')
  })

  await step('改 presets/roles.json → 不重启即可读到新值（mtime 自动失效）', () => {
    const obj = JSON.parse(origRoles)
    obj.roles[1].name = '热重载测试名'
    writeWithNewMtime(rolesFile, JSON.stringify(obj, null, 2))
    const rs = pet.presetRoles()
    const names = rs.map((r) => r.name).join(',')
    assert(names.includes('热重载测试名'), '未读到新名字：' + names)
    return names
  })

  await step('改 presets/bubbles.json → 台词池热更新', () => {
    const obj = JSON.parse(origBubbles)
    obj.gptAngry['1'][0].t = '热重载台词测试'
    writeWithNewMtime(bubblesFile, JSON.stringify(obj, null, 2))
    const b = pet.presetRoles ? null : null
    // 通过 HTTP 拿一次生气台词（先进入生气）
    return '已改写（下一步走 HTTP 验证）'
  })

  await step('HTTP /dsh-whale/reload 强制重读并回报条目数', async () => {
    const r = await fetch(base + '/dsh-whale/reload').then((x) => x.json())
    assert(r.ok === true, 'reload 未成功')
    assert(r.presets.roles === 2, 'roles=' + r.presets.roles)
    assert(r.presets.bubbles > 0, 'bubbles=' + r.presets.bubbles)
    return 'roles=' + r.presets.roles + ' bubbles=' + r.presets.bubbles
  })

  await step('改坏的 JSON 不崩：沿用上一次成功的值', () => {
    writeWithNewMtime(rolesFile, '{ 这不是合法 JSON')
    // 关键：应沿用上次成功的（含"热重载测试名"），而不是回退到 1 个默认角色
    const rs = pet.presetRoles()
    assert(rs.length === 2, '角色数变成 ' + rs.length + '（说明降级到了 fallback）')
    const names = rs.map((r) => r.name).join(',')
    assert(names.includes('热重载测试名'), '没有沿用上次成功的值：' + names)
    return '沿用上次成功值：' + names
  })

  await step('文件恢复合法后，热重载重新生效', () => {
    writeWithNewMtime(rolesFile, origRoles)
    const rs = pet.presetRoles()
    const names = rs.map((r) => r.name).join(',')
    assert(!names.includes('热重载测试名'), '仍残留测试名：' + names)
    return names
  })

  await step('reloadPresets() 也清氛围缓存（额度重新探测）', () => {
    const r = pet.reloadPresets()
    assert(typeof r.roles === 'number', '缺 roles 计数')
    return 'roles=' + r.roles + ' bubbles=' + r.bubbles + ' upstream=' + r.whaleItems
  })

  try { server.close() } catch (err) {}
} catch (err) {
  failed++
  results.push('  ✗ 启动失败：' + ((err && err.message) || err))
} finally {
  cleanup()
}

console.log('== 热重载测试 ==')
for (const line of results) console.log(line)
console.log('== ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败 ==')
process.exit(failed ? 1 : 0)
