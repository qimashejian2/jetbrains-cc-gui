# JetBrains Codex 与 VS Code Codex 功能和界面对齐设计

日期：2026-10-22
状态：待审阅
参照基线：本机安装的 OpenAI Codex VS Code 扩展 `26.1007.21434`，以及其对应的官方 App Server 协议

## 目标

将本项目中的 Codex 使用体验改造成与 VS Code Codex 扩展一致。以官方扩展的实际功能、交互和视觉状态为验收依据；VS Code 专属的宿主操作映射到 JetBrains 中等价的文件、编辑器、会话和工具窗口能力。其他模型提供商不因 Codex 对齐而改变行为。

用户明确提出的要求：

1. Codex 通过官方 `codex app-server` 工作，不依赖 Codex SDK。
2. 排查官方扩展与本项目 Codex 功能、交互和样式的差异，并补齐适用于 JetBrains 宿主的差距。
3. 模型回合运行期间允许将消息加入队列；可对队列消息执行“引导”，把补充指令发送给仍在运行的回合；支持从已有回合创建独立分支。
4. 子代理活动的呈现方式与官方 VS Code 扩展一致。

## 当前实现核实

- Codex 正常对话已通过 Java → Node daemon → `codex app-server --listen stdio://` 通信。`ai-bridge/package.json` 没有 Codex SDK 依赖。Java `CodexSDKBridge` 保留兼容层命名，不代表运行时实例化 SDK。
- 旧 `dependencies/codex-sdk` 路径只用于兼容查找历史安装目录内的 Codex CLI；它不加载 SDK。此路径先保留，避免破坏已有 CLI 安装。
- 工作区已有未提交改动为 queue/steer 命令、通知转发和 Java bridge API 增加了部分内容，但链路不完整：这些方法调用只读 RPC 白名单，而 `thread/queue/*` 和 `turn/steer` 不在白名单中；WebView 没有对应调用入口。实施时以当前源码和 diff 为准，增量修复，不覆盖这些改动。
- 当前源码未找到 `thread/fork` 实现或分支 UI。
- 思考展示已有 reasoning 通知、可折叠思考块、计划状态和计时等待指示器；需要按官方运行状态、摘要和计划行为统一，而不是从零实现思考流。
- 子代理已有消息内 `AgentGroupBlock`、状态面板 `SubagentList` 和子线程历史读取能力。官方 IDE 体验将活动子代理放在 composer 附近并提供展开查看，当前主要差异是展示位置、状态聚合和交互。
- 当前工作区的 `docs/plans/2026-10-22-codex-vscode-parity-design.md` 是已有未跟踪文件。本设计不覆盖该文件；它的协议缺口描述以当前源码核实结果更新。

## 方案

采用在现有架构上分阶段补齐的方案：保留已建立的 App Server、Java 会话 facade、Node 常驻服务、历史投影和 IDE WebView；在既有状态机中增加原生请求和通知，再由 Codex 专属 UI 呈现。不要重写其他提供商共用的会话、权限和消息渲染层，也不要直接移植官方压缩包中的实现代码。

此方案复用已经运行的 App Server 会话和现有子线程历史读取能力，改动集中在 Codex 的请求分类、会话关系和 WebView 交互，能够避免重复维护一套 Codex 执行状态，并减少对 Claude 等提供商的回归影响。

## 协议和状态设计

### App Server 请求通道

- 保留 `readOnly()` 只承载真正只读的目录和历史请求。
- 为队列、steer、fork 等原生有状态操作提供单独的受控请求入口；使用统一的 thread、runtime generation、会话 epoch 和活动 turn 身份校验，避免旧请求影响新会话。
- `turn/steer` 必须带目标 `threadId` 和预期 `turnId`（`expectedTurnId`），只作用于用户触发时仍在运行的回合。它不进入等待该回合完成的发送 FIFO，也不通过重试自动改成新回合发送。
- `thread/queue/*` 在官方协议中属于实验接口。连接初始化启用对应能力；遇到服务端不支持、请求失败或 CLI 版本不兼容时，保留输入并显示明确错误，不静默改走 SDK 或另一种发送语义。
- 继续透传并验证 `thread/queue/changed`、回合状态、目标状态、分支和子代理相关事件。未知通知不能改变会话所有权或伪造终态。

### 排队和引导

- 当 Codex 正在执行回合时，普通发送加入 App Server 的原生队列。消息列表、编辑、删除、排序和暂停状态以原生队列为唯一事实来源；前端只维护渲染状态。
- 队列项提供官方语义的“引导”操作。触发后，通过 `turn/steer` 将该消息补充到当前活动回合，运行中的模型不被中断。Steer 成功后，根据原生队列确认结果更新该条目；失败则保留条目和文本，并显示可操作错误。
- 不允许同一条消息同时留在队列并被当作已 steer；用户重试前先读取或接收当前队列状态，以避免重复送达。
- 用户主动停止当前回合时，队列处理遵循官方扩展行为；未确认的消息必须保持可见且可恢复，不得无提示丢弃。

### 分支

- 对已完成的助手回合提供“分叉聊天”操作，以该回合为历史边界调用 `thread/fork`，创建持久的新 thread。原会话保持不变；分支结果在新 IDE 会话中打开，并出现在 Codex 历史列表中。
- 分支会话保存 `forkedFromId`、源 thread 和分叉边界，支持改名、恢复和独立后续发送。新旧 thread 的 writer 所有权、回调及 WebView 会话身份必须彼此隔离。
- 分支时，在显示新历史前继承源 thread 截止边界内的隐私遮罩分类。若无法可靠映射被复制的交互/结果身份，则对不确定内容保守遮罩，避免分支漏显已经标记的秘密答案。
- 子代理必须绑定到新分支自己的 thread 关系；分支之后的父线程或子代理内容不能串入新分支。

## 思考反馈和子代理 UI

### 思考与运行状态

- 以 App Server 事件区分思考、执行工具、等待批准、子代理工作和完成等状态，显示与官方扩展相同层级的状态提示和耗时。
- 存在原生 reasoning summary 或计划事件时展示其摘要与步骤进度；状态变化以原生事件为准，不合成模型意图或虚构进度。
- 原始思维链不是可保证的产品接口。界面只显示服务端明确提供、适合用户查看的摘要、计划和运行状态；现有思考块按官方显示优先级整理。
- 输入框忙碌期间的队列“引导”操作，是补充当前模型回合指令的主入口。

### 子代理活动

- Codex 活动子代理统一显示在 composer 上方的活动区域。每行包括稳定的子 thread 身份、名称或任务摘要、状态和必要的运行时长；多个子代理可折叠汇总。
- 点击子代理打开其线程详情/进度，使用已有 native 子线程历史查询能力。完成结果可回到主对话呈现；主对话历史和活动区域不得重复显示互相矛盾的状态。
- 仅在当前 App Server 明确支持中止子代理的协议操作时展示停止代理/停止全部操作；操作按各自 thread/turn 身份执行并显示逐项结果。
- Codex 活动展示从当前内联 `AgentGroupBlock` 和状态面板数据整理而来；通用提供商现有渲染保持不变。

## 功能差距盘点与交付阶段

完整功能清单以本机官方扩展为基准，逐项记录“官方行为、项目现状、JetBrains 映射、实现状态和验证证据”。先盘点 Codex 的会话、composer、模型与权限控制、工具和审批、历史、队列、分支、子代理及视觉状态；VS Code 专属动作映射到 JetBrains 中同等能力，不把无关的 ChatGPT 产品面误作 Codex IDE 功能。

| 阶段 | 交付内容 |
|---|---|
| P0 对照盘点 | 核对已安装官方扩展的命令、交互和典型视觉状态；建立功能矩阵与同尺寸截图基线；标明已一致、部分一致、缺失及宿主差异。 |
| P1 App Server 补齐 | 修复 queue/steer 的错误请求分类和调用链；新增 fork 请求、通知归属和分支 thread 注册；补齐能力/版本不兼容时的明确错误处理。 |
| P2 对话功能 | 完成原生消息队列、队列编辑/删除/排序、“引导”操作、消息级分支入口、分支会话历史和切换。 |
| P3 思考与子代理 | 完成原生运行状态与摘要/计划显示；将 Codex 活动子代理呈现在 composer 上方，支持展开查看和受支持的停止操作。 |
| P4 样式对齐 | 对齐消息、composer、等待状态、队列、分支入口、子代理活动和弹层状态；在相同主题、窗口尺寸和交互状态下逐项截图比对。 |

## 视觉验收标准

- 以本机 VS Code Codex 扩展 `26.1007.21434` 的同一聊天场景为唯一视觉基准，不以其他 AI 产品或临时设计为目标。
- 覆盖至少以下状态：空会话、思考中、工具运行、等待审批、普通消息完成、队列有内容、队列项引导、分支菜单/分支已打开、一个及多个子代理运行/完成、错误和不可用状态。
- 对齐整体布局、信息层级、间距、字号、颜色、图标、边框、hover/focus/disabled/展开状态和动效节奏。差异必须由 JetBrains 宿主窗口尺寸、主题或可访问性需求解释，并记录在矩阵中。
- 主题色从 IDE 与现有 CSS token 体系接入；Codex 的官方布局与控件状态不能因为共享主题而退化成另一套交互。

## 验证和风险

- Node 层使用既有 app-server stdio peer 覆盖 queue/steer/fork 的协议参数、事件先后、无活动 turn、服务端不支持、超时、断线和 generation 变化；只运行本次改动受影响的用例。
- WebView 层覆盖 busy composer、队列状态同步、steer 确认/失败、fork 后会话隔离、子代理状态变化和 Codex/其他 provider 隔离；构建受影响的前端目标。
- 在 JetBrains sandbox IDE 内进行 App Server 冒烟，确认真实 CLI 兼容、分支历史、隐私遮罩、子代理读取及工具窗口重载后的状态恢复。UI 样式以同场景截图比对验收。
- `thread/queue/*` 属于实验协议，需兼容不同 CLI 版本；不得把 `UNSUPPORTED` 当成功或静默降级。
- Fork 增加 thread 所有权、历史和隐私分类复制边界；必须在加载分支内容前建立可靠映射并通过敏感交互的分支验证。
- 官方 VS Code 扩展提供的是本机安装的打包基准，而非可复用的源码；项目独立实现功能和样式，不复制其打包实现。

## 官方参考

- [Codex App Server 文档](https://developers.openai.com/codex/app-server)
- [Codex IDE 扩展文档](https://developers.openai.com/codex/ide)
- [Codex 子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI Codex App Server 协议定义](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)
- [OpenAI Reasoning 指南](https://developers.openai.com/api/docs/guides/reasoning)
