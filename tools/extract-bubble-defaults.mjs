#!/usr/bin/env node
// ============================================================================
// 从上游前端抽取「小鲸鱼默认台词队列」（BUBBLE_DEFAULT_ITEMS）
//
// 背景：pet-app/server.js 在「小鲸鱼」角色下要下发上游官方默认队列。原实现是在
//   运行时读 862 KB 的 whale-widget.js 做 indexOf + 手写扫描器 —— 上游一旦改写法
//   （模板串 / 对象拼接 / 压缩）就会静默失败，用户只看到「台词变少了」，极难排查。
//   这里把抽取挪到构建期，结果落成 pet-app/presets/bubble-default-whale.json：
//     · server.js 只读 JSON，启动快、无解析风险；
//     · CI 跑 `--check` 断言「仓库里的 JSON == 从当前前端抽出来的结果」，
//       上游升级导致的不同步会在这里红，而不是在用户机器上静默降级。
//
// 用法：
//   node tools/extract-bubble-defaults.mjs            # 抽取并写入 JSON
//   node tools/extract-bubble-defaults.mjs --check    # 只校验是否最新（CI 用）
//   node tools/extract-bubble-defaults.mjs --print    # 打印抽取结果
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FRONT_FILE = path.join(ROOT, 'assets', 'whale-widget.js')
export const OUT_FILE = path.join(ROOT, 'pet-app', 'presets', 'bubble-default-whale.json')
const SYMBOL = 'var BUBBLE_DEFAULT_ITEMS ='

/**
 * 从源码文本里抽取 BUBBLE_DEFAULT_ITEMS 数组字面量并解析成 JS 值。
 * 扫描器正确处理：双引号字符串与转义、// 行注释、/* 块注释 *\/、嵌套方括号。
 * 上游该常量是 JSON 兼容字面量；若哪天不再是，这里会显式抛错（而不是静默返回空）。
 */
export function extractBubbleDefaults(source) {
  const at = source.indexOf(SYMBOL)
  if (at < 0) throw new Error('未找到 `' + SYMBOL + '` 声明（上游可能改了写法）')

  const start = source.indexOf('[', at)
  if (start < 0) throw new Error('`' + SYMBOL + '` 之后找不到数组字面量')

  let depth = 0
  let inStr = false
  let esc = false
  let lineComment = false
  let blockComment = false

  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]

    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++ }
      continue
    }
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue }
    if (ch === '"') { inStr = true; continue }
    if (ch === '[') { depth++; continue }
    if (ch === ']') {
      depth--
      if (depth === 0) {
        const literal = source.slice(start, i + 1)
        try {
          return JSON.parse(literal)
        } catch (err) {
          throw new Error('BUBBLE_DEFAULT_ITEMS 不再是 JSON 兼容字面量（' + err.message + '）；' +
            '请更新本脚本的解析策略，不要让它静默降级')
        }
      }
    }
  }
  throw new Error('数组字面量的方括号没有闭合（扫描到文件末尾）')
}

export function readExtracted() {
  const src = fs.readFileSync(FRONT_FILE, 'utf8')
  return extractBubbleDefaults(src)
}

function buildFile(items) {
  return {
    _说明: [
      '本文件由 tools/extract-bubble-defaults.mjs 从上游前端自动生成，请勿手改。',
      '来源：assets/whale-widget.js 的 `var BUBBLE_DEFAULT_ITEMS = [...]`（上游小鲸鱼出厂台词队列）。',
      'pet-app/server.js 在「小鲸鱼」角色下优先读它；气泡编辑器存过则以存储版本为准。',
      '上游升级后请重跑：node tools/extract-bubble-defaults.mjs（CI 会用 --check 拦住不同步）。'
    ],
    source: { file: 'assets/whale-widget.js', symbol: SYMBOL.trim() },
    count: items.length,
    items
  }
}

function main() {
  const mode = process.argv.includes('--check') ? 'check'
    : process.argv.includes('--print') ? 'print'
      : 'write'

  let items
  try {
    items = readExtracted()
  } catch (err) {
    console.error('[extract-bubble-defaults] 抽取失败：' + err.message)
    process.exit(1)
  }
  if (!Array.isArray(items) || !items.length) {
    console.error('[extract-bubble-defaults] 抽取结果不是非空数组')
    process.exit(1)
  }

  if (mode === 'print') {
    console.log(JSON.stringify(items, null, 2))
    return
  }

  if (mode === 'check') {
    let current = null
    try { current = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) } catch (err) { /* 缺失或损坏都算不同步 */ }
    const same = current && JSON.stringify(current.items) === JSON.stringify(items)
    if (!same) {
      console.error('[extract-bubble-defaults] ❌ 不同步：' + path.relative(ROOT, OUT_FILE) +
        ' 与 assets/whale-widget.js 里的 BUBBLE_DEFAULT_ITEMS 不一致')
      console.error('    修复：node tools/extract-bubble-defaults.mjs')
      process.exit(1)
    }
    console.log('[extract-bubble-defaults] ✓ 同步（' + items.length + ' 项）')
    return
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(buildFile(items), null, 2) + '\n', 'utf8')
  console.log('[extract-bubble-defaults] 已写入 ' + path.relative(ROOT, OUT_FILE) + '（' + items.length + ' 项）')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
