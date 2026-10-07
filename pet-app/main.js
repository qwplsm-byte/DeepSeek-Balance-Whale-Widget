// dsh-pet-desktop —— Electron 壳
// 一个透明、无边框、置顶的小窗口，加载本地 server 的挂件页面；
// 渲染进程在鼠标移到透明区时报上来，主进程据此开关鼠标穿透，
// 只有角色/泡泡/菜单本体接鼠标，其余全部点到桌面下层。

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { startServer, readConfig, writeConfig, onConfigChanged, presetRoles, reloadPresets } = require('./server')

let win = null
let tray = null
let port = 0

// 托盘图标取自 presets/roles.json 的第一个角色（角色清单是单一来源），缺文件再回退
function roleIconPath() {
  const first = presetRoles()[0] || {}
  const name = String(first.image || 'DSniang1.png')
  return path.join(__dirname, 'assets', name)
}

function createWindow() {
  // 全工作区透明窗：挂件在页面内可拖到屏幕任何角落（挂件自己的拖动就是在视口内移动）。
  // 透明区鼠标穿透由 preload 上报 + setIgnoreMouseEvents 处理，不会挡住桌面。
  const wa = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadURL('http://127.0.0.1:' + port + '/')
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => { win = null })
}

// —— 开机自启 ——
// 唯一数据源是 config.json 的 autostart：设置页写配置 → server 触发 onConfigChanged → 这里落到系统。
// 启动时也应用一次，让"手动改过 config.json"或"配置从别的机器导过来"的情况不错位。
function applyAutostart() {
  try {
    const on = readConfig().autostart === true
    const opts = { openAtLogin: on, path: process.execPath }
    // 开发态（electron . 起）不加 app 路径的话，登录启动只会拉起一个空 Electron
    if (!app.isPackaged) opts.args = [app.getAppPath()]
    app.setLoginItemSettings(opts)
    if (tray) tray.setContextMenu(buildTrayMenu())
    return on
  } catch (err) {
    console.warn('[dsh-pet] 设置开机自启失败：' + ((err && err.message) || err))
    return false
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏宠物', click: () => { if (win) { win.isVisible() ? win.hide() : win.show() } } },
    { label: '设置（API Key / 演示模式 / 开机自启）', click: () => shell.openExternal('http://127.0.0.1:' + port + '/config') },
    { type: 'separator' },
    {
      // 热重载是自动的（改 presets/素材/前端都会自动生效，见 watchForReload）。
      // 这里只留一个手动入口：自动没触发（网络盘/编辑器原子保存）或想立刻看效果时用。
      label: '立即重载（刷新挂件 + 重读预设）',
      click: () => reloadPresetsNow('托盘菜单手动触发'),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: readConfig().autostart === true,
      // 写配置即可：writeConfig 会触发 onConfigChanged → applyAutostart() 落到系统并刷新本菜单
      click: (item) => { writeConfig({ autostart: item.checked === true }) },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

function createTray() {
  const icon = nativeImage.createFromPath(roleIconPath())
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('dsh-pet 桌面宠物')
  tray.setContextMenu(buildTrayMenu())
}

ipcMain.on('pet-mouse', (_ev, interactive) => {
  if (win) win.setIgnoreMouseEvents(!interactive, { forward: true })
})

// ============================================================================
// 热重载
// ----------------------------------------------------------------------------
// 目标：改代码/素材后不用「托盘退出 → 再双击 start-pet.bat」。分三级，代价从小到大：
//   ① public/*、assets/*（前端 js、角色图、情绪素材、音效）→ 只重新加载窗口（≈F5）
//   ② presets/*.json（角色清单、台词池）                   → 调 reloadPresets() 重读，不重启
//   ③ server.js / main.js / preload.js（进程侧代码）        → app.relaunch() 整进程重启
//
// 为什么 ③ 用 relaunch 而不是"热换模块"：本文件与 server.js 同进程，
//   热换 require 缓存会让旧模块的状态（配置监听器、情绪计数、额度缓存）与新模块分叉；
//   relaunch 是 Electron 自带的可靠重启，且端口取自 config（默认恒为 37890）——
//   端口不变 ⇒ origin 不变 ⇒ localStorage 里挂件的位置/外观设置都会保留。
//   不使用"关掉再 listen 同一个端口"，那样会遇到 TIME_WAIT 抢占。
//
// 防抖：编辑器保存常触发多次事件，300ms 内合并成一次。
const WATCH_DEBOUNCE_MS = 300
const watchState = { timer: null, pending: new Set() }

function reloadRenderer(reason) {
  if (!win) return
  console.log('[dsh-pet] 热重载：重新加载窗口（' + reason + '）')
  try { win.webContents.reloadIgnoringCache() } catch (err) { /* 窗口可能正在关 */ }
}

function reloadPresetsNow(reason) {
  try {
    const r = reloadPresets()
    console.log('[dsh-pet] 热重载：预设已重读（' + reason + '）→ 角色 ' + r.roles + ' 个')
    reloadRenderer('预设已重读')
  } catch (err) {
    console.warn('[dsh-pet] 热重载预设失败（保持运行）：' + ((err && err.message) || err))
  }
}

function relaunchApp(reason) {
  console.log('[dsh-pet] 热重载：进程侧代码已更新（' + reason + '）→ 正在自动重启')
  try {
    app.relaunch({ args: process.argv.slice(1) })
    app.exit(0)
  } catch (err) {
    console.warn('[dsh-pet] 自动重启失败，请手动重启：' + ((err && err.message) || err))
    reloadRenderer('代码已更新（需手动重启）')
  }
}

function handleChanged(files) {
  const list = [...files]
  if (!list.length) return
  // 进程侧代码：必须整进程重启才能安全生效
  if (list.some((f) => /[\\/](server|main|preload|accounting)\.(js|mjs)$/.test(f))) {
    return relaunchApp(list.map((f) => path.basename(f)).join(','))
  }
  if (list.some((f) => /[\\/]presets[\\/].*\.json$/.test(f))) return reloadPresetsNow('presets 已更新')
  // 其余（公开目录、素材）只要能刷新窗口就够
  reloadRenderer('前端/素材已更新')
}

function watchForReload() {
  const targets = [
    path.join(__dirname, 'server.js'),
    path.join(__dirname, 'main.js'),
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, 'presets'),
    path.join(__dirname, 'public'),
    path.join(__dirname, 'assets'),
  ]
  for (const t of targets) {
    try {
      if (!fs.existsSync(t)) continue
      const isDir = fs.statSync(t).isDirectory()
      fs.watch(t, { persistent: false, recursive: isDir }, (_evt, name) => {
        if (name) {
          const base = String(name)
          // 忽略噪声：临时文件、编辑器交换文件、我们的原子写临时文件
          if (/\.(tmp|swp|swx|bak)$/i.test(base) || base.startsWith('.')) return
        }
        const full = name ? path.join(t, String(name)) : t
        watchState.pending.add(full)
        if (watchState.timer) clearTimeout(watchState.timer)
        watchState.timer = setTimeout(() => {
          watchState.timer = null
          const files = [...watchState.pending]
          watchState.pending.clear()
          handleChanged(files)
        }, WATCH_DEBOUNCE_MS)
      })
    } catch (err) {
      console.warn('[dsh-pet] 无法监听 ' + t + '：' + ((err && err.message) || err))
    }
  }
  console.log('[dsh-pet] 热重载已启用：改 presets/素材会自动刷新，改 server.js 会自动重启')
}

// 单实例锁：开机自启与手动双击可能同时发生，别出现两只宠物抢同一个端口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus() }
  })

  app.whenReady().then(() => {
    onConfigChanged(() => applyAutostart())
    startServer((err, p) => {
      if (err) { app.quit(); return }
      port = p
      createWindow()
      createTray()
      applyAutostart()
      watchForReload()
    })
    app.on('activate', () => { if (!win) createWindow() })
  })

  app.on('window-all-closed', () => {
    // 有托盘常驻：关窗不退出，从托盘菜单退出
  })
}
