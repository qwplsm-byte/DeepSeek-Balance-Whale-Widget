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

// —— ①b 设置页内联脚本 ——
// 真实事故：一次编辑把两处换行删掉了，导致 `}` 与下一行 `document...` 连在一起，
// 整个内联 <script> 语法错误 —— 表现是「测试连接/保存/开机自启点了都没用」，
// 而且浏览器不报给用户看。这里编译所有内联脚本，并校验 getElementById 的目标都存在。
check('设置页内联脚本（语法 + 元素引用）', () => {
  const files = ['pet-app/public/config.html', 'pet-app/public/index.html']
  const details = []
  for (const f of files) {
    const abs = path.join(ROOT, f)
    if (!fs.existsSync(abs)) continue
    const html = fs.readFileSync(abs, 'utf8')
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    scripts.forEach((m, i) => {
      try {
        new vm.Script(m[1], { filename: f + ' inline#' + (i + 1) })
      } catch (err) {
        throw new Error(f + ' 第 ' + (i + 1) + ' 个内联脚本语法错误：' +
          err.message.replace(/\s+/g, ' ').slice(0, 140) +
          '　（这类错误会让整页控件全部失效，浏览器不会提示用户）')
      }
    })
    const used = [...new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))]
    const missing = used.filter((u) => !ids.has(u))
    assert(!missing.length, f + ' 的 getElementById 引用了不存在的 id：' + missing.join(', '))
    details.push(path.basename(f) + '(' + scripts.length + ' 脚本/' + used.length + ' 引用)')
  }
  return details.join(' / ')
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

check('动作系统（场景自动触发的 CSS 动画）', () => {
  const abs = path.join(ROOT, 'assets', 'whale-widget.js')
  const src = fs.readFileSync(abs, 'utf8')
  // CSS 定义：五个 keyframes（呼吸/跳跃/摇头/颤动/摇摆）
  for (const kf of ['dshwvBreath', 'dshwvJump', 'dshwvShake', 'dshwvTremble', 'dshwvSway']) {
    assert(src.includes('@keyframes ' + kf), '缺少 @keyframes ' + kf)
  }
  assert(src.includes('dshwv-dragging .dshwv-img'), '缺少拖拽摇摆动画（.dshwv-dragging .dshwv-img）')
  assert(src.includes('transform-origin:50% 100%'), '缺少 transform-origin 钉底（跳跃/摇头会脚离地）')
  // 触发钩子：场景 → 动作的接线
  assert(src.includes("runImgAnim('jump'"), '缺少「泡泡弹出 → 跳跃」钩子')
  assert((src.match(/runImgAnim\('shake'/g) || []).length >= 3,
    '「摇头」钩子不足 3 处（生气进入 + 两处余额错误）')
  assert(src.includes('prevStatus'), '余额错误摇头缺跃迁判断（会每 60s 轮询重抖）')
  assert(src.includes('moodTrembleStart') && src.includes('moodTrembleStop'), '缺少生气期周期颤动的启停')
  assert(src.includes("imgAnimSet('dshwv-a-breathe', true)"), '缺少常驻呼吸启动')
  return '呼吸/跳跃/摇头/颤动/摇摆 五动作，钩子与跃迁判断齐全'
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
  // 生气台词：**每个有情绪的角色**三档都必须有（1/2/3 档各取一池）
  assert(data.gptAngry && typeof data.gptAngry === 'object', 'gptAngry 缺失（gpt娘的生氣台词池）')
  assert(data.whaleAngry && typeof data.whaleAngry === 'object', 'whaleAngry 缺失（小鲸鱼的生气台词池）')
  let angryTotal = 0
  for (const [poolName, pool] of [['gptAngry', data.gptAngry], ['whaleAngry', data.whaleAngry]]) {
    for (const lv of ['1', '2', '3']) {
      const arr = pool[lv]
      assert(Array.isArray(arr) && arr.length, poolName + '["' + lv + '"] 必须是非空数组')
      for (const l of arr) {
        assert(typeof l.t === 'string' && l.t, poolName + '[' + lv + '] 有台词缺少 t')
        assert(typeof l.w === 'number' && l.w > 0, poolName + '[' + lv + '] 有台词缺少权重 w：' + l.t)
      }
      angryTotal += arr.length
    }
  }
  return gpt.items.length + ' 泡 / 台词 ' + lines.length + ' 句 / 生气台词 ' + angryTotal + ' 句（两角色×3 档）'
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

check('情绪素材（pet-app/assets/mood）', () => {
  const dir = path.join(ROOT, 'pet-app', 'assets', 'mood')
  assert(fs.existsSync(dir), 'pet-app/assets/mood 不存在（情绪系统需要成套素材）')
  // 每个有情绪的角色一套：<前缀>-idle.png / <前缀>-angry.png
  // 前缀来自 presets/roles.json 的角色 id（default → gpt，whale → whale）
  const EXPECT = { gpt: 'default', whale: 'whale' }
  const details = []
  for (const prefix of Object.keys(EXPECT)) {
    const pair = {}
    for (const state of ['idle', 'angry']) {
      const f = prefix + '-' + state + '.png'
      const abs = path.join(dir, f)
      assert(fs.existsSync(abs), '缺少 ' + f + '（生成见 pet-app/README.md 的素材管线说明）')
      const i = parsePng(abs)
      assert(i.sawIend && i.chunks.includes('IDAT'), f + ' 结构异常')
      const bad = i.chunks.filter((c) => !PNG_CHUNK_WHITELIST.includes(c))
      assert(!bad.length, f + ' 含非白名块：' + [...new Set(bad)].join(', '))
      const hasAlpha = i.ihdr.colorType === 6 || (i.ihdr.colorType === 3 && i.chunks.includes('tRNS'))
      assert(hasAlpha, f + ' 没有透明通道')
      pair[state] = i.ihdr.width + 'x' + i.ihdr.height
    }
    // 同角色两态必须同尺寸：否则切换时角色会跳位（生成脚本已断言，这里上锁）
    assert(pair.idle === pair.angry,
      prefix + ' 的 idle 与 angry 尺寸不一致（' + pair.idle + ' vs ' + pair.angry + '）—— 情绪切换会跳位')
    details.push(prefix + ' ' + pair.idle)
  }
  return details.join(' / ')
})

// 情绪素材的**几何一致性**断言。
//
// 这一条来自两次真实教训：
//  ① 早先用写死的裁剪窗口 (y=843) —— 那恰好是角色最顶端，呆毛与左角被切。
//  ② 后来改用「身体高度」归一化，但两态姿势不同、身体高度不可比，
//     导致小鲸鱼两态**头部宽度 462 vs 572**（差 24%）：切到生气时头像突然变大，
//     看起来就像"第二态没裁剪好"。
//
// 挂件用 object-fit:contain + object-position:right bottom，所以真正决定观感的两个量是：
//   · 画布尺寸 → 缩放比（两个状态必须同画布，否则缩放比不同）
//   · 主体相对右下角的位置 → 落点（两态都必须锚在右下角）
// 而"角色看起来多大"由**头部宽度**决定。下面这三条一起断言，才算真正守住。
function decodePngLumAlpha(abs) {
  const buf = fs.readFileSync(abs)
  let off = 8
  let ihdr = null
  const idat = []
  let trns = null
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'tRNS') trns = data
    else if (type === 'IEND') break
    off += 12 + len
  }
  assert(ihdr, 'IHDR 缺失')
  assert(!ihdr.interlace, '不支持隔行扫描 PNG')
  assert(ihdr.bitDepth === 8, '只支持 8bit PNG')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const { width, height, colorType } = ihdr
  const bpp = colorType === 6 ? 4 : (colorType === 3 ? 1 : 3)
  const stride = width * bpp
  const alpha = new Uint8Array(width * height)
  const lum = new Uint8Array(width * height)
  let prev = Buffer.alloc(stride)
  let p = 0
  const paeth = (a, b, c) => {
    const pp = a + b - c
    const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (colorType === 6) {
        alpha[i] = line[x * 4 + 3]
        lum[i] = Math.max(line[x * 4], line[x * 4 + 1], line[x * 4 + 2])
      } else if (colorType === 3) {
        const idx = line[x]
        alpha[i] = trns && idx < trns.length ? trns[idx] : 255
        lum[i] = 255
      } else {
        alpha[i] = 255
        lum[i] = Math.max(line[x * 3], line[x * 3 + 1], line[x * 3 + 2])
      }
    }
    prev = line
  }
  return { width, height, alpha, lum }
}

function contentBoxOf(img, alphaMin = 8, lumMin = 20) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = y * img.width + x
      if (img.alpha[i] > alphaMin && img.lum[i] > lumMin) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY }
}

/** 头部宽度：内容顶部 38% 高度带内的最大横向跨度（与生成脚本同一算法）。 */
function headWidthOf(img, box) {
  const hgt = box.maxY - box.minY + 1
  const yEnd = Math.min(box.maxY, box.minY + Math.max(1, Math.floor(hgt * 0.38)))
  let best = 0
  for (let y = box.minY; y <= yEnd; y++) {
    let lo = -1, hi = -1
    for (let x = box.minX; x <= box.maxX; x++) {
      const i = y * img.width + x
      if (img.alpha[i] > 8 && img.lum[i] > 20) {
        if (lo < 0) lo = x
        hi = x
      }
    }
    if (lo >= 0 && hi - lo + 1 > best) best = hi - lo + 1
  }
  return best
}

check('情绪素材几何一致（同画布 / 头宽一致 / 锚定右下角）', () => {
  const dir = path.join(ROOT, 'pet-app', 'assets', 'mood')
  const details = []
  const issues = []
  for (const prefix of ['gpt', 'whale']) {
    const imgs = {}
    for (const state of ['idle', 'angry']) {
      const abs = path.join(dir, prefix + '-' + state + '.png')
      if (!fs.existsSync(abs)) { issues.push(prefix + '-' + state + '.png 缺失'); break }
      imgs[state] = decodePngLumAlpha(abs)
    }
    if (!imgs.idle || !imgs.angry) continue

    // ① 同画布（否则挂件缩放比不同）
    if (imgs.idle.width !== imgs.angry.width || imgs.idle.height !== imgs.angry.height) {
      issues.push(prefix + ' 两态画布不一致：' +
        imgs.idle.width + 'x' + imgs.idle.height + ' vs ' + imgs.angry.width + 'x' + imgs.angry.height)
      continue
    }
    const bi = contentBoxOf(imgs.idle)
    const ba = contentBoxOf(imgs.angry)
    if (!bi || !ba) { issues.push(prefix + ' 有一态整张透明'); continue }

    // ② 头宽一致（决定"切到生气时头像会不会突然变大"）
    const hi = headWidthOf(imgs.idle, bi)
    const ha = headWidthOf(imgs.angry, ba)
    if (Math.abs(hi - ha) > 3) {
      issues.push(prefix + ' 两态头部宽度差 ' + Math.abs(hi - ha) + 'px（' + hi + ' vs ' + ha +
        '）—— 挂件里切状态时头像会缩放，看起来像"第二态没裁剪好"')
    }

    // ③ 主体锚定右下角（挂件 right bottom 对齐 ⇒ 落点才一致）
    const W = imgs.idle.width, H = imgs.idle.height
    for (const [name, b] of [['idle', bi], ['angry', ba]]) {
      const mr = W - 1 - b.maxX
      const mb = H - 1 - b.maxY
      if (mr > 1 || mb > 1) {
        issues.push(prefix + '-' + name + ' 未锚定右下角（右边距 ' + mr + ' 下边距 ' + mb +
          '）—— 两态落点会不同')
      }
    }
    details.push(prefix + ' 画布' + W + 'x' + H + ' 头宽' + hi + '/' + ha +
      ' 右下角(' + (W - 1 - bi.maxX) + ',' + (H - 1 - bi.maxY) + ')')
  }
  assert(!issues.length, issues.join('；') + '。重新生成：见 pet-app/README.md 的「情绪素材」一节')
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
