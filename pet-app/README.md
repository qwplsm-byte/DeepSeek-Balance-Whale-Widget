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
| `presets/bubbles.json` | 台词队列：`gpt`（gpt娘出厂队列）、`whaleFallback`（小鲸鱼兜底）、`gptAngry` / `whaleAngry`（两角色各自的生气台词，按 1/2/3 档） |
| `presets/bubble-default-whale.json` | 上游官方默认队列，**由脚本生成，勿手改** |

```bash
npm run extract-bubbles        # 从 assets/whale-widget.js 重新抽取上游默认队列
npm run verify                 # 门禁：两侧前端一致 / 预设同步 / PNG 结构 / 素材不切边 / Key 未入库
npm run smoke                  # 冒烟：角色、台词、情绪阈值与档位、导出导入
```

台词取值优先级：**气泡编辑器存过的** > `presets/bubbles.json` > 上游抽取结果（仅小鲸鱼）。

> 为什么上游默认队列要构建期抽取：早期实现在运行时读 862 KB 的前端源码做字符串扫描，
> 上游一改写法就静默降级成"台词变少"，不报错、极难查。现在由 `tools/verify-fork.mjs`
> 断言"仓库里的快照 == 当前前端抽取结果"，不同步会在 CI 红。

## 情绪素材

每个有情绪的角色一套（`<前缀>-idle.png` / `<前缀>-angry.png`，前缀 = `presets/roles.json` 里的角色 id）：

| 前缀 | 角色 | 文件 |
|---|---|---|
| `gpt` | gpt娘（default） | `mood/gpt-idle.png` / `mood/gpt-angry.png` |
| `whale` | 小鲸鱼（whale） | `mood/whale-idle.png` / `mood/whale-angry.png` |

原图放在 `assets/mood-src/`。**统一用一条命令**（`--ref` 传运行时真正使用的 idle 图）：

```bash
python tools/make-mood-sprites.py --ref pet-app/assets/DSniang1.png \
                                  --angry pet-app/assets/mood-src/angry.jpg --prefix gpt
python tools/make-mood-sprites.py --ref pet-app/assets/ds-whale.png \
                                  --angry pet-app/assets/mood-src/whale-angry.jpg --prefix whale
```

**三个必须遵守的要点**（都踩过，各对应一次"看起来没裁剪好"）：

1. **以「运行时真正使用的 idle 图」为几何基准。** `--ref` 必须是挂件 idle 状态下实际
   取的那张图（gpt = `DSniang1.png`，whale = `ds-whale.png`）。早先拿 2048 原图当基准，
   而运行时用的是另一张成品图 —— 两套坐标系没对齐，切换时角色会缩放 + 位移。
2. **归一化依据用「头部宽度」，不要用身体高度。** 两态姿势不同（idle 紧裁胸像、angry
   常露出更多肩膀/发尾），身体高度不可比。实测小鲸鱼两态头宽 462 vs 572（差 24%）：
   切到生气时头像突然变大。改用头宽后差 0px。
3. **两态必须同画布、且主体锚定右下角。** 挂件是 `object-fit:contain` +
   `object-position:right bottom`：画布尺寸决定缩放比，主体相对右下角的位置决定落点。
   两者任一不同，切换就会跳。脚本结尾会断言「头宽一致 + 右下角一致」，不通过直接报错。

**另外两条与去黑底有关**：

- **必须在整张原图上剔气泡，最后才裁框。** 先裁框的话，气泡只剩一小段弧线、面积不到
  阈值就识别不出来 → 角色头顶会挂着半条深蓝弧线、左下留着气泡尾巴圆。
- 生气图里的**怒火标记是悬浮的**（不与角色相连），按红像素占比（实测 0.57–0.84）识别保留；
  气泡尾巴与描边残渣红占比为 0 → 丢弃。

`tools/verify-fork.mjs` 的「情绪素材几何一致」检查会独立复核这三条（**纯 JS 解码 PNG
像素**，不依赖 Python），并在输出里直接给出头宽与右边距，便于一眼看出偏了多少。

## 热重载

改完东西不用再「托盘退出 → 双击 `start-pet.bat`」。进程会监听 `server.js` / `presets/` /
`public/` / `assets/`，按代价从小到大自动处理：

| 你改了什么 | 自动行为 | 会丢状态吗 |
|---|---|---|
| `presets/*.json`（角色清单、台词池） | 重读预设 + 刷新挂件 | 不会 |
| `public/*`、`assets/*`（前端 js、角色图、情绪素材、音效） | 刷新挂件窗口（≈F5） | 不会 |
| `server.js`、`main.js`、`preload.js` | `app.relaunch()` 自动重启进程 | 不会 |

**为什么重启也不丢状态**：端口取自 `config.json`（默认恒为 37890），端口不变 ⇒ origin
不变 ⇒ localStorage 里的挂件位置 / 吸附 / 角色 / 外观设置都保留。

实现要点（都是有意选择，不是随手写的）：

- **进程侧代码用 `relaunch`，不做"热换模块"**。`main.js` 与 `server.js` 同进程，
  热换 require 缓存会让旧模块的状态（配置监听器、情绪点击计数、Codex 额度缓存）与新模块
  分叉；`relaunch` 是 Electron 自带的可靠重启。
- **不采用"关掉再 listen 同一端口"**，那样会撞 TIME_WAIT 抢占。
- **预设改成带 mtime 的惰性缓存**（原来是模块顶层 `const`，启动读一次）。
  文件没变就命中缓存、不重复读盘；变了自动重读。
- **JSON 写坏时沿用上一次成功的值**，不降级成空/兜底 —— 否则界面上会变成
  "角色突然消失、台词清空"，而这正是最难查的静默降级。
- 监听有 **300ms 防抖**（编辑器保存常触发多次事件），并忽略 `.tmp/.swp/.bak` 临时文件。

**手动入口**：托盘右键 →「立即重载（刷新挂件 + 重读预设）」/「重启（进程级）」。

测试：`node tools/test-hot-reload.mjs` —— 覆盖"改预设不重启即生效""写坏不崩""恢复后重新生效"。

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
