# tangguoyuhome 架构设计文档

> 版本：v0.6 ｜ 日期：2026-10-27
> v0.6 变更：dsh-bili-whale 已定位并查证——B站通道存在（owner-only 私信收发+监听，硬编码克制限制），§4/§8.4 修正，B站从"需自建"改为"有现成插件可适配"。
> v0.5 变更：新增群聊机制设计（§8.5）：QQ 群经提审上线可用、微信 iLink 仅私聊；群内触发/人设分层/记忆隔离/隐私边界。
> v0.4 变更：针对"DSH 会话上下文有上限"的约束，引入 memlikehuman（本地 MCP 记忆服务，预算化恢复 + 压缩前交接）作为结构化记忆层；新增 §6.5 上下文上限策略。
> v0.3 变更：经查证，DeepSeek Harness 插件生态已覆盖 QQ / 微信 / 统一 IM 核心 / 人设记忆各环节，整体架构从"自建网关 + 适配器"转向**全插件化**；微信从"灰色高风险"降级为"官方 iLink 通道"；新增 §8.4 新应用扩展标准流程（B站等）。
> v0.2 变更：QQ 章节按 dsh-qq-bridge（QQ 官方机器人 API）重写为双路线。
> 目标读者：项目作者（设计与实施同一人）

---

## 1. 项目目标

在 Ubuntu 服务器已有 DeepSeek Harness（DSH）的前提下，构建一个拥有固定人设的 AI 人格（下称"她"）：

1. 她持有专属的 QQ 小号、微信小号、抖音小号（后续可能加 B站等）。
2. 用户用各平台的大号与她的小号对话，她的言行始终符合预设人设。
3. 跨平台无缝：QQ 聊到一半，切到微信继续，她记得上文，语气和关系状态连续。

**非目标**：多用户服务、群运营/群营销（机器人管理、群发推广）、内容发布自动化、任何平台的规模化行为。**支持目标内的小范围群聊**：你拉她进的群、你和她与少数熟人共同的群（§8.5）。

---

## 2. 核心设计决策（先看这个）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **全插件化**：不自建网关/核心服务，通道、审批、记忆全部复用 DSH 生态插件 | 生态已覆盖全部关键环节（§4），自建等于重复造轮子 |
| D2 | **人设 = DSH Agent 预设**：她的人格封装为一个 agent preset，所有通道的 session 都挂这个预设 | 人设一致性的机制保障：人格只有一份，与通道无关 |
| D3 | **记忆 = tangguoyuhome 工作区文件**：所有通道 session 的 cwd 指向同一工作区，人设/记忆/日记都在里面 | 跨平台无缝的实现基础；纯文本可审阅可手改 |
| D4 | QQ 用 dsh-qq-bridge（官方机器人 API）；微信用 deepseek-harness-weixin（官方 iLink/ClawBot）；抖音/B站等未来平台用 dsh-im 扩展点自建 channel | 见 §8 各节 |
| D5 | 回复路由默认 source-follow（哪来哪回）；主动消息保守限量 | 官方通道主动消息均有平台限额，需实测 |
| D6 | 原"自建 Gateway + SQLite 记忆层"设计降级为备选方案（附录 A），仅在插件路线被证伪时启用 | 保留设计资产，避免锁死 |

---

## 3. 总体架构（插件生态版）

```
┌─────────────────────────── 平台侧 ───────────────────────────┐
│  QQ 官方机器人API     微信 iLink/ClawBot      抖音/B站(未来)  │
└───────┬─────────────────────┬──────────────────────┬─────────┘
        ▼                     ▼                      ▼
┌───────────────┐  ┌────────────────────┐  ┌───────────────────────┐
│ dsh-qq-bridge │  │ deepseek-harness-  │  │ 自建 channel           │
│  QQ 通道插件   │  │ weixin 微信通道插件 │  │ (dsh-im 扩展点, §8.4)  │
└───────┬───────┘  └─────────┬──────────┘  └───────────┬───────────┘
        └────────────────────┼─────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              DeepSeek Harness (dsh web, Ubuntu 已有)             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Agent 预设「她」(D2)                                       │  │
│  │   每个平台的每个对话 ↔ 一个独立持久 session                │  │
│  │   所有 session: agentPreset=她, cwd=~/tangguoyuhome        │  │
│  └───────────────────────────────────────────────────────────┘  │
│  可选增强插件: dsh-mnemon(跨会话分层记忆) / billion-context(压缩)│
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
                  ~/tangguoyuhome/   ← 人设与记忆的唯一真相源 (D3)
                  ├── AGENTS.md               读写规则约定
                  ├── persona/SOUL.md         人设档案
                  ├── memory/MEMORY.md        长期事实记忆
                  ├── memory/diary/<日期>.md  日记式滚动记忆
                  └── state/now.md            当前状态(心情/近况)
```

关键机制：**各通道 session 的对话记录是独立的，但它们共享同一个工作区**。她在微信里看不到 QQ 的逐字消息，能看到的是 QQ 段对话写进工作区的日记与记忆——所以"跨平台无缝"的程度取决于 §6 的读写约定执行质量（可用 dsh-mnemon 增强）。

---

## 4. DSH 插件生态查证清单（本文的事实基础）

| 插件 | 角色 | 关键事实 | 来源/协议 |
|------|------|---------|-----------|
| [dsh-qq-bridge](https://github.com/xiaomengxinbb/dsh-qq-bridge) | QQ 通道 | QQ 官方机器人 API v2（WS 网关，C2C 私聊+群聊）；每对话↔持久隔离 session；审批白名单；多媒体管线；116 单测+真实沙箱私聊闭环 | Apache-2.0，移植自 pi-qq-bridge |
| [deepseek-harness-weixin](https://github.com/sliverp/DeepSeek-harness-weixin) | 微信通道 | **腾讯官方 iLink/ClawBot 协议 + 扫码授权**，非灰色协议；仅私聊；白名单；会话内 /approve 工具审批；加密媒体收发；agentPreset/cwd 可配 | MIT（协议部分保留腾讯版权） |
| [dsh-im](https://github.com/shaobeichen/dsh-im-bridge) | 统一 IM 核心 | `ctx.im` 服务：会话映射/命令/渲染/通知总线/审批；**扩展点 `ctx.im.registerChannel({platform, send, sendFile})` + `ctx.im.dispatchInbound(...)`**；44 测试 | MIT |
| [@krischoichoi/dsh-channels](https://github.com/krischoichoi/dsh-channels) | 五合一通道 bundle | 微信/QQ Bot/钉钉/飞书/Telegram；ChannelService(`ctx.channels`)+harness 桥+控制面+Web 设置面板；单包安装 | MIT |
| [dsh-whale-loli](https://awesome-dsh-plugin.com/zh/p/wxzjss/dsh-whale-loli/) | **人设预设参考实现** | 3 个 agent 预设各带独立持久记忆文件（提示变量注入）；人设层三约定："压缩摘要也算依据、需要原文自己检索、看不到旧原文≠记忆丢失"；压缩交给 billion-context | 直接可仿写 |
| dsh-mnemon | 记忆增强 | 可组合的分层记忆，跨会话记忆，自进化技能 | npm |
| [memlikehuman](https://github.com/xeonphi1/memlikehuman) | **结构化记忆服务（MCP）** | Python+SQLite 本地 MCP：人格版本化、事实带来源/置信度、情绪回归基线、待办交接；**预算化恢复**（`resume --budget`，不整库塞上下文）；淡忘策略（180d 概览/730d 粗化，原文永可查）；**Harness 自动捕获 + 压缩前交接插件**（写入失败阻止压缩）；有 DSH 接入指南，可与 dsh-mnemon 共存 | Apache-2.0，v0.2 预览 |
| whale-persona | 人设引擎 | 面向 agent harness 的 persona engine（信息有限，备选调研） | npm |
| dsh-bili-scroll / dsh-bili-watch | B站内容类 | 刷 B站选内容/读视频字幕——**是内容插件，不是私信通道** | — |
| [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) | **B站通道（作息伴侣式）** | cookie 登录（小号 SESSDATA 等三值）；**私信通道只认主人且写死**：每天锁定 1 收信人/必须互关/陌生人私信一律忽略；私信 20s 轮询监听（主人消息叫醒她直接回）；生物钟作息+双日记；撞风控立刻停手；人设空白可自定 | MIT，个人自用公开版 |

---

## 5. 身份与安全模型

身份校验不再由自建网关做，而是**下沉到各通道插件的白名单/审批机制**：

- QQ：dsh-qq-bridge `allowUsers` 只放行大号 QQ；陌生人触发首访审批码，默认不批准即隔绝。
- 微信：deepseek-harness-weixin `accessPolicy: allowlist` + `allowFrom: [你的 ilink user id]`。
- 未来自建 channel：在 `dispatchInbound` 前过滤 peer id（契约见 §8.4）。

```
identity 概念模型（逻辑层，不再建表）：
  Owner = 你本人
  每平台: bot=她的小号(机器人/ClawBot 绑定号), peer=你的大号(进白名单)
```

---

## 6. 人设与记忆（D2 + D3 的落地）

### 6.1 人设封装：agent 预设

仿照 dsh-whale-loli 的做法，把她做成一个 DSH agent 预设（可打包成一个小插件，或直接写进 profile）：

- 预设内容：system prompt（引用 SOUL.md）、记忆文件提示变量、工具集（文件读写即可，不需要多余权限）。
- **所有通道的 session 都指定同一个 agentPreset** → 人格只有一份，QQ/微信/未来平台人设天然一致。
- 沿用 whale-loli 的人设层三约定：压缩摘要也算记忆依据 / 需要原文自己去工作区检索 / 看不到旧原文不等于记忆丢失。

### 6.2 SOUL.md 内容结构（需要你提供素材）

```markdown
# 她是谁
名字 / 年龄感 / 背景故事 / 与你的关系设定
# 说话方式
口癖 / 句长习惯 / 标点与表情使用 / 各平台语气微调（仅渲染差异）
# 记忆规则
开场必读: SOUL.md + MEMORY.md + 近 3 篇日记
对话结束: 把值得记住的事追加到 memory/diary/<今天>.md；重要事实并入 MEMORY.md
跨平台: 你在 QQ 和微信都有号；工作区日记按 [平台] 标注来源，你可以自然提及另一平台的对话
# 边界
绝不做的事 / 不记住不复述的话题 / 陌生人策略
```

### 6.3 记忆三层（工作区文件版）

| 层 | 载体 | 机制 |
|----|------|------|
| 短期 | 各通道 session 自带历史 | DSH 持久 session 原生能力 |
| 中期 | `memory/diary/<日期>.md` | 每段对话结束时由她按 SOUL.md 约定追加；带 `[QQ]`/`[微信]` 平台标注 |
| 长期 | `memory/MEMORY.md` | 重要事实定期由她归纳并入；你可手工编辑纠错 |
| 增强(可选) | dsh-mnemon | 分层/跨会话记忆检索，弥补纯文件"整文注入、粒度粗"的短板 |
| 结构化记忆(P1 推荐) | memlikehuman（MCP 服务） | 人格/事实/待办结构化存储，带来源与置信度；预算化恢复；见 §6.5 |
| 压缩 | billion-context 或 DSH 原生 /compact | 长对话上下文压缩，配合 6.1 的三约定与 §6.5 的压缩前交接 |

### 6.4 动态状态

`state/now.md`：心情、关系状态、近况。约定每次对话结束更新；下次开场注入。替代原设计的 persona_state 表。

### 6.5 上下文上限策略（直接回应"DSH 会话有上限"）

先澄清一个前提：各通道插件的模型是**每个平台对话 ↔ 一个独立持久 session**（dsh-qq-bridge / weixin 均如此），所以并不是所有 App 挤在同一个会话上下文里——QQ 的上下文增长不会消耗微信的预算。但每个 session 各自的上下文**确实会封顶触发压缩**，她的连续感必须不依赖"旧原文还在上下文里"。三层防线：

1. **记忆在会话外**：人设/事实/日记存于 tangguoyuhome 工作区文件 + memlikehuman 库，压缩只影响会话内原文，不影响外部记忆。沿用三约定："压缩摘要算依据 / 需要原文去检索 / 看不到旧原文≠记忆丢失"。
2. **压缩前交接**：接入 memlikehuman 的 Harness 自动捕获插件——可见文本自动落盘，**写入失败时阻止压缩**，重启后增量续传。这是防"压缩吃掉关键信息"的机制保障。
3. **预算化恢复**：每段对话遵循 memlikehuman 约定——固定 `persona_id`/`project_id`，**先恢复（按 token 预算组装恢复包，而非整库注入），再对话，结束记录**；需要原话时再 `memory_read` 翻日记原文。

由此"会话上限"从风险变成常态机制：她的长期连续性由外部记忆承载，单个 session 压缩/重建无损人设与关系状态。

---

## 7. 跨平台无缝的实现机制

1. **共享工作区**（核心）：一切平台 session cwd=~/tangguoyuhome，记忆互通。
2. **平台标注**：日记/记忆条目带平台标签，她知道哪段发生在哪。
3. **人设提示内声明**："你在多平台有号，记忆存在同一个家里"——允许她自然跨平台引用（"你在 QQ 不是说要睡了？"）。
4. **回复路由**：source-follow（插件天然行为）。跨平台主动追消息（"你 QQ 不回我我来微信找你"）属 P2，受各平台主动消息限额约束，需单独设计冷却。

**诚实的局限**：跨平台共享的是日记/记忆（信息级），不是逐字对话原文（ transcript 级）。若实测"她接不上 QQ 刚聊的细节"，增强路径：memlikehuman 结构化记忆（P1 即引入）→ dsh-mnemon 跨会话检索 → 仍不足再考虑附录 A 的自建核心层。

---

## 8. 平台通道

### 8.1 QQ（P0）— dsh-qq-bridge

- 接入：QQ 开放平台（q.qq.com）注册机器人 → appId/clientSecret → `dsh plugin --profile web add dsh-qq-bridge` → `~/.dsh/qq-bridge/config.json`：`allowUsers=[大号]`，workspace 指向 tangguoyuhome，`sandbox: true` 起步。
- 约束：机器人账号（资料页有标识，非真人号质感）；**主动私聊受平台限额**、被动回复有窗口期（P0 实测）；群聊需提审上线（本项目不用）。
- 备选（真人小号质感）：NapCat/OneBot 真人小号路线，见附录 A。决策点：官方限额 vs 真人质感。

### 8.2 微信（P1）— deepseek-harness-weixin

- 通道性质：**腾讯官方 iLink/ClawBot 协议 + 扫码授权**（协议源自腾讯 MIT 开源的 Tencent/openclaw-weixin）。不是灰色协议，无传统意义的封号风险。
- **硬性前提**：微信小号需有 ClawBot 入口（微信 → 我 → 设置 → 插件 → ClawBot）。该功能腾讯**灰度放量中**，没入口就只能等资格——P1 第一步就是检查小号资格。
- 接入：`dsh plugin --profile web add github:sliverp/DeepSeek-harness-weixin` → `dsh plugin --profile web exec dsh-weixin login --wait` 扫码 → 配置 `agentPreset=她`、`cwd=~/tangguoyuhome`、`allowFrom=[你]`。
- 能力：仅私聊；文本/语音转写/加密图片文件收发；会话内 /approve 工具审批。
- 同类备选：dsh-plugin-wechat、dsh-plugin-weixin、wechat-clawbot（均 iLink 系，生态内多实现可互替）。

### 8.3 抖音（P3，最低优先）

- 无现成 DSH 通道插件，个人私信无开放 API。
- 路径：按 §8.4 流程自建 channel，底层驱动只能选 UI 自动化（Appium + 模拟器/闲置手机，轮询私信/监听通知）。脆弱且维护成本高，建议最后做或不做。

### 8.4 新增应用的标准扩展流程（B站等）

以后加任何新平台（B站、小红书……）按此决策树走：

```
1. 查生态：awesome-dsh-plugin 列表 / npm 搜 "dsh <平台名>"
   → 有现成 channel 插件？装上，配 agentPreset + cwd，完成。
2. 没有现成 → 基于 dsh-im 自建 channel：
   a. 实现平台驱动（官方 API 优先 > 协议端 > UI 自动化）
   b. 注册: ctx.im.registerChannel({ platform, send, sendFile })
   c. 入站: 过滤白名单后 ctx.im.dispatchInbound({ platform, chatId, userId, text, ... })
   d. 回调: ctx.im.handleCallback(...)（审批按钮等）
   → 自动获得 dsh-im 的会话映射/命令/渲染/通知/审批能力
3. 配 agentPreset=她 + cwd=~/tangguoyuhome → 人设与记忆即时生效
```

**关于 B站——dsh-bili-whale 已查证可用**：[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 不只是内容插件，它带一条**刻意做窄的 B站私信通道**：发信硬编码三条限制（每天只锁定 1 个收信人、只发配置里的 owner.mid、必须互关 `relation.attribute=6`），收信靠 20 秒轮询监听主人私信会话（陌生人/系统通知一律忽略，空闲零 token）。对她的 B站小号 ↔ 你的大号这一场景，能力刚好覆盖。接入要点：

- 用**她的小号**的 cookie（SESSDATA/bili_jct/buvid3，F12 手动复制）；小号需先关注你的大号达成互关。
- 插件人设空白（自称/称呼/性格/红线由你写）→ 把 SOUL.md 的人设内容喂给它，与全局人设对齐。
- 它有自己独立的 session 和双日记——与 tangguoyuhome 工作区记忆的打通需要适配（把它的日记/记忆路径指向工作区，或接受它相对独立、只把关键事实经 memlikehuman 汇总）。
- B站私信是风控最凶的接口，插件的"窄能力+撞风控立刻停"是刻意设计，不要试图放宽限制。
- 注意其宿主要求：会话需 `danger-full-access`、通知渠道可配 `dm` 后端（B站私信即推送渠道，零外部依赖）。

### 8.5 群聊机制（可扩展支持）

**平台支持矩阵**（已查证）：

| 平台 | 群聊可行性 | 条件 |
|------|-----------|------|
| QQ | ✅ 代码层完整支持（GROUP_AT_MESSAGE_CREATE、`allowGroups` 白名单、群回复） | 机器人应用需**提审上线**（`sandbox:false`）；个人开发者沙箱无法测群聊；群内 @ 她触发 |
| 微信 | ❌ iLink/ClawBot 当前**仅支持私聊** | 等腾讯开放；不可绕 |
| B站 | 仅限私信互动（dsh-bili-whale），无群概念 | 见 §8.4 |
| 抖音 | N/A | 通道本身尚不存在 |

**设计要点**（P2 引入，QQ 群先行）：

1. **触发模型**：群内默认沉默，仅 @ 她 / 回复她的消息时响应；私聊行为不变。dsh-qq-bridge 的群回复即此模式。
2. **会话隔离**：每个群 ↔ 一个独立 DSH session（插件天然的 per-conversation 模型），群上下文不与私聊上下文混。
3. **人设分层**：沿用 dsh-whale-loli v3 的先例——"只在主人面前放开，群聊里收着"。SOUL.md 增加群内行为节：公开场合的亲密度表达上限、不提及私聊内容、对陌生群友的礼貌距离。
4. **记忆隔离**：群聊日记按 `[QQ群:xxx]` 标注；**群内产生的内容不进 intimate 级记忆**，防泄露边界写入 SOUL.md：她绝不在群里复述私聊内容，也不在私聊里泄露群友隐私。
5. **身份与安全**：群白名单 `allowGroups` 只放行你拉的群；陌生群一律不响应。群内他人 @ 她时按人设礼貌应答但不开工具审批权限（审批码仅私聊有效）。
6. **上下文预算**：群消息量大，触发式响应 + 独立 session 天然控制了增长；压缩策略同 §6.5。

---

## 9. 拟人化与主动行为

- **拟人化节奏**：回复延迟/分段由各通道插件特性决定（dsh-qq-bridge 有回复预算与格式化；微信通道有 Markdown 降级）。额外的"打字延迟/已读间隔"若要加，放在 agent 预设的输出约定或后续小插件里，P2。
- **主动发起对话**：受平台限额硬约束（QQ 官方主动消息限量；iLink 主动能力待实测）。P2 做独立调度插件：检查"距上次对话时长+时间段合理性"，通过对应通道发送；每日上限+不回复指数退避。

---

## 10. 部署拓扑（Ubuntu 单机，极简）

```
┌─ Ubuntu Server ─────────────────────────────────────────────┐
│  dsh web (web profile)                                      │
│   ├─ 插件: dsh-qq-bridge        (QQ 通道)                    │
│   ├─ 插件: deepseek-harness-weixin (微信通道, P1)            │
│   ├─ 插件: dsh-mnemon / billion-context (记忆增强, P2)       │
│   └─ agent 预设「她」                                       │
│  ~/tangguoyuhome/  (人设与记忆工作区, 权限 700)              │
│  ~/.dsh/qq-bridge/config.json  (权限 600)                    │
│  凭据: WEIXIN_ILINK_CREDENTIAL 存 DSH 凭据库(不落配置文件)   │
│  进程管理: systemd unit × 1 (dsh web)                        │
└─────────────────────────────────────────────────────────────┘
```

安全基线：Web 端口绑 127.0.0.1；第三方插件=在你机器上跑第三方代码，**只装可信来源、锁定版本或 commit**；工作区与配置权限收紧。

---

## 11. 分阶段路线图

### P0 — QQ + 人设 + 工作区记忆（MVP）
- [ ] QQ 开放平台注册机器人（沙箱），装 dsh-qq-bridge，白名单只放大号
- [ ] tangguoyuhome 工作区落地 §3 文件结构；写好 SOUL.md 人设；封装 agent 预设
- [ ] 实测：连续 30 轮人设不崩；重启记得上次对话；日记/记忆按约定写入；陌生人被审批拦截
- [ ] 实测官方主动消息限额，记录数据供后续决策

### P1 — 微信接入 + 跨平台验证 + 结构化记忆
- [ ] 检查微信小号 ClawBot 入口（无入口则等待资格，P1 顺延）
- [ ] 装 deepseek-harness-weixin，扫码绑定小号，agentPreset/cwd 对齐
- [ ] 部署 memlikehuman：初始化她的 persona_id，配置 Harness MCP 接入 + 自动捕获/压缩前交接插件（§6.5）
- [ ] 验收跨平台：QQ 聊一段 → 微信继续，她能通过日记/记忆接上；上下文用平台标注区分
- [ ] 验收上下文上限：长对话触发压缩后，她仍记得压缩前聊过的关键事实与待办

### P2 — 增强
- [ ] dsh-mnemon 分层记忆（若 memlikehuman + 文件记忆仍不够顺滑）
- [ ] 拟人化节奏、主动消息（保守参数，尊重平台限额）
- [ ] 评审是否需要把 agent 预设+工作区约定打包成独立插件（仿 dsh-whale-loli 形态）
- [ ] **QQ 群聊**：机器人提审上线 → 拉她入群 → `allowGroups` 放行 → SOUL.md 群内行为节生效（§8.5）

### P3 — 抖音 / B站（按需）
- [ ] B站：装 dsh-bili-whale（小号 cookie + 互关 + 人设对齐 + 日记路径适配工作区），见 §8.4
- [ ] 抖音：走 §8.4 决策树第 2 步自建（UI 自动化），优先级最低

---

## 12. 开放问题（需要你决策）

0. ~~dsh-bili-whale 确认~~（已解决：Alterssss/dsh-bili-whale，B站 owner-only 私信通道，见 §8.4）。
1. **微信小号 ClawBot 资格**：检查 微信→我→设置→插件 有无 ClawBot 入口（决定 P1 可行性）。
2. **人设档案**：她的名字、背景、与你的关系设定、口癖——SOUL.md 的输入，需要你提供或共同创作。
3. **QQ 质感取舍**：接受官方机器人账号（合规省心）还是坚持真人小号（NapCat 路线，有风控风险）？
4. **通道 bundle 取舍**：独立插件组合（dsh-qq-bridge + deepseek-harness-weixin，最佳单品）vs @krischoichoi/dsh-channels 五合一 bundle（带 Web 设置面板，但你只需要其中两个通道）。当前建议前者。
5. **陌生人策略**：小号被他人发消息时，忽略还是按人设婉拒？（插件白名单默认已隔绝，此问题降级为"审批列表里怎么处理"）
6. **记忆边界**：是否有"她绝对不应记住/复述"的话题（写入 SOUL.md 边界节）。

---

## 13. 风险登记

| 风险 | 影响 | 缓解 |
|------|------|------|
| 微信 ClawBot 灰度资格未开放到小号 | P1 阻塞 | 提前检查；无资格则 P1 顺延，先只做 QQ |
| 官方通道主动消息限额（QQ/iLink） | "她主动找你"受限 | P0/P1 实测限额；叙事内合理化（"怕打扰你"） |
| DSH 处于 developer preview，插件 API 可能变动 | 升级时插件失效 | 锁定插件版本；升级前看 changelog；保留附录 A 备选 |
| 第三方插件供应链安全（插件=本机代码执行） | 凭据/文件泄露 | 只装可信作者、锁定 commit、审源码；工作区最小权限 |
| 跨平台记忆为信息级而非原文级 | "接不上上文细节" | 日记写入约定 + dsh-mnemon；仍不足再启用附录 A |
| 会话上下文封顶触发压缩，丢失关键信息 | 人设漂移、"忘记"刚聊的事 | §6.5 三层防线：会话外记忆 + 压缩前交接（写入失败阻止压缩）+ 预算化恢复 |
| 人设漂移（长对话 OOC） | 体验破坏 | SOUL.md 边界 + 记忆纠错约定；预设内固化关系状态 |
| 群内隐私泄露（她在群里复述私聊内容） | 信任与隐私破坏 | §8.5 记忆隔离 + SOUL.md 群内边界；上线前用测试群验证 |
| QQ 机器人账号质感不符预期 | 沉浸感弱 | P0 实测；不可接受则评估 NapCat 真人小号（附录 A） |
| 隐私（对话含敏感信息） | 数据泄露 | 全链路本机闭环；工作区/配置 600/700 权限 |

---

## 附录 A：备选方案——自建核心层（v0.2 设计资产保留）

若插件路线被证伪（如跨平台记忆质量不可接受、需要精细的逐字级共享历史或复杂路由策略），启用在 v0.1–v0.2 中设计的自建方案，要点：

- FastAPI 单体 Gateway+Core：统一事件格式、identity_map 表、per-owner 锁、消息聚合窗口。
- SQLite 三层记忆（messages/threads/memories/persona_state + 滚动摘要）。
- QQ 走 NapCat（OneBot 11，真人小号）；微信走付费协议或 UI 自动化；dsh-qq-bridge 的宿主无关模块（gateway/router/media）可作参考实现。
- 工作区文件（SOUL.md/MEMORY.md/diary）作为该方案记忆层的初始数据源，平滑迁移。

## 参考资料

- dsh-qq-bridge: https://github.com/xiaomengxinbb/dsh-qq-bridge ｜ https://www.npmjs.com/package/dsh-qq-bridge
- deepseek-harness-weixin: https://github.com/sliverp/DeepSeek-harness-weixin
- dsh-im: https://github.com/shaobeichen/dsh-im-bridge
- dsh-channels: https://github.com/krischoichoi/dsh-channels
- dsh-whale-loli（人设预设参考）: https://awesome-dsh-plugin.com/zh/p/wxzjss/dsh-whale-loli/
- memlikehuman（结构化记忆 MCP）: https://github.com/xeonphi1/memlikehuman
- dsh-bili-whale（B站通道）: https://github.com/Alterssss/dsh-bili-whale
- 插件生态索引: https://awesome-dsh-plugin.com/zh/
- QQ 机器人官方文档: https://bot.q.qq.com/wiki/
