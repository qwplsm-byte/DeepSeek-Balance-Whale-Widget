# pet-app —— 独立桌面宠物（不依赖 DSH）

把上游 `dsh-whale-widget` 的前端（`assets/whale-widget.js`）挂在一个本地服务上，
再用 Electron 的透明置顶窗把它变成桌面宠物：**不装 DSH 也能跑**。

```
pet-app/
├── server.js            零依赖本地服务，复刻前端依赖的 /dsh-whale/* 契约
├── main.js              Electron 壳（透明窗 / 托盘 / 鼠标穿透 / 开机自启）
├── preload.js           光标是否在挂件本体上 → 主进程开关鼠标穿透
├── public/index.html    假 composer，满足挂件"宿主自检"后才初始化
├── public/config.html   设置页（额度口径 / API Key / 演示模式 / 开机自启 / 备份迁移）
├── presets/             角色与台词的唯一来源（见下）
└── assets/              角色图、音效、泡泡图、前端本体
```

## 启动

```bat
start-pet.bat        :: 首次会自动装 Electron（约 100MB，走 npmmirror 镜像）
```

或在 `pet-app/` 下：

```bash
npm install
npm start            # Electron 桌宠
node server.js       # 只起本地服务，浏览器打开打印的地址即可预览挂件
```

## 预设（单一来源）

| 文件 | 作用 |
|---|---|
| `presets/roles.json` | 角色清单：`id` / `name` / 图片文件名 / 前端取图 URL。加角色只改这里 |
| `presets/bubbles.json` | 台词队列：`gpt`（gpt娘出厂队列）、`whaleFallback`（小鲸鱼兜底） |
| `presets/bubble-default-whale.json` | 上游官方默认队列，**由脚本生成，勿手改** |

```bash
npm run extract-bubbles        # 从 assets/whale-widget.js 重新抽取上游默认队列
npm run verify                 # 门禁：两侧前端一致 / 预设同步 / PNG 结构 / Key 未入库
```

台词取值优先级：**气泡编辑器存过的** > `presets/bubbles.json` > 上游抽取结果（仅小鲸鱼）。

> 为什么上游默认队列要构建期抽取：早期实现在运行时读 862 KB 的前端源码做字符串扫描，
> 上游一改写法就静默降级成"台词变少"，不报错、极难查。现在由 `tools/verify-fork.mjs`
> 断言"仓库里的快照 == 当前前端抽取结果"，不同步会在 CI 红。

## 备份 / 迁移

设置页底部可**导出**一个 JSON（外观、气泡、角色、开机自启、演示模式；默认不含 API Key），
在另一台机器上**导入**即可恢复。导入按字段白名单合并，无法识别的内容会被忽略。

## 开机自启

设置页勾选，或托盘菜单右键切换。两处写的是同一个字段（`config.json` 的 `autostart`），
由主进程落到系统登录项；开发态会自动带上 app 路径，避免登录后只拉起一个空 Electron。

## 安全提示（尚未处理，见仓库评审）

本地服务目前**不校验 Origin / Content-Type**，且 `/pet-config.json` 会回显 API Key。
在把桌宠分享给别人或长期开机运行前，建议先补上写请求的来源校验与 Key 的加密存储
（对照上游 `lib/index.js` 的「仅回环 + 拒 cross-site + Origin 同源」三重栅栏）。
