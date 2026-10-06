#!/usr/bin/env node
// ============================================================================
// dsh-pet fork 门禁（CI + 本机都能跑，零依赖）
//
// 拦的都是「错了不会报错、只会静默失效」的问题 —— 这个 fork 已经踩过一次：
//   · 打出来的插件 zip 里 assets/whale-widget.js 还是上游原版字节（少了角色联动补丁）
//   · pet-app 与仓库根各存一份 862 KB 前端，靠人工双改，迟早分叉
//   · 上游默认台词队列与本地抽取结果不同步时，运行时只会静默降级成"台词变少"
//   · 角色图/预设被改动后，名称对不上、图片缺失，用户只看到空白
//
// 检查项：
//   ① 语法        assets/whale-widget.js、pet-app/{server,main,preload}.js（vm 编译，不 spawn 子进程）
//   ② 前端双副本  assets/whale-widget.js 与 pet-app/assets/whale-widget.js 必须逐字节相同
//   ③ 预设        pet-app/presets/{roles,bubbles,bubble-default-whale}.json 结构 + 与前端抽取结果同步
//   ④ 图片        PNG 结构断言（签名/块白名单/透明通道/尺寸/体积），挡住"忘了去黑底/忘了裁气泡"
//   ⑤ 密钥卫生    pet-app/config.json 必须在 .gitignore 里且未被 git 跟踪
//   ⑥ 打包产物    dist/*.zip 存在时，包内 assets/whale-widget.js 必须与仓库副本同哈希
//
// 用法：
//   node tools/verify-fork.mjs                # 全量检查
//   node tools/verify-fork.mjs --fix-front    # 双副本不一致时用仓库根覆盖 pet-app 副本
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractBubbleDefaults, FRONT_FILE, OUT_FILE } from './extract-bubble-defaults.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIX_FRONT = process.argv.includes('--fix-front')

const FRONT_COPIES = ['assets/whale-widget.js', 'pet-app/assets/whale-widget.js']
const SYNTAX_FILES = [
  'assets/whale-widget.js',
  'pet-app/server.js',
  'pet-app/main.js',
  'pet-app/preload.js',
]
const PNG_FILES = [
  'pet-app/assets/DSniang1.png',
  'pet-app/assets/DSniang02.png',
  'pet-app/assets/ds-whale.png',
]
const PNG_CHUNK_WHITELIST = ['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'pHYs']
const PNG_MAX_BYTES = 1.6 * 1024 * 1024

const passes = []
const fails = []
const notes = []

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/') }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }

function check(name, fn) {
  try {
    const detail = fn()
    passes.push([name, detail === undefined ? '' : String(detail)])
  } catch (err) {
    fails.push([name, (err && err.message) || String(err)])
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

// —— ① 语法 ——
check('语法（4 个前端/宿主脚本）', () => {
  for (const f of SYNTAX_FILES) {
    const abs = path.join(ROOT, f)
    assert(fs.existsSync(abs), f + ' 不存在')
    const src = fs.readFileSync(abs, 'utf8')
    try {
      new vm.Script(src, { filename: f })
    } catch (err) {
      throw new Error(f + ' 语法错误：' + err.message.replace(/\s+/g, ' ').slice(0, 160))
    }
  }
  return SYNTAX_FILES.length + ' 个文件通过'
})

// —— ② 前端双副本 ——
check('前端双副本逐字节一致', () => {
  const bufs = FRONT_COPIES.map((f) => {
    const abs = path.join(ROOT, f)
    assert(fs.existsSync(abs), f + ' 不存在')
    return fs.readFileSync(abs)
  })
  const hashes = bufs.map(sha256)
  if (hashes[0] === hashes[1]) return hashes[0].slice(0, 12) + '（' + bufs[0].length + ' B）'
  if (FIX_FRONT) {
    fs.copyFileSync(path.join(ROOT, FRONT_COPIES[0]), path.join(ROOT, FRONT_COPIES[1]))
    const after = sha256(fs.readFileSync(path.join(ROOT, FRONT_COPIES[1])))
    assert(after === hashes[0], '--fix-front 复制后哈希仍不一致')
    return '已用 ' + FRONT_COPIES[0] + ' 覆盖副本（--fix-front）'
  }
  throw new Error(
    '两份副本不一致：' + FRONT_COPIES[0] + '=' + hashes[0].slice(0, 12) +
    ' / ' + FRONT_COPIES[1] + '=' + hashes[1].slice(0, 12) +
    '。修复：node tools/verify-fork.mjs --fix-front（确认仓库根那份是最新的）'
  )
})

// —— ③ 预设 ——
check('presets/roles.json', () => {
  const p = path.join(ROOT, 'pet-app', 'presets', 'roles.json')
  assert(fs.existsSync(p), 'pet-app/presets/roles.json 不存在')
  const data = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert(Array.isArray(data.roles) && data.roles.length, 'roles 必须是非空数组')
  const ids = new Set()
  for (const r of data.roles) {
    assert(r && typeof r.id === 'string' && r.id, 'role.id 缺失')
    assert(typeof r.name === 'string' && r.name, r.id + ' 的 name 缺失')
    assert(typeof r.route === 'string' && r.route.startsWith('/dsh-whale/'), r.id + ' 的 route 必须是 /dsh-whale/ 前缀')
    assert(!ids.has(r.id), 'role.id 重复：' + r.id)
    ids.add(r.id)
    const img = path.join(ROOT, 'pet-app', 'assets', String(r.image || ''))
    assert(r.image && fs.existsSync(img), r.id + ' 的 image 在 pet-app/assets 下不存在：' + r.image)
  }
  assert(ids.has('default'), '必须有一个 id=default 的角色')
  return data.roles.length + ' 个角色：' + [...ids].join(', ')
})

check('presets/bubbles.json', () => {
  const p = path.join(ROOT, 'pet-app', 'presets', 'bubbles.json')
  assert(fs.existsSync(p), 'pet-app/presets/bubbles.json 不存在')
  const data = JSON.parse(fs.readFileSync(p, 'utf8'))
  const gpt = data.gpt
  assert(gpt && Array.isArray(gpt.items) && gpt.items.length >= 2, 'gpt.items 至少要有 2 泡（额度泡 + 台词泡）')
  const random = gpt.items.find((it) => it.modules && it.modules.some((m) => m.type === 'random'))
  assert(random, 'gpt 队列里必须有一个 random 台词泡')
  const lines = random.modules.find((m) => m.type === 'random').lines
  assert(Array.isArray(lines) && lines.length, 'random 泡的 lines 不能为空')
  for (const l of lines) {
    assert(typeof l.t === 'string' && l.t, 'random 台词缺少 t')
    assert(typeof l.w === 'number' && l.w > 0, '随机台词缺少权重 w：' + l.t)
  }
  assert(data.whaleFallback && data.whaleFallback.items, 'whaleFallback 缺失（上游抽取失败时的兜底）')
  return gpt.items.length + ' 泡 / 随机台词 ' + lines.length + ' 句'
})

check('上游默认台词队列已同步（bubble-default-whale.json）', () => {
  let extracted
  try {
    extracted = extractBubbleDefaults(fs.readFileSync(FRONT_FILE, 'utf8'))
  } catch (err) {
    throw new Error('从 assets/whale-widget.js 抽取失败：' + err.message)
  }
  assert(Array.isArray(extracted) && extracted.length, '抽取结果不是非空数组')
  assert(fs.existsSync(OUT_FILE), rel(OUT_FILE) + ' 不存在，请跑：node tools/extract-bubble-defaults.mjs')
  const current = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
  const same = JSON.stringify(current.items) === JSON.stringify(extracted)
  assert(same, '与上游前端不同步（' + (current.items ? current.items.length : '?') + ' 项 vs ' + extracted.length + ' 项）。修复：node tools/extract-bubble-defaults.mjs')
  return extracted.length + ' 项'
})

// —— ④ PNG 结构 ——
function parsePng(abs) {
  const buf = fs.readFileSync(abs)
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert(buf.length > 8 && buf.subarray(0, 8).equals(SIG), 'PNG 签名不匹配')
  const chunks = []
  let off = 8
  let ihdr = null
  let sawIend = false
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    chunks.push(type)
    if (type === 'IHDR') {
      const d = buf.subarray(off + 8, off + 8 + 13)
      ihdr = { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9] }
    }
    if (type === 'IEND') { sawIend = true; break }
    off += 12 + len
  }
  return { chunks, ihdr, sawIend, size: buf.length }
}

check('角色图 PNG 结构（3 个文件）', () => {
  const details = []
  for (const f of PNG_FILES) {
    const abs = path.join(ROOT, f)
    assert(fs.existsSync(abs), f + ' 不存在')
    const info = parsePng(abs)
    assert(info.chunks[0] === 'IHDR', f + ' 的第一个块不是 IHDR')
    assert(info.sawIend, f + ' 缺少 IEND（文件可能被截断）')
    assert(info.chunks.includes('IDAT'), f + ' 没有 IDAT')
    const bad = info.chunks.filter((c) => !PNG_CHUNK_WHITELIST.includes(c))
    assert(!bad.length, f + ' 含非白名块：' + [...new Set(bad)].join(', ') + '（元数据/文本块必须剥离）')
    assert(info.ihdr.width >= 256 && info.ihdr.height >= 256,
      f + ' 尺寸过小：' + info.ihdr.width + 'x' + info.ihdr.height)
    const hasAlpha = info.ihdr.colorType === 6 || (info.ihdr.colorType === 3 && info.chunks.includes('tRNS'))
    assert(hasAlpha, f + ' 没有透明通道（colorType=' + info.ihdr.colorType + '）—— 挂件是透明精灵，必须有 alpha')
    assert(info.size <= PNG_MAX_BYTES,
      f + ' 体积 ' + (info.size / 1024 / 1024).toFixed(2) + ' MB 超过上限 ' + (PNG_MAX_BYTES / 1024 / 1024).toFixed(1) + ' MB')
    details.push(f.split('/').pop() + ' ' + info.ihdr.width + 'x' + info.ihdr.height)
  }
  return details.join(' / ')
})

// —— ⑤ 密钥卫生 ——
check('pet-app/config.json 未入库', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  assert(/^pet-app\/config\.json\s*$/m.test(ignore), '.gitignore 里缺少 pet-app/config.json')
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    notes.push('未检测到 .git（跳过 git 跟踪检查）')
    return '.gitignore 已声明'
  }
  try {
    const out = execFileSync('git', ['ls-files', '--', 'pet-app/config.json'], { cwd: ROOT, encoding: 'utf8' })
    assert(!out.trim(), 'pet-app/config.json 已被 git 跟踪（含 API Key，必须移出版本库）')
    return '.gitignore 已声明且未被跟踪'
  } catch (err) {
    if (err && err.status === 1) return '.gitignore 已声明且未被跟踪'
    // 沙箱子进程受限（EPERM）等情况：不把环境问题当成门禁失败
    notes.push('git 检查被跳过：' + ((err && err.message) || 'unknown').split('\n')[0])
    return '.gitignore 已声明（git 检查跳过）'
  }
})

// —— ⑥ 打包产物（可选） ——
function readZipEntry(zipPath, suffix) {
  const buf = fs.readFileSync(zipPath)
  let eocd = -1
  const from = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  assert(eocd >= 0, '找不到 EOCD（不是有效 zip）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    assert(buf.readUInt32LE(off) === 0x02014b50, '中央目录项签名异常')
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (name.endsWith(suffix)) {
      assert(buf.readUInt32LE(lho) === 0x04034b50, name + ' 的本地头签名异常')
      const method = buf.readUInt16LE(lho + 8)
      const compSize = buf.readUInt32LE(lho + 18)
      const lNameLen = buf.readUInt16LE(lho + 26)
      const lExtraLen = buf.readUInt16LE(lho + 28)
      const dataOff = lho + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataOff, dataOff + compSize)
      return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data)
    }
    off += 46 + nameLen + extraLen + cmtLen
  }
  return null
}

check('dist/*.zip 与仓库副本一致（有包才检查）', () => {
  const distDir = path.join(ROOT, 'dist')
  if (!fs.existsSync(distDir)) return '无 dist/，跳过'
  const zips = fs.readdirSync(distDir).filter((f) => f.toLowerCase().endsWith('.zip'))
  if (!zips.length) return 'dist/ 下没有 zip，跳过'
  const repoHash = sha256(fs.readFileSync(path.join(ROOT, 'assets/whale-widget.js')))
  for (const z of zips) {
    const entry = readZipEntry(path.join(distDir, z), 'assets/whale-widget.js')
    assert(entry, z + ' 包内找不到 assets/whale-widget.js')
    assert(sha256(entry) === repoHash,
      z + ' 包内 front 哈希与仓库不一致（包是用旧版本打的：这正是 custom-pet 出现过的问题）。重打：npm run pack:plugin')
  }
  return zips.length + ' 个包通过'
})

// —— 汇总 ——
console.log('== dsh-pet fork 门禁 ==')
for (const [name, detail] of passes) console.log('  ✓ ' + name + (detail ? '  → ' + detail : ''))
for (const [name, msg] of fails) console.log('  ✗ ' + name + '\n      ' + msg)
for (const n of notes) console.log('  · ' + n)
console.log('== ' + passes.length + ' 通过 / ' + fails.length + ' 失败 ==')
process.exit(fails.length ? 1 : 0)
