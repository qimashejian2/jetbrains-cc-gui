# VS Code Codex 差异矩阵（P0 基线）

## 基线与审计范围

- 本机 VS Code 扩展为 `openai.chatgpt`，版本 `26.1007.21434`，安装目录：`/Users/daihao/.vscode/extensions/openai.chatgpt-26.1007.21434-darwin-arm64/`。版本来自其 `package.json`。
- 扩展内捆绑 CLI 为 `codex-cli 0.162.0-alpha.17.2`；当前 shell 命中的 CLI 为 `codex-cli 0.163.0-alpha.10.2`。本次分别用这两个二进制运行 `codex app-server generate-json-schema --experimental`，对比初始化、queue、steer、fork 相关定义；下表优先以扩展捆绑版本代表 VS Code 基线，同时记录当前 CLI 的字段核对结果。
- 官方协议依据：OpenAI `codex` 仓库的 [初始化协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v1.rs)、[线程与队列协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)、[回合与 steer 协议](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)、[RPC 方法注册](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)。已安装两个 CLI 的本地导出结果在这些字段上相同。
- 项目现状按本轮检查时的工作树记录。开始前已存在改动的文件包括 `ai-bridge/daemon.js`、`ai-bridge/services/codex/codex-appserver-service.js`、其测试、`ai-bridge/services/codex/persistent-codex-service.js` 和 `CodexSDKBridge.java`；本审计只读取这些改动，不将其归因于本任务。
- 只完成协议和源码静态核对，没有成功取得 VS Code 的运行态截图。CUA 报告 macOS 已锁定，因此 `docs/codex/parity-screenshots/` 未创建截图；所有涉及样式、间距、焦点和窗口状态的视觉验收均为**待实测**。

差距级别：`P0` 表示原生交互当前不可达或参数不足；`P1` 表示主要操作/状态流缺失；`P2` 表示功能已有但展示或工作流有明显差异；`宿主映射` 表示 IDE 容器不同，需映射到 JetBrains 工具窗口。验收状态只代表源码与协议检查，不代表视觉验收或运行冒烟通过。

## 功能与入口矩阵

| 对照项 | VS Code Codex 26.1007.21434 基线 | 项目现状 | JetBrains 对应入口 | 差距级别 | 验收状态与证据 |
|---|---|---|---|---|---|
| 宿主与会话入口 | Codex 作为 Activity Bar / Secondary Sidebar 中的 Webview；提供新建 Codex Agent、打开侧栏等命令。 | 通过 JetBrains 插件工具窗口承载聊天和会话；宿主栏和线程导航不是 VS Code 的 Activity Bar 结构。 | Codex 工具窗口、会话列表、新建会话命令。 | 宿主映射 / P2 | 静态确认宿主差异；布局、滚动和弹出层视觉待实测。证据：扩展 `package.json` 的 `viewsContainers` / `views` / `commands`；项目聊天由 WebView 和 JetBrains 工具窗口承载。 |
| 模型与推理强度 | Composer 可选模型和 reasoning effort；模型目录为 App Server `model/list`，队列模式是独立设置。 | 已有 `ModelSelect`、`ReasoningSelect`；Codex 模型由 App Server `model/list` 发现。 | ChatInputBox 底栏的模型与推理强度选择器。 | P2 | 功能入口静态确认；控件样式和切换反馈待视觉实测。证据：[useCliModels.ts](../../webview/src/hooks/providers/useCliModels.ts#L80)、[ModelSelect.tsx](../../webview/src/components/ChatInputBox/selectors/ModelSelect.tsx#L41)、ReasoningSelect；官方方法注册见 `model/list`。 |
| 权限与协作模式 | Composer 中可切换权限 / sandbox 和 Plan 等协作模式；生效设置由 thread/turn 原生参数承载。 | 已有 Codex 专用 `ModeSelect`；App Server 启动/更新使用 `approvalPolicy`、`approvalsReviewer`、sandbox、`collaborationMode`。 | ChatInputBox 底栏的模式选择器。 | P2 | 模式入口和原生设置静态确认；各模式禁用条件、菜单文案与 VS Code 对齐情况待视觉实测。证据：[ModeSelect.tsx](../../webview/src/components/ChatInputBox/selectors/ModeSelect.tsx#L49)、[app-server.md](./app-server.md#L126)。 |
| 工具审批与文件变更审批 | App Server 以服务端请求呈现命令、文件变更及权限审批；用户可批准、拒绝，部分请求支持会话级批准和原生建议项。 | 已有 Codex 交互请求路由、`PermissionDialog`、原生决策映射和文件差异预览；Java 以不透明 interaction key 回传原生答复。 | Codex `PermissionDialog` 模态框及其文件差异预览。 | P2 | 原生审批链路静态确认；并发审批、焦点和逐项视觉对照待实测。证据：[CodexInteractionHandler.java](../../src/main/java/com/github/claudecodegui/handler/CodexInteractionHandler.java#L134)、[PermissionDialog.tsx](../../webview/src/components/PermissionDialog.tsx#L172)、`codex-appserver-service.js` 的 server request 处理。 |
| 会话历史与恢复 | Codex 侧栏列出 thread，可打开、恢复和继续会话；历史沿原生 thread/turn/item 数据读取。 | 已有 native history 分页、opaque cursor、thread/turn/item 对账；不可用时对可离线读取的错误使用 rollout 历史回退。 | 工具窗口内的 Codex 会话历史列表与聊天记录。 | P2 | 历史读取与恢复能力静态确认；列表筛选、会话操作菜单及滚动视觉待实测。证据：[app-server.md](./app-server.md#L132)、CodexNativeHistoryReader、CodexHistoryPageIndex。 |
| 忙碌时排队、编辑和重排 | VS Code 使用原生 `thread/queue/*`；composer 上方按执行顺序展示队列项，支持全文预览、编辑、移除、拖动重排，并可从单条消息 steer 到活动回合。拖动在 6px 移动后启动。 | Codex 使用 App Server 原生队列作为状态源，支持添加、列表刷新、全文预览、更多菜单编辑、移除和拖动重排；队列项可 steer，steer 未确认时支持单项 Retry。非图片附件会明确拒绝，保留 composer 内容。拖动阈值设为 6px。队列按执行顺序显示、无序号，容器高度随视口变化。 | ChatInputBox 上方的队列列表和 composer。 | P2 | RPC 字段由 Node/Java 定向用例确认；12 个 WebView 测试文件共 173 项通过，覆盖预览、菜单、Retry、拖动与回合状态；像素视觉待实测。证据：[useCodexThreadQueue.ts](../../webview/src/hooks/useCodexThreadQueue.ts)、[MessageQueue.tsx](../../webview/src/components/ChatInputBox/MessageQueue.tsx)、[useDragSort.ts](../../webview/src/components/settings/hooks/useDragSort.ts)、[persistent-codex-service.js](../../ai-bridge/services/codex/persistent-codex-service.js)。
| 队列暂停与恢复 | 用户中断活动回合后，队列显示“因中断暂停”，可用 Resume 恢复；客户端暂停状态与 `thread/queue/start` 配合完成，协议没有单独的 pause RPC。 | 用户中断时暂停队列；Resume 通过原生 `thread/queue/start` 恢复后续提交。 | 活动会话的 composer 队列区，并在中断后提供恢复操作。 | P2 | 客户端状态和原生请求由 Node/Java 定向用例确认；样式和真实 App Server 冒烟待完成。证据：[useCodexThreadQueue.ts](../../webview/src/hooks/useCodexThreadQueue.ts)、[codex-appserver-service.js](../../ai-bridge/services/codex/codex-appserver-service.js)、[MessageQueue.tsx](../../webview/src/components/ChatInputBox/MessageQueue.tsx)。
| 回合中引导（steer） | 设置 `chatgpt.followUpQueueMode` 支持 `queue`、`steer`，默认 queue；打包配置里的旧 `interrupt` 值归一化为 steer。Cmd/Ctrl+Shift+Enter 对当前一次后续消息反转设置。composer 可直接 steer；队列项也可 steer。 | 队列项更多菜单提供可持久保存的 Queue / Steer 设置；活动回合下，默认行为分别为加入原生队列或直接调用 `turn/steer`，并绑定当前 thread 和活动 `expectedTurnId`。Cmd/Ctrl+Shift+Enter 单次反转当前设置；队列项 steer 未确认时提供单项 Retry。 | 活动 turn 的 composer 提交区、队列更多菜单及队列项操作。 | P2 | Node/Java 原生参数及归属用例已通过；本轮新增 WebView 直接 steer、快捷键和重试状态用例已通过；真实 App Server 冒烟与像素视觉待实测。证据：[useCodexThreadQueue.ts](../../webview/src/hooks/useCodexThreadQueue.ts)、[useAppChatController.ts](../../webview/src/useAppChatController.ts#L89)、[useNativeEventCapture.ts](../../webview/src/components/ChatInputBox/hooks/useNativeEventCapture.ts#L106)、[MessageQueue.tsx](../../webview/src/components/ChatInputBox/MessageQueue.tsx#L357)、[TurnSteerParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L2036)。
| 分支 / Fork | 扩展注册 `codex.command.forkThread` 和 `Fork chat` 命令；选择 thread 与历史边界后调用 `thread/fork`，得到独立 thread。协议允许 `lastTurnId` 或 `beforeTurnId` 指定历史边界，两者不能同时提供。 | 已实现已完成助手回合的消息 Fork 操作：调用 `thread/fork`、校验新 thread ID 并切换到新会话；显示新历史前继承隐私标记，映射不确定时保守遮罩。Java 等待时限为 120 秒，Webview 前端等待为 130 秒。 | Codex 助手消息的分支操作，切换到 JetBrains 新会话。 | P2 | Fork 边界、所有权与隐私继承由 Node/Java 定向用例覆盖；Java 等待时限和前端超时边界由定向测试覆盖；消息入口由 WebView 用例覆盖。真实 App Server 冒烟和像素视觉待实测。证据：[MessageItem.tsx](../../webview/src/components/MessageItem/MessageItem.tsx)、[useSessionManagement.ts](../../webview/src/hooks/useSessionManagement.ts)、[persistent-codex-service.js](../../ai-bridge/services/codex/persistent-codex-service.js)、[CodexSDKBridge.java](../../src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java)、[codex-privacy-index.js](../../ai-bridge/services/codex/codex-privacy-index.js)。
| 思考状态与计划 | VS Code composer 提供 Plan 模式；native `turn/plan/updated` 更新计划进度，回合活动由原生事件驱动；思考/推理内容仅在协议或历史实际返回时显示。 | 已有 Plan 模式、原生阶段追踪、完成计划后的执行/调整操作，以及可展开的 reasoning summary；隐藏推理文本不被展示。 | ChatInputBox 模式选择器、聊天时间线中的计划和思考区块。 | P2 | 功能组件与定向用例确认；思考中、计划更新和完成态视觉验收及运行冒烟待实测。证据：[useCodexTurnActivity.ts](../../webview/src/hooks/useCodexTurnActivity.ts)、[useCodexPlanState.ts](../../webview/src/hooks/useCodexPlanState.ts)、[ThinkingBlock.tsx](../../webview/src/components/MessageItem/blocks/ThinkingBlock.tsx)。
| 子代理展示 | VS Code 提供独立 Subagents 面板，分为 Active 与 Done；Waiting 归入 Active 并显示等待数。点击子代理可进入完整子 thread transcript，并返回分组列表。 | Codex 的 Active / Done 分组、等待数与子 thread transcript 可从聊天标题栏的 Subagents 按钮打开独立侧面板；Codex 底部状态栏仍隐藏。Claude 保持现有列表与摘要卡片。 | Codex 聊天标题栏的 Subagents 按钮和消息区侧面板。 | P2 / 宿主映射 | 标题栏入口、面板渲染与关闭有 WebView 定向用例；`AppHeader` 到 `ChatScreen` 的事件接线静态确认；面板视觉待实测。证据：[ChatHeader.tsx](../../webview/src/components/ChatHeader/ChatHeader.tsx)、[AppHeader.tsx](../../webview/src/components/AppHeader.tsx)、[ChatScreen.tsx](../../webview/src/components/ChatScreen.tsx)、[CodexSubagentsPanel.tsx](../../webview/src/components/StatusPanel/CodexSubagentsPanel.tsx)。
| Side chat | 队列更多菜单可将消息打开到独立 side chat，保持当前会话继续运行。 | 当前 JetBrains 插件只有一个活动聊天视图；新建会话会向现有活动会话发送中断信号，因此不能把该动作映射成新建会话。 | 暂无安全的独立 side chat 宿主 API。 | 宿主映射 | 明确标记为宿主能力差异，不做中断活动回合的伪映射。证据：[useSessionManagement.ts](../../webview/src/hooks/useSessionManagement.ts#L254)。
| 错误与不可用状态 | CLI、App Server、模型目录、审批和队列操作失败时应保留上下文并给出可恢复操作；unsupported/版本不支持的 native 功能不冒充成功。 | 已有 CLI 候选回退、启动 stderr 诊断、历史离线回退；队列操作失败显示错误并保留队列状态，steer 未确认失败提供单项 Retry，composer 引导失败保留草稿。 | 聊天错误卡片、CLI 状态提示、队列错误提示与恢复操作。 | P2 | Node/Java 错误路径用例已通过；本轮 WebView Retry 与草稿保留路径用例通过，真实 App Server 故障冒烟待完成。side chat 已单列为宿主映射差异。证据：[useCodexThreadQueue.ts](../../webview/src/hooks/useCodexThreadQueue.ts)、[MessageQueue.tsx](../../webview/src/components/ChatInputBox/MessageQueue.tsx)、[useSubmitHandler.ts](../../webview/src/components/ChatInputBox/hooks/useSubmitHandler.ts)。

## App Server 能力与 RPC 字段核对

### 初始化

当前和扩展捆绑 CLI 都接受 `initialize` 参数 `clientInfo` 与可选 `capabilities`。当前项目初始化发送 `capabilities: { experimentalApi: true }`，这为实验 API 方法和字段启用协商；本任务覆盖的 queue、`turn/steer` 和部分 fork 字段均属于实验协议。协议另声明 `explicitGatewayOauth`、`requestAttestation`、`mcpServerOpenaiFormElicitation`、`optOutNotificationMethods`、`extensions` 能力，本功能不要求额外设置。项目握手说明见 [app-server.md](./app-server.md#L99)，协议定义见 [InitializeCapabilities](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v1.rs)。

### Queue

| RPC | 必填字段 | 可选/结果字段 | 当前项目核对 |
|---|---|---|---|
| `thread/queue/add` | `threadId`、`input`、`clientUserMessageId` | 返回 `queuedSubmission`，其中含 `id`、`input`、`clientUserMessageId` | 受控 native request 路由携带唯一 `clientUserMessageId`；Node/Java 用例确认参数。 |
| `thread/queue/list` | `threadId` | `cursor`、`limit`；响应 `data`、`nextCursor` | 受控 native request 路由并恢复原生队列状态。 |
| `thread/queue/update` | `threadId`、`queuedSubmissionId`、`input` | 返回更新后的 `queuedSubmission` | 受控 native request 路由支持编辑队列项。 |
| `thread/queue/delete` | `threadId`、`queuedSubmissionId` | 返回是否删除 | 受控 native request 路由支持删除队列项。 |
| `thread/queue/reorder` | `threadId`、`queuedSubmissionIds` | 按新顺序提交 ID 列表 | 受控 native request 路由支持持久重排。 |
| `thread/queue/start` | `threadId` | `queuedSubmissionId` 可选 | 用户恢复暂停队列时调用，和客户端暂停状态协同。 |

扩展启用 queue 协议前会核对 App Server 版本；扩展 bundle 的版本门控含 `threadQueue` 最低版本。协议方法注册及参数见 [common.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs#L3337) 和 [thread.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L3872)。Queue 没有独立 pause RPC；暂停是客户端状态，恢复后以 `thread/queue/start` 继续。

### Steer

`turn/steer` 必须发送 `{ threadId, expectedTurnId, input }`。`expectedTurnId` 是活动回合前置条件；不匹配时服务端拒绝该请求。当前项目从活动 turn 快照取得预期 ID，经 Java native request 路由传至 App Server，并在 Node 层再次校验 thread/turn 归属。composer follow-up Queue / Steer 偏好已实现并持久保存；Cmd/Ctrl+Shift+Enter 可对当前提交单次反转偏好，composer 输入可直接 steer 活动回合。协议与归属用例见 [TurnSteerParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L2036)、[useAppChatController.ts](../../webview/src/useAppChatController.ts#L89)、[useNativeEventCapture.ts](../../webview/src/components/ChatInputBox/hooks/useNativeEventCapture.ts#L106)、`CodexAppServerRequestExecutorTest` 和 `codex-appserver-service.test.js`。

### Fork

`thread/fork` 的核心参数为必填 `threadId`，可选 `lastTurnId` 或 `beforeTurnId` 指定历史边界；`lastTurnId` 包含指定回合，`beforeTurnId` 排除指定回合及后续内容，两者不可同时传。项目从已完成助手消息提交 `threadId` 与 `lastTurnId`，校验返回的新 thread ID 后登记新写入所有权；在读取新 thread 历史前继承隐私标记，映射不确定时采取保守遮罩。协议定义见 [ThreadForkParams](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L3188)。

## 待办与视觉验收

1. Side chat 仍是宿主能力差异，当前没有可安全映射的 JetBrains 独立聊天入口，见上表；不应以新建会话代替。
2. 在真实 App Server/沙箱 IDE 中验证 queue、steer、fork 隐私继承、工具窗口重载后的状态恢复和失败路径。
3. 在 VS Code 与 JetBrains 插件可运行且屏幕解锁后，按相同窗口尺寸捕获空会话、思考、工具审批、队列编辑/暂停、steer、fork、子代理、错误等基线截图，再完成样式与焦点验收。本轮没有截图证据。
