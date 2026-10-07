# GPT 娘社区设定资料（网友版）

搜集时间：2026-10-07 · 来源：GitHub 公开仓库（均可达可核验）

> 萌娘百科 [AI姬](https://zh.moegirl.org.cn/AI姬) 页面存在但正文被反爬拦截、
> 知乎 403、搜索引擎不可用 —— 以下全部来自 GitHub，不是我编的。

---

## 来源一：T7moris/GPT-Niang-Usage-Widget ⭐ 最相关

**同款形象**：白发紫瞳小龙娘，看 Codex 5h/每周额度的 Windows 挂件——和本项目几乎是同一件事。

- 仓库：<https://github.com/T7moris/GPT-Niang-Usage-Widget>
- 语录 A（治愈陪伴系，20 句）：`gpt-niang-usage/assets/quotes.json`
  例：「Ciallo～ 今天也请多关照。」「先把这一小步写完吧。」「保存了吗？顺手保存一下吧。」
- 语录 B（毒舌吐槽系，13 句）：`gpt-niang-usage/assets/quote-layouts.json`
  例：「真当我是便宜货啊…」「恭喜你实现token自由！token全跑了！」「看什么余额。看我，显得比较值。」
  「检查了用户的电脑。似乎有个更弱的 agent 来过。」「你说得对。……这次是真的。」
- 排版格式：每句带 `display`（手动换行）+ `layout.fontSize`（24–32 逐句微调）
- 许可：MIT（README 明确"原创语录"）

## 来源二：JAdpp/dsh-whale-galgame ⭐ 人设结构最完整

DSH 的多角色 Galgame 插件，**6 位模型娘完整人设**定义在 `src/index.ts` 的 `ROSTER`：

| 角色 | 名字 | 主题色 | 人设一句话 |
|---|---|---|---|
| DeepSeek | 鲸鱼娘 | #7fd0ff | 深海女仆看板娘，温柔元气微毒舌，傲娇时结巴 |
| Claude | 克洛德 | #e58f65 | 琥珀文稿审校者，耐心克制，认真听完再回应 |
| **GPT** | **小吉** | #4fd1a5 | **递归编织者，聪慧活泼好奇，反应快不抢话，爱用"线、结、连接"作比喻** |
| Gemini | 双子 | #9b8cf5 | 双棱镜译者，从容细腻微电波系 |
| Kimi | 月见 | #6fc3f7 | 月卷档案官，安静可信的克制傲娇 |
| Grok | 洛可 | #25c7d9 | 宇宙信号侦察员，敏锐顽皮敢直说但不刻薄 |

**每个角色的六字段结构**（可直接抄）：
`visual 外形 / greet 首次问候 / address 对用户的称呼 / persona 性格 / tone 语气 / system 系统提示词`
外加 `affectionHigh`（好感高档语气）和按模型名自动选角的 `heroineFor()` 规则。

- 仓库：<https://github.com/JAdpp/dsh-whale-galgame>
- 其他机制：好感度 `30+15×(Lv-1)`、每 5000 token 换 1 点、24h 不活跃日衰 2 点、
  三档回复倾向（亲近+1/普通0/疏离-1）、8 种表情差分、小剧场短剧

## 来源三：MissGPT-DragonDen/gpt-miss-pet ⭐ 动画状态参考

**同款形象**：白发紫眸、弯角、叠层长裙的小龙女（就是本项目的形象气质）。

- 仓库：<https://github.com/MissGPT-DragonDen/gpt-miss-pet>
- 精灵图 1536×2288，**9 种标准动画状态**（73 帧）：
  `idle 待机呼吸眨眼 / running-right / running-left / waving 挥手 / jumping 跳跃 /
   failed 受挫 / waiting 等待 / running 工作中 / review 查看结果`
  外加 16 个视线方向帧（0°–337.5° 每 22.5°）
- **这正是本项目"动态动作"需求的现成状态机清单**
- 许可：CC0（可自由商用改写）

## 来源四：sujiu222/gpt-dragon-girl-pet

**同款形象**：「霜序」白发紫瞳 Codex 桌面龙娘，16 款皮肤/妆容（Spotify 主题、Windows 主题等）。
- 仓库：<https://github.com/sujiu222/gpt-dragon-girl-pet>

## 其他相关仓库

- [T7moris] 之外的 GPT 娘挂件：[Yasenbaka/codex-gptgirl-theme]（Codex 主题美化）
- [DKthreeFR/GPTMiniCharacter]（GPT龙娘Mini宠物）、[MissGPT-DragonDen] 上文已列
- 搜索入口：`https://api.github.com/search/repositories?q=GPT娘`（共 26 个仓库）

---

## 整合决策（本项目采用）

用户形象：白发紫瞳龙娘 GPT娘（Codex 额度挂件 + DeepSeek 小鲸鱼双角色）。
已有人设（用户自定，保留为**核心**）：一本正经胡说八道、爱列点、健忘、过度道歉、
「作为一只语言模型」口癖、与 DeepSeek 娘（直率毒舌）/Claude 娘（文艺）的反差梗。

**整合三层**：
1. **AI 口癖层**（用户原创，w=10）——形象绑定最深，一句不动地保留
2. **额度/token 层**（吸收 T7moris 毒舌系气质，w=8）——贴挂件主场景
   （T7moris 语录 MIT 许可，改写后使用；原文出处记在台词注释里）
3. **AI 娘宇宙层**（借 galgame ROSTER 的角色名扩展，w=6）——
   用户已有 DeepSeek/Claude 两句，补 Gemini/Kimi/Grok/鲸鱼娘
4. **陪伴层**（精选 T7moris 治愈系，w=6）——调节情绪节奏，2-3 句足矣

**不采用**：小吉的"编织者/线结"比喻（那是绿主题角色的绑定意象，与白发紫瞳形象不符）；
T7moris 的排版格式（本项目泡泡由代码渲染，不需要 display/fontSize 微调）。

**后续可选**（本次不做）：把"动画状态机"（来源三的 9 态）接到情绪系统上做更丰富的动态动作；
参考 galgame 六字段结构给两个角色写完整 persona/system 文档。
