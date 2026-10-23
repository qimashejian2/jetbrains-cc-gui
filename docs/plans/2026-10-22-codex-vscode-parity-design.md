# Codex 对齐 VS Code 官方插件改造方案

日期：2026-10-22
基准：本机 VS Code 官方插件 `openai.chatgpt-26.1007.21434-darwin-arm64`（out/extension.js 反查协议面）

## 结论先行

| # | 任务 | 现状 | 工作量 |
|---|---|---|---|
| 1 | SDK → app server | **已完成**（2026-10 已迁移），只剩残留清理 | 0.5 天（验证+清理） |
| 2 | 功能样式对齐 VS Code | 协议面缺失 6 组能力，UI 有差异 | 3-4 天 |
| 3 | 思考引导 + 分支 | 思考流已有、引导样式缺；分支完全没有 | 2-3 天 |
| 4 | 子代理展示对齐 | 已有 AgentGroupBlock（消息流内嵌），VS Code 走活动面板风格 | 1-2 天 |

总计约 7-9 个工作日，建议分四期提交。

---

## 任务 1：SDK → app server（已完成，只做收尾验证）

已验证事实：
- `ai-bridge/package.json` 无任何 codex SDK 依赖（只有 smol-toml、sql.js）
- 正常发送链路 = Java → Node daemon → `codex app-server --listen stdio://`（`persistent-codex-service.js`）
- `docs/codex/app-server.md` 是完整运行时合同，经历过 11 轮审查

残留项（可选清理）：
- `persistent-codex-service.js:116` 的 `dependencies/codex-sdk` 目录只读兼容查找
- `docs/codex/CODEX-INTEGRATION-QUICKSTART.md` 已标注为历史文档，无需再改

**动作**：跑一遍 `node channel-manager.js codex send` 冒烟 + 既有测试套件确认，然后不动。

## 任务 2：功能/样式对齐 —— 协议面差异清单

从官方 extension.js 提取的完整协议面 vs 本项目 `codex-appserver-service.js` 已实现面：

| 能力 | 官方方法 | 本项目 | 差距 |
|---|---|---|---|
| 排队发消息 | `turn/addUserMessage`、`thread/queue/{add,list,update,delete,reorder}` + `thread/queue/changed` 通知 | ❌ 无 | **全缺**。官方语义：忙碌时输入框消息进队列，turn 结束自动依次发出 |
| 运行中插话 | `turn/steer` | ❌ 无 | **全缺**。官方把 steer 归入 turn 类请求（与 start 同级） |
| 分支 | `thread/fork`、`thread/reverted` 通知 | ❌ 无 | **全缺**。UI 命令 `codex.command.forkThread`「分叉聊天」 |
| 目标/计划 | `thread/goal/{updated,cleared}`、`turn/plan/updated` | plan/updated ✅ goal ❌ | 缺 goal |
| 预测 | `thread/prediction/updated` | ❌ | 缺（低优先级） |
| 自动审批审查 | `item/autoApprovalReview/{started,completed}` | ❌ | 缺 |
| 环境连接 | `thread/environment/{connected,disconnected}` | ❌ | 缺 |
| 线程管理 | `thread/{archive,unarchive,archived,unarchived,delete,deleted,closed}` | ❌ | 缺（会话列表只有 list/read） |
| 附件 | `thread/attachment/updated` | ❌ | 缺 |
| 语音 | `thread/realtime/*` | ❌ | 不做（超范围） |

**实施路径**（按优先级）：
1. `ai-bridge/services/codex/codex-appserver-service.js`：通知分发表补齐上述方法 → 统一转成 `codex_event` NDJSON 透传给 Java
2. `src/main/java/.../CodexSDKBridge.java`：补对应 daemon 命令映射
3. `webview/`：输入框忙碌态改为「加入队列」交互（对齐 VS Code：发送即入队、显示队列条、可删除/重排）

## 任务 3：思考引导 + 分支

### 3a. 思考引导（thinking indicator）

官方行为（从 zh-CN 文案 + 协议反推）：
- 状态徽标：「正在思考」，onboarding 文案「蓝色 – 思考中」→ **蓝色 = 思考态**
- 数据源：`item/reasoning/textDelta`（原始思考流）、`item/reasoning/summaryTextDelta`/`summaryPartAdded`（摘要）

本项目现状：
- `codex-appserver-service.js` 三个 reasoning 通知**已处理** ✅
- `codex-item-projection.js:160` 已投影 `reasoning` item ✅
- `webview/src/utils/thinkingVisibility.ts` 有思考块显隐控制 ✅
- `WaitingIndicator.tsx` 有转圈+计时 ✅

差距在**样式与引导感**：
1. 思考中徽标对齐官方蓝色系动效（当前是中性 spinner）
2. 思考流折叠卡片的展开/收起交互、流式刷新节奏对齐
3. `reasoning summary` 与原始 text 的展示层级（官方优先展示 summary，raw 折叠）

改动点：`WaitingIndicator.tsx`（配色/动效）、`MessageItem` 思考块渲染、`message-service.js`（reasoning summary 优先级）。

### 3b. 分支（fork）

官方链路：
- 用户在任意消息点「分叉聊天」（`codex.command.forkThread`）
- → `thread/fork`（可带 `ephemeral` 标志）→ 新 threadId
- → `thread/reverted` 通知（原线程回退语义：`"thread/reverted":!1` 不触发重载列表）

实施路径：
1. `codex-appserver-service.js`：新增 `codex.forkThread` 命令（走独立 RPC，同 `thread/name/set` 模式，不占发送 FIFO）
2. `persistent-codex-service.js`：fork 后注册新 thread 关系（复用 `threadRelationVerified` 机制）
3. Java `CodexSDKBridge` + 会话树 UI：消息 hover 显示分叉入口
4. `webview/`：会话头部显示「从 XX 分叉」徽标；`thread/reverted` → 刷新原线程消息列表

## 任务 4：子代理展示对齐 VS Code

官方展示方式（反查结果）：
- sourceKinds 枚举：`subAgent / subAgentReview / subAgentCompact / subAgentThreadSpawn / subAgentOther`（本项目 `persistent-codex-service.js:636` 已有同款枚举 ✅）
- UI：**活动面板条目**（`subagents.activity.unnamed.ariaLabel: 子智能体`），即子代理显示为独立活动条目（名称 + 运行态），点击展开详情，不是纯内嵌工具块
- 数据：`thread/read` 读子线程（本项目 `codex-native-subagents.js` 已能读 ✅）

本项目现状：`AgentGroupBlock.tsx` 消息流内嵌卡片（2 秒轮询子线程历史）。

差距与改动：
1. 视觉：卡片头对齐官方活动条目样式（子智能体名 + spinner/完成态 + 折叠 transcript）
2. 交互：点击卡片 → 展开子线程完整 transcript（已有 `hasSubagentTranscript`，对齐官方层级）
3. `subAgentThreadSpawn` 类型（线程型子代理）在 `codex-item-projection.js` 的投影分支确认覆盖

---

## 分期与顺序

| 期 | 内容 | 依赖 |
|---|---|---|
| P1 | 任务1 收尾验证 + 协议通知透传补齐（任务2 第1步） | 无 |
| P2 | 消息队列 + steer（忙碌排队体验，用户感知最强） | P1 |
| P3 | 分支 fork + 思考引导样式 | P1 |
| P4 | 子代理展示对齐 + 线程管理（archive/delete） | P1 |

每期交付跑 `ai-bridge` 既有测试 + webview 构建 + IDEA 内手动冒烟。

## 样式对齐策略（像素级，2026-10-22 补充）

老板明确要求：**样式也要一样**，不是"风格接近"。策略：

1. **基准采集**：以本机 VS Code 官方插件为唯一视觉基准。开发时在 VS Code 里开 Codex 侧边栏，与本项目 IDEA sandbox 并排对照，逐状态截图（思考中/执行命令/等待批准/子代理运行/队列条/分叉入口）。
2. **Token 提取**：官方 webview 用 Tailwind（index.html 里有 `@layer theme, base, components, utilities`），样式 token 直接从其产物反查（css 文件 + zh-CN bundle 的类名），映射到本项目 less variables（`webview/src/styles/less/variables.less`）。
3. **逐组件对齐清单**（改哪个对哪个）：
   - 思考徽标（蓝色系动效 + "正在思考"文案 + 计时）→ `WaitingIndicator.tsx`
   - 消息气泡/间距/字号 → `MessageItem` + `message.less`
   - 输入框（发送按钮态、队列提示条）→ `ChatInputBox`
   - 子代理活动条目 → `AgentGroupBlock` / `StatusPanel`
   - 分叉入口（hover 出现）+ "从 XX 分叉"徽标 → 新增组件
4. **验收方式**：同一消息序列在两侧渲染，截图并排比对；颜色/间距用 devtools 取值，不靠目测。

## 本地调试指南（2026-10-22 补充）

三层结构，改哪层用哪套：

### 1. 前端 webview（最快迭代）
```bash
cd webview
npm run dev        # → http://localhost:5173
```
- 浏览器直开是降级模式（无 Java bridge），适合纯 UI/样式开发；有 tt-preview 页（`/tt-preview.html`）
- 样式对齐主力环境：左边浏览器改样式热更，右边 VS Code Codex 对照
- 完整构建链：`npm run build` → `copy-dist.mjs` 自动拷贝产物到 `src/main/resources/html/claude-chat.html` + `webview/assets/`

### 2. 完整插件（Java + bridge + webview 全链路）
```bash
./gradlew runIde   # 起 sandbox IDE（JBR + JCEF）
```
- 已配好：`idea.is.internal=true`（可开 internal mode）、debug 日志类别 `#com.github.claudecodegui`、`claude.bridge.path` 指向预解压的 stable-ai-bridge
- sandbox 里 webview 右键 → 检查（devtools）
- Java 断点：IDEA 里直接 debug runIde 任务

### 3. ai-bridge（Node 侧，codex 协议层）
```bash
cd ai-bridge
node --test services/codex/            # 全量测试
node services/codex/testing/codex-stdio-peer.js   # 手工对打 app-server 协议 fixture
```
- 协议开发必用 stdio-peer fixture 验证后再接真实 CLI
- daemon 手测：`node channel-manager.js codex send`

## 风险

- 官方插件是闭源打包产物，协议行为靠反查推断；`thread/fork` 参数细节（ephemeral 语义、reverted 的触发时机）需以实测为准，开发时用 `codex app-server` 手工对打验证
- `turn/steer` 需要较新版本 CLI 支持，先查本机 `codex --version` 对应能力再定实现
- queue/fork 涉及 Java 侧会话状态机改动，注意别破坏既有 settings revision 门与 FIFO 语义
- 官方 webview 闭源压缩，个别动效细节（贝塞尔曲线、时长）取值可能有偏差，以截图对照验收兜底
