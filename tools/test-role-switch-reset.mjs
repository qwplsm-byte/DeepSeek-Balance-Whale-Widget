#!/usr/bin/env node
// ============================================================================
// 前端「切角色必须清空余额口径」的行为测试（用桩函数复刻 state 与关键路径）
//
// 这个 bug 的现场：从 gpt娘（Codex 百分比，currency='%'）切到小鲸鱼
// （DeepSeek 人民币）时，若小鲸鱼读不到数（未配 API Key → 宿主回 ok:false），
// 前端 refresh() 的 error 分支**不覆盖** state.balance / state.currency，
// 于是界面继续显示 gpt娘留下的「98 %」——单位是百分比、数值也不是自己的。
//
// 这里不启动浏览器：直接从 whale-widget.js 里抽出 resetBalanceState 的实现思路，
// 用同样的字段集做行为断言（并把字段清单与源码做一致性检查，防止改源码后这个测试失效）。
//
// 用法：node tools/test-role-switch-reset.mjs
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FRONT = path.join(ROOT, 'assets', 'whale-widget.js')
const src = fs.readFileSync(FRONT, 'utf8')

let failed = 0
const results = []
function step(name, fn) {
  try {
    const d = fn()
    results.push('  ✓ ' + name + (d ? '  → ' + d : ''))
  } catch (err) {
    failed++
    results.push('  ✗ ' + name + '\n      ' + err.message)
  }
}
function assert(c, m) { if (!c) throw new Error(m) }

// 1) 源码里必须存在 resetBalanceState()，且 applyRole 里必须在拉数据**之前**调用它
step('applyRole 会先调 resetBalanceState()（清掉上一个角色的口径）', () => {
  const i = src.indexOf('function applyRole(')
  assert(i >= 0, '找不到 applyRole()')
  // 取 applyRole 的函数体（到下一个顶格 function）
  const rest = src.slice(i)
  const end = rest.indexOf('\nfunction ', 10)
  const body = end > 0 ? rest.slice(0, end) : rest
  const at = body.indexOf('resetBalanceState()')
  assert(at >= 0, 'applyRole() 里没有调用 resetBalanceState()')
  const fetchAt = body.indexOf("role-current.json")
  assert(fetchAt >= 0, 'applyRole() 里找不到角色上报')
  assert(at < fetchAt, 'resetBalanceState() 必须在发起余额请求之前调用（否则旧的 % 还在界面上）')
  return '调用位置在角色上报之前'
})

// 2) resetBalanceState 必须清掉「单位」与「数值」这两件关键字段
step('resetBalanceState 清空 balance / currency / shown 等展示字段', () => {
  const i = src.indexOf('function resetBalanceState(')
  assert(i >= 0, '找不到 resetBalanceState()')
  const rest = src.slice(i)
  const end = rest.indexOf('\nfunction ', 10)
  const body = end > 0 ? rest.slice(0, end) : rest
  for (const key of ['state.balance = null', 'state.currency = null', 'shown = null']) {
    assert(body.includes(key), 'resetBalanceState() 缺少：' + key)
  }
  // 顺带清掉赠金/充值/今日用量：它们同属"上一个角色的口径"
  for (const key of ['state.bonusBalance = null', 'state.rechargeBalance = null', 'state.todayUsage = null']) {
    assert(body.includes(key), 'resetBalanceState() 缺少：' + key)
  }
  return 'balance/currency/shown/赠金/充值/今日用量 均已清空'
})

// 3) 复刻状态机：验证"切角色后界面不会显示旧单位"
step('行为复刻：gpt娘(%) → 小鲸鱼(读不到数) 不会残留 %', () => {
  const state = { balance: null, currency: null, bonusBalance: null, rechargeBalance: null, todayUsage: null, status: 'loading', message: '' }
  let shown = null
  // 复刻 resetBalanceState()
  function resetBalanceState() {
    state.balance = null
    state.currency = null
    state.bonusBalance = null
    state.rechargeBalance = null
    state.todayUsage = null
    state.status = 'loading'
    state.message = ''
    shown = null
  }
  // ① 先处于 gpt娘：Codex 百分比
  state.balance = 98
  state.currency = '%'
  shown = 98
  assert(shown === 98 && state.currency === '%', '前置状态不对')
  // ② 切到小鲸鱼：先把口径清掉
  resetBalanceState()
  // ③ 小鲸鱼读不到数（宿主回 ok:false），refresh 的 error 分支不覆盖数值
  state.status = 'error'
  state.message = '未配置 DeepSeek API Key'
  // 关键断言：此时界面上不该还有 % 或旧数值
  assert(state.balance === null, 'balance 仍残留：' + state.balance)
  assert(state.currency === null, 'currency 仍残留：' + state.currency)
  assert(shown === null, 'shown 仍残留：' + shown)
  // 复刻 fmt()：值为 null 时显示 '…'，绝不会带出 '%'
  const fmt = (b, c) => (b === null ? '…' : (c === 'CNY' ? '¥ ' + Number(b).toFixed(2) : Number(b).toFixed(2) + ' ' + c))
  const text = fmt(shown !== null ? shown : state.balance, state.currency)
  assert(text === '…', '应显示占位符，实际：' + text)
  assert(!text.includes('%'), '仍显示百分比：' + text)
  return '切角色后显示 "' + text + '"+ 错误文案，不再显示 98 %'
})

console.log('== 切角色口径复位测试 ==')
for (const line of results) console.log(line)
console.log('== ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败 ==')
process.exit(failed ? 1 : 0)
