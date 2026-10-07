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
| `presets/bubbles.json` | 台词队列：`gpt`（gpt娘出厂队列）、`whaleFallback`（小鲸鱼兜底）、`gptAngry` / `whaleAngry`（两角色各自的生气台词，按 1/2/3 档）、`gptJealous` / `gptSad` / `whaleJealous` / `whaleSad`（吃醋 / 伤心态下点她的台词，扁平数组，可选）、`chatter`（主动说话） |
| `presets/talk.json` | **聊天选项 + 吃醋**：选项池、开场白、五种反应（气 / 吃醋 / 伤心 / 严肃 / 消气）的时长·动作·台词、吃醋别名表 `rivals`、LLM 人设提示词 |
| `presets/bubble-default-whale.json` | 上游官方默认队列，**由脚本生成，勿手改** |

```bash
npm run extract-bubbles        # 从 assets/whale-widget.js 重新抽取上游默认队列
npm run verify                 # 门禁：两侧前端一致 / 预设同步 / PNG 结构 / 素材不切边 / Key 未入库 / 聊天选项接线
npm run smoke                  # 冒烟：角色、台词、情绪阈值与档位、聊天选项与吃醋、LLM 回落、导出导入
```

台词取值优先级：**气泡编辑器存过的** > `presets/bubbles.json` > 上游抽取结果（仅小鲸鱼）。

> 为什么上游默认队列要构建期抽取：早期实现在运行时读 862 KB 的前端源码做字符串扫描，
> 上游一改写法就静默降级成"台词变少"，不报错、极难查。现在由 `tools/verify-fork.mjs`
> 断言"仓库里的快照 == 当前前端抽取结果"，不同步会在 CI 红。

## 情绪素材

每个有情绪的角色一套（`<前缀>-idle.png` / `<前缀>-angry.png`，前缀 = `presets/roles.json` 里的角色 id）：

| 前缀 | 角色 | 文件 |
|---|---|---|
| `gpt` | gpt娘（default） | `mood/gpt-idle.png` / `mood/gpt-angry.png`（吃醋/伤心素材待补，缺了就回落生气素材） |
| `whale` | 小鲸鱼（whale） | `mood/whale-idle.png` / `mood/whale-angry.png` |

**多态（吃醋 / 伤心 / 以后想加的任何表情）**：同一个脚本加 `--state <名字>=<原图>` 即可，可重复。
所有状态都拿**同一张 idle 基准图**归一化、贴死同一块画布的右下角 —— 这是多态之间也不跳位的前提：

```bash
# 生气（= --state angry=<图> 的简写，两种写法等价）
python tools/make-mood-sprites.py --ref pet-app/assets/DSniang1.png \
                                  --angry pet-app/assets/mood-src/angry.jpg --prefix gpt
# 吃醋（素材到手后跑这一条就自动生效，不用改代码）
python tools/make-mood-sprites.py --ref pet-app/assets/DSniang1.png --prefix gpt \
                                  --state jealous=pet-app/assets/mood-src/jealous.jpg
# 一次生成多个状态也行
python tools/make-mood-sprites.py --ref pet-app/assets/DSniang1.png --prefix gpt \
                                  --state jealous=.../jealous.jpg --state sad=.../sad.jpg
python tools/make-mood-sprites.py --ref pet-app/assets/ds-whale.png \
                                  --angry pet-app/assets/mood-src/whale-angry.jpg --prefix whale
```

缺某个状态的素材时，宿主按 `state → angry → idle → 角色图` 依次回落（`pet-app/server.js` 的
`MOOD_STATE_FALLBACK`）：**永远不会 404，也不会白屏**。补上文件即刻生效（热重载会刷新挂件）。

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
- **怒火标记两种画法都要能留**：**悬浮**的（不与角色相连）按红像素占比识别保留（实测 0.57–0.84）；
  **连在头发上**的本来就属于角色主体组件，自动跟着留下。气泡尾巴与描边残渣红占比为 0 → 丢弃。
  （换生气原图时实测过：新图的怒火标记改成贴在头发上，脚本输出与旧图的构图差异只在标记本身。）
- 气泡本身会**吃掉**落在气泡包围盒里的角色像素（`x∈[184,1629], y∈[60,988]` 那一块），
  这是剔气泡的必然代价（实测两张生气原图各损失 72110 px，位置完全一致）—— 换图后若发现
  犄角顶部被切平，先确认是不是原图里角色本来就伸进了气泡区域。

`tools/verify-fork.mjs` 的「情绪素材几何一致」检查会独立复核这三条（**纯 JS 解码 PNG
像素**，不依赖 Python），并在输出里直接给出头宽与右边距，便于一眼看出偏了多少。
多态素材（`jealous` / `sad`…）**存在就一起验**，不存在不算错。

脚本本身在结尾会断言「头宽一致 + 主体右下角一致」，任一条不过直接报错退出 ——
所以"看起来没裁剪好"这类问题会在生成阶段就拦下来，不会带到挂件上。

## 聊天选项 + 吃醋

她在挑时候弹出 **3 个可点的选项**；你选哪个，她怎么回由 `presets/talk.json` 决定。

**什么时候弹**

| 状态 | 时机 |
|---|---|
| 生气 / 吃醋 / 伤心（不高兴） | **立刻**弹（点她点过头、或刚选了一个惹到她的选项之后） |
| 正常 | **最后一次点她起 5 分钟**（`talk.idleMin`，设置页可改）没动静就弹 |
| 忙（每轮消耗 / 余额预警 / 「等待提问·授权」常驻泡 / 菜单 / 拖拽中） | 30 秒后重试，**不重置** 5 分钟基准 |

主菜单之外还有两条**互不抢占**的"自己冒泡"：主动说话（`bubbles.json` 的 `chatter`，2–5 分钟一句）
与聊天选项（5 分钟给选项）。点她 / 答完一轮都会把两个窗口一起重置。

**选项泡怎么收场**（三条出口）

| 你的动作 | 结果 |
|---|---|
| 点某个选项 | 播她对这句话的反应（继续生气 / 吃醋 / 伤心 / 严肃 / 消气），泡泡 5 秒后自动收 |
| 不理她的 90 秒（`talk.answerTimeoutMs`） | 视作**被无视** → 伤心 60 秒 |
| 点泡泡本体 | 同上（保持「点泡泡才关」的既有交互契约） |

**吃醋怎么判**（不看模型，纯规则，LLM 开着也照判）：
`choose` 时宿主拿**你选的那句话**去撞 `talk.rivals` 里的别名（大小写无关的子串匹配），
命中就**强制** `reaction=jealous`，覆盖该选项自带的反应。所以在 gpt娘 面前夸 DeepSeek（或提到
刚跟 Claude 聊完、夸 Gemini 好懂、说 Kimi 的总结更清楚）她一定吃醋。别名表就在 `rivals` 里，想加就加。

**选项为什么每次都不同**：池子 17 条（`options`，带 `when` 标注适用情绪），每轮按权重抽 3 条、
避开最近 `noRepeat`（8）条，且保证不与上一轮完全相同。同一轮里的重复
`open` 会**复用同一个 token 与同一批选项**（前端重复请求不会把屏幕上的选项换掉），
token 一次性 —— 连点同一条不会连着降两次情绪。

**加 / 改选项**：只改 `presets/talk.json` 的 `options`（字段：`id / t / when / reaction / lines / mentionsOther`）。
`verify-fork` 会双向断言「标了 `mentionsOther` 就必须真的提到某个别名」与反向、
「每个情绪态筛完至少还剩 3 条」，以及「正文不超过 `maxOptionChars`」——
防止某个状态永远弹不出选项这种静默缺陷。

**为什么正文只有 10 字（`maxOptionChars`）**：泡泡文本框是 677u × 448u，选项行字号 4（52u），
前缀「① 」还占约 2 字宽 ⇒ 12 字以内才排得下单行，超过就会折行、贴到白边。
这个上限**预设与 LLM 共用**（提示词里的 `{maxChars}` 就是它），所以接了 LLM 也不会把泡泡挤爆。
门禁把 `maxOptionChars ≤ 12` 钉死；实机验证方式是：起一份 `pet-app` 副本，用 headless 浏览器
截图看选项泡 —— 四条内容（1 句开场 + 3 个选项）必须都在白色气泡里。

## 自定义 LLM（可选）

不配就全部用 `presets/talk.json` 的预设。配了则让**你自己的模型**按人设现场生成选项与她的回话
（接口按 OpenAI 兼容约定：`POST {baseUrl}/chat/completions`）。设置页 →「自定义 LLM」。

- 配置存在本机 `config.json` 的 `llm`：`{ enabled, baseUrl, model, apiKey, timeoutMs }`。
- **绝不回显明文 Key**：`/pet-config.json` 只给 `hasKey`；保存时 `apiKey` 留空 = 不改、`null` = 清空。
- 导出备份默认**剔除** `llm.apiKey`（勾了「包含 API Key」才进 `secret.llm`），与 `dsKey` 同规则。
- 任何失败（超时 / HTTP 非 2xx / 返回不是 JSON / 选项条数或长度不合法）都**静默回落预设**，
  只在控制台留一行 warn，并在响应里把 `source` 标成 `'preset'` —— 功能永远可用。
- 人设与提示词写在 `presets/talk.json` 的 `llmPrompt`（`system` / `open` / `react`，含占位符），
  **代码里不写人设文案**。
- ⚠️ baseUrl 会收到你的 Key：只填你自己信任的地址。设置页也写了这一句。
- 「测试连接」按钮走 `/pet-test-llm`，用输入框里的值真发一次请求，把样例选项直接显示出来。

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

## 主动说话（idle chatter）

**触发语义：最后一次点击后静默 2–5 分钟（窗口内随机取点）即触发。**

- 点她一下 → 窗口重置，重新从 2 分钟起算；
- 触发时正忙（泡泡开着 / 菜单开着 / 拖拽中）→ 视为被打断，也重置窗口，绝不硬插；
- 说完 5 秒自动收起，然后排下一个窗口。

配置在 `presets/bubbles.json` 顶层：

```json
"chatter": {
  "enabled": true,      // false 即关闭
  "everyMin": 2,        // 静默窗口下限（分钟）
  "everyMax": 5,        // 静默窗口上限（实际触发点在两者间随机）
  "lines": [ { "t": "你不点我，我就自己来了", "w": 10 }, ... ]
}
```

- **词池自动合并**：队列里的随机台词（gpt 娘 27 句）+ `chatter.lines` 主动搭话专属词（14 句）；
  **不高兴时队列自动换成对应情绪的台词池**（生气按档、吃醋、伤心），所以她生气时主动开口也是生气台词。
- 触发时正忙（泡泡开着 / 菜单开着 / 拖拽中）→ 视为静默窗口被打断，重置窗口重新计时，
  绝不硬插。
- 改完 `presets/` **热重载自动生效**（前端收到新 chatter 配置后重排计时），不用重启。
- `chatter` 刻意**不放进 `config`**：config 会被气泡编辑器原样存回存档，混进去的话
  改 presets 就不再生效了。服务端在 `/dsh-whale/bubble.json` 顶层下发，前端只读。
- 与**聊天选项**（5 分钟给选项）并存、互不抢占：点她或答完一轮会把两个窗口一起重置；
  两个同时到期时选项优先。

**立刻验证**：点她一下，然后把 `everyMin`/`everyMax` 临时改成 `1`/`1`（热重载生效），
静置 1 分钟即可看到她开口。

## 备份 / 迁移

设置页底部可**导出**一个 JSON（外观、气泡、角色、开机自启、演示模式；默认不含 API Key），
在另一台机器上**导入**即可恢复。导入按字段白名单合并，无法识别的内容会被忽略。

## 开机自启

设置页勾选，或托盘菜单右键切换。两处写的是同一个字段（`config.json` 的 `autostart`），
由主进程落到系统登录项；开发态会自动带上 app 路径，避免登录后只拉起一个空 Electron。

## 安全提示（部分仍未处理，见仓库评审）

本地服务目前**不校验 Origin / Content-Type**，且 `/pet-config.json` 会回显 **DeepSeek** 的 API Key。
在把桌宠分享给别人或长期开机运行前，建议先补上写请求的来源校验与 Key 的加密存储
（对照上游 `lib/index.js` 的「仅回环 + 拒 cross-site + Origin 同源」三重栅栏）。

自定义 LLM 的 Key **不在**回显之列：`/pet-config.json` 只给 `hasKey`，保存时空值 = 不改、`null` = 清空，
导出备份默认剔除（勾选才进 `secret.llm`）。但它仍是 `config.json` 里的明文，且有出网行为 ——
**baseUrl 会收到你的 Key**，只填你自己信任的地址。
