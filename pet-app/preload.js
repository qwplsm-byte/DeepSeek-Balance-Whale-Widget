// 鼠标位置上报：光标落在挂件本体（角色图/泡泡/菜单面板）上时关闭鼠标穿透，
// 落在透明区时开启穿透（forward:true 保证穿透期间仍能收到 move 继续判断）。
const { ipcRenderer } = require('electron')
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('mousemove', (e) => {
    const t = e.target
    const interactive = !!(t && t !== document.body && t !== document.documentElement)
    ipcRenderer.send('pet-mouse', interactive)
  }, { passive: true })
})
