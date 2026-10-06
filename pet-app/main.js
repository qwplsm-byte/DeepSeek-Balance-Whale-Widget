// dsh-pet-desktop —— Electron 壳
// 一个透明、无边框、置顶的小窗口，加载本地 server 的挂件页面；
// 渲染进程在鼠标移到透明区时报上来，主进程据此开关鼠标穿透，
// 只有角色/泡泡/菜单本体接鼠标，其余全部点到桌面下层。

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron')
const path = require('path')
const { startServer } = require('./server')

let win = null
let tray = null
let port = 0

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  const width = 520
  const height = 600
  win = new BrowserWindow({
    width,
    height,
    x: wa.x + wa.width - width - 8,
    y: wa.y + wa.height - height - 8,
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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'DSniang1.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('dsh-pet 桌面宠物')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏宠物', click: () => { if (win) { win.isVisible() ? win.hide() : win.show() } } },
    { label: '设置（API Key / 演示模式）', click: () => shell.openExternal('http://127.0.0.1:' + port + '/config') },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
}

ipcMain.on('pet-mouse', (_ev, interactive) => {
  if (win) win.setIgnoreMouseEvents(!interactive, { forward: true })
})

app.whenReady().then(() => {
  startServer((err, p) => {
    if (err) { app.quit(); return }
    port = p
    createWindow()
    createTray()
  })
  app.on('activate', () => { if (!win) createWindow() })
})

app.on('window-all-closed', () => {
  // 有托盘常驻：关窗不退出，从托盘菜单退出
})
