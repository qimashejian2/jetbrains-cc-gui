# Codex VS Code 功能与界面对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans task by task. Each action uses checkbox syntax.

**Goal:** 以本机 VS Code Codex 扩展 26.1007.21434 为基准，补齐本项目 Codex 的 App Server 请求、队列与回合引导、分支、思考状态、子代理展示和可见交互差距。

**Architecture:** 保留 Java 会话桥接、Node 常驻 App Server 服务和 WebView 聊天架构。先将有状态 App Server 请求从只读请求通道分离，再通过现有 Java/WebView 桥接接入原生队列、steer 和 fork；最后按 Codex 专属状态组件完成交互和视觉对齐。Claude 与其他提供商继续使用现有通用队列和渲染路径。

**Tech Stack:** Java 17、Gradle、Node.js ESM、Codex App Server stdio JSON-RPC、React、TypeScript、Vite、Vitest、Node built-in test runner、IntelliJ Platform Plugin SDK。

**Spec:** [docs/superpowers/specs/2026-10-22-codex-vscode-parity-design.md](../specs/2026-10-22-codex-vscode-parity-design.md)

## 全局约束

- 参照基线为本机安装的 OpenAI Codex VS Code 扩展 26.1007.21434。
- Codex 正常对话通过官方 codex app-server 工作；不添加 Codex SDK 依赖。
- 其他模型提供商不因 Codex 对齐而改变行为。
- thread/queue/* 属于实验协议；服务端不支持或调用失败时必须保留输入并给出明确错误，不得静默降级。
- turn/steer 必须绑定触发时正在运行的 thread 和预期 turn；失败不能自动重发到后续回合。
- 原始思维链不是可保证的产品接口；只展示服务端明确提供、适合用户查看的摘要、计划和运行状态。
- 分支加载历史前必须继承可映射的隐私遮罩分类；无法可靠映射时对不确定内容保守遮罩。
- 保留工作区现有未提交改动；修改已有脏文件前读取完整相关 diff，按现有内容增量修改。

---

## 文件与职责地图

| 文件 | 职责 |
|---|---|
| docs/codex/vscode-parity-matrix.md | 记录 VS Code 基准、JetBrains 宿主映射、差异、证据和验收状态。 |
| ai-bridge/services/codex/codex-appserver-service.js | App Server RPC 分类、thread 归属、回合身份和通知转发。 |
| ai-bridge/services/codex/persistent-codex-service.js | 每个持久会话的 queue、steer、fork 入口及活动 turn 校验。 |
| ai-bridge/daemon.js | 将队列、steer、fork 请求路由到独立于只读请求的 Node 服务入口。 |
| ai-bridge/services/codex/codex-appserver-service.test.js | App Server 请求/通知行为测试，使用现有 stdio peer。 |
| ai-bridge/services/codex/persistent-codex-service.test.js | 持久服务对活动 turn、队列和分支的状态测试。 |
| ai-bridge/services/codex/codex-privacy-index.js | 分支隐私分类的边界复制和并发安全写入。 |
| ai-bridge/services/codex/codex-privacy-index.test.js | 分支分类继承、截止 turn 和保守遮罩测试。 |
| src/main/java/com/github/claudecodegui/provider/codex/CodexAppServerRequestExecutor.java | 非阻塞 native RPC 的 daemon 命令执行。 |
| src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java | 保持兼容 facade 命名，提供 queue、steer、fork 的 Java API。 |
| src/main/java/com/github/claudecodegui/handler/CodexNativeDataHandler.java | 处理 queue 查询和变更请求，并关联异步结果。 |
| src/main/java/com/github/claudecodegui/handler/CodexInteractionHandler.java | 处理 steer 和 fork 等 Codex 交互命令。 |
| src/main/java/com/github/claudecodegui/provider/codex/CodexThreadOwnerRegistry.java | 为 fork 后的新 thread 建立独立 writer 所有权。 |
| src/main/java/com/github/claudecodegui/provider/codex/CodexHistoryPrivacy.java | Java 历史投影读取继承后的分支遮罩分类。 |
| src/test/java/com/github/claudecodegui/provider/codex/CodexSDKBridgeCommandTest.java | 验证 daemon 命令名称、参数与错误回传。 |
| src/test/java/com/github/claudecodegui/provider/common/CodexDaemonTransportIntegrationTest.java 与 src/test/java/com/github/claudecodegui/provider/common/CodexFixtureDaemon.java | 验证 Java 到 Node daemon 的原生请求路由和异步结果传输。 |
| src/test/java/com/github/claudecodegui/provider/codex/CodexHistoryPrivacyTest.java | 验证分支历史在遮罩后才进入显示和缓存。 |
| webview/src/hooks/useCodexThreadQueue.ts | Codex 原生队列状态、同步、steer 和失败保留策略。 |
| webview/src/hooks/useCodexThreadQueue.test.ts | 原生队列 UI 状态和请求竞争测试。 |
| webview/src/hooks/useCodexTurnActivity.ts | Codex turn 身份、运行阶段和耗时状态。 |
| webview/src/components/ChatInputBox/ChatInputBox.tsx | 将 Codex 原生队列接入 composer 布局。 |
| webview/src/components/ChatInputBox/MessageQueue.tsx | 显示原生队列并提供引导、编辑、删除、排序操作。 |
| webview/src/components/ChatInputBox/styles/banners.css | 现有消息队列样式；新增 steer 状态并接入 IDE 主题变量。 |
| webview/src/components/StatusPanel/StatusPanel.tsx、webview/src/components/StatusPanel/SubagentList.tsx 与 webview/src/components/StatusPanel/StatusPanel.less | 在 StatusPanel 按 Active / Done 展示 Codex 子代理，Waiting 计入 Active，并展开子 thread 历史。 |
| webview/src/components/MessageItem/MessageItem.tsx | 为可分支的已完成助手回合显示分支操作。 |
| webview/src/components/MessageItem/MessageActionButtons.tsx | 按 VS Code 行为排列消息级分支操作。 |
| webview/src/components/MessageItem/blocks/ThinkingBlock.tsx | 显示可公开的 reasoning summary 与思考完成状态。 |
| webview/src/components/WaitingIndicator.tsx | 显示当前 Codex 原生回合状态和运行耗时。 |
| webview/src/useAppChatController.ts | 仅在 Codex 忙碌时路由到 App Server 原生队列。 |
| webview/src/components/ChatScreen.tsx | 将当前 thread、turn 和子代理状态传递到 composer。 |
| webview/src/global.d.ts | 声明新增的 Codex WebView bridge 事件载荷。 |
| webview/src/i18n/locales/en.json、webview/src/i18n/locales/zh.json | 为新增队列、引导、分支与子代理控件提供文案。 |
| webview/src/styles/less/components/message.less、webview/src/components/ChatInputBox/styles/banners.css 与 webview/src/components/StatusPanel/StatusPanel.less | 将思考、队列、分支和子代理状态接入现有主题变量。 |

本计划按一个端到端功能交付：App Server 原生请求是队列、引导和分支 UI 的共同前置条件；状态与视觉验收依赖这些真实数据，因此不拆成互不完整的并行计划。

### Task 1：建立官方基线和差异矩阵

**Files:**
- Create: docs/codex/vscode-parity-matrix.md
- Reference: docs/superpowers/specs/2026-10-22-codex-vscode-parity-design.md
- Reference: 本机安装的 VS Code Codex 扩展 26.1007.21434

**Interfaces:**
- Produces: 一份矩阵；每行包含功能、VS Code 行为、项目现状、JetBrains 映射、证据、差距级别和验收状态。
- Consumes: 设计稿中空会话、思考中、工具运行、等待审批、队列、steer、fork、子代理、错误状态的视觉验收集合。

- [x] **Step 1：核对官方 Codex 命令、菜单、composer 和运行态。** 覆盖模型与权限控制、工具审批、历史、队列编辑/暂停、分支、思考状态、子代理和错误状态；对宿主专属动作写出 JetBrains 对应入口，并记录当前 CLI 的 App Server 初始化能力字段与 queue/fork RPC 参数。
- [x] **Step 2：核对当前实现并填入证据。** 对每行标记一致、部分一致、缺失或宿主映射，附当前源码路径或截图状态；当前已知的 read-only queue/steer 缺口和缺失 fork 必须单独列行。
- [ ] **Step 3：记录同尺寸视觉基线。** 对照空会话、思考中、工具运行、审批、普通完成、队列、引导、分支、单个/多个子代理、错误及不可用状态；登记主题、窗口尺寸、展开状态，截图存入 docs/codex/parity-screenshots/ 并在矩阵中链接。
- [x] **Step 4：确认实现范围闭合。** 将所有不一致且适用于 JetBrains 的行关联到本计划的后续任务；若模型、权限、工具、审批或历史等行出现 Task 2–8 未覆盖的功能缺口，先在本计划添加列明文件、接口、验证命令的独立任务，再开始相关代码修改；宿主差异必须写明等价映射和验收证据，不留下未归类差距。

### Task 2：建立独立的 App Server 原生请求通道

**Files:**
- Modify: ai-bridge/services/codex/codex-appserver-service.js
- Modify: ai-bridge/services/codex/persistent-codex-service.js
- Modify: ai-bridge/services/codex/codex-appserver-service.test.js
- Modify: ai-bridge/services/codex/persistent-codex-service.test.js

**Interfaces:**
- Produces: CodexAppServerService.nativeRequest(method, params, options)；只接受 queue、steer 与 fork 的受控方法。
- Produces: 持久服务的 queue 方法通过 nativeRequest 调用原生接口。
- Produces: codexSteerPersistent 在活动 operation 中取出 turnId，并发送 turn/steer 参数 { threadId, expectedTurnId, input }。
- Consumes: 现有 runtimeGeneration、thread relation、活动 operation 和 Codex stdio peer。

- [x] **Step 1：给 App Server 服务测试增加请求分类用例。** 使用 codex-appserver-service.test.js 的 stdio peer 验证 thread/queue/list 经 nativeRequest 成功、thread/queue/list 仍被 readOnly 拒绝、未知写方法以 UNSUPPORTED 拒绝。
- [ ] **Step 2：运行 Node 定向用例确认失败。** 在 ai-bridge 目录运行 node --test services/codex/codex-appserver-service.test.js；新增用例必须先因 nativeRequest 或预期请求路由缺失而失败。本轮未保留实现前的失败运行记录。
- [x] **Step 3：实现 nativeRequest。** 单独维护 thread/queue/add、thread/queue/list、thread/queue/update、thread/queue/delete、thread/queue/reorder、thread/queue/start、turn/steer、thread/fork 的受控方法集合；暂停是客户端状态，恢复使用 thread/queue/start；客户端在 initialize 中声明 experimentalApi，方法是否受支持以服务端响应为准，-32601 映射为 UNSUPPORTED；调用前确认 runtime 存活、thread 归属和 generation，响应保留原始 JSON-RPC 结果；readOnly 的允许列表保持只读。
- [x] **Step 4：实现活动 turn steer。** codexSteerPersistent 只从当前 session 的活动 operation 获取 threadId 和 turnId；thread 不匹配、无活动 turn、缺 runtime 时分别返回可识别错误；native 请求携带 expectedTurnId，不排队、不自动重试。
- [x] **Step 5：修正持久队列方法。** 现有 codexQueueAddPersistent、codexQueueListPersistent、codexQueueUpdatePersistent、codexQueueDeletePersistent、codexQueueReorderPersistent、codexQueueStartPersistent 改为调用 nativeRequest；保留参数校验和输入内容，不再转入 readOnly。
- [x] **Step 6：验证通知归属和能力降级。** 确认 thread/queue/changed 只转发给其 thread 的拥有会话；未知通知不能改变所有权或伪造终态；不支持的方法由服务端 -32601 映射为 UNSUPPORTED，不能静默回退。
- [x] **Step 7：覆盖拒绝、超时和 runtime 切换。** persistent-codex-service.test.js 覆盖无 thread、空 input、无活动 turn、thread 不匹配、CLI 不支持方法、超时和 runtime generation 改变；失败结果必须包含稳定错误码且不改变队列文本。
- [x] **Step 8：运行 Node 定向用例。** 在 ai-bridge 目录运行 node --test services/codex/codex-appserver-service.test.js services/codex/persistent-codex-service.test.js；所有新旧断言通过，readOnly 白名单不包含 queue、steer 或 fork。

### Task 3：打通 daemon、Java bridge 和 WebView 消息协议

**Files:**
- Modify: ai-bridge/daemon.js
- Modify: ai-bridge/services/codex/persistent-codex-service.js
- Modify: ai-bridge/services/codex/persistent-codex-service.test.js
- Modify: src/main/java/com/github/claudecodegui/provider/codex/CodexAppServerRequestExecutor.java
- Modify: src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java
- Modify: src/main/java/com/github/claudecodegui/handler/CodexNativeDataHandler.java
- Modify: src/main/java/com/github/claudecodegui/handler/CodexInteractionHandler.java
- Modify: src/test/java/com/github/claudecodegui/provider/codex/CodexSDKBridgeCommandTest.java
- Modify: src/test/java/com/github/claudecodegui/provider/codex/CodexAppServerRequestExecutorTest.java
- Modify: src/test/java/com/github/claudecodegui/provider/common/CodexDaemonTransportIntegrationTest.java
- Modify: src/test/java/com/github/claudecodegui/provider/common/CodexFixtureDaemon.java

**Interfaces:**
- Produces: CodexAppServerRequestExecutor.sendNativeCommand(daemon, method, params, timeoutMs)；独立于 sendReadOnlyCommand。
- Produces: CodexSDKBridge.queueCodexMessage、listCodexQueue、mutateCodexQueue、startCodexQueue、steerCodexTurn 和 forkCodexThread 的 App Server 实现；queue/add 使用来自 WebView 的稳定 clientUserMessageId。
- Produces: WebView 请求 codex_queue_action，载荷含 requestId、action、threadId、turnId 和 action 参数；Java 结果通过 codex-queue-result 事件返回 requestId、result 或 error。
- Consumes: Task 2 的 daemon command 名称 codex.queueAdd/list/update/delete/reorder/start、codex.steer 和 codex.fork。

- [x] **Step 1：为 daemon 路由新增断言。** 验证 codex.queueAdd/list/update/delete/reorder/start 路由到对应持久服务方法，codex.steer 独立于正在等待 codex.send 的 FIFO，codex.fork 路由到 fork 服务；只读命令白名单不得接收以上方法。
- [x] **Step 2：实现 daemon 路由。** 从 readOnlyCodexMethods 移出所有 queue 命令，新增受控 native thread command 路由；保留 codex.steer 控制命令的异步应答，并为 codex.fork 返回 requestId 对应结果。
- [x] **Step 3：给 Java executor 增加 native command 测试。** 验证请求方法、threadId、expectedTurnId、input、超时及 Node 返回错误码都能原样传递；命令执行不能等待 codex.send 完成。
- [x] **Step 4：实现 Java native command executor 和 bridge API。** queue 与 fork API 使用 sendNativeCommand；steer 使用独立控制请求并保留 Node 返回的 error code；readCodexNative 继续只承载已有只读命令。
- [x] **Step 5：接入 WebView 请求和结果事件。** CodexNativeDataHandler 处理 queue 的 list/add/update/delete/reorder/start；CodexInteractionHandler 处理 steer/fork；每个异步响应携带同一 requestId，WebView 通过 codex-queue-result 收到一次成功或失败结果。两个 handler 均拒绝缺少稳定 requestId 的操作，fork 必须带 lastTurnId 边界。
- [ ] **Step 6：运行 Java 定向用例。** 运行 ./gradlew test --tests com.github.claudecodegui.provider.codex.CodexSDKBridgeCommandTest --tests com.github.claudecodegui.provider.codex.CodexAppServerRequestExecutorTest --tests com.github.claudecodegui.provider.common.CodexDaemonTransportIntegrationTest；主源码 `compileJava` 通过，测试未能进入执行阶段：缺少 junit:junit:4.13.2，仓库配置的 maven.aliyun.com 域名 DNS 解析失败。Node 定向测试另行通过。

### Task 4：将 Codex composer 接入原生队列与回合引导

**Files:**
- Create: webview/src/hooks/useCodexThreadQueue.ts
- Create: webview/src/hooks/useCodexThreadQueue.test.ts
- Create: webview/src/hooks/useCodexActiveTurnId.ts
- Create: webview/src/hooks/useCodexActiveTurnId.test.ts
- Modify: webview/src/useAppChatController.ts
- Modify: webview/src/hooks/useMessageSender.ts
- Modify: webview/src/components/ChatScreen.tsx
- Modify: webview/src/components/ChatInputBox/ChatInputBox.tsx
- Modify: webview/src/components/ChatInputBox/ChatInputBoxHeader.tsx
- Modify: webview/src/components/ChatInputBox/types.ts
- Modify: webview/src/components/ChatInputBox/hooks/useChatInputController.ts
- Modify: webview/src/components/ChatInputBox/hooks/useSubmitHandler.ts
- Modify: webview/src/components/ChatInputBox/ChatInputBox.test.tsx
- Modify: webview/src/components/ChatInputBox/MessageQueue.tsx
- Modify: webview/src/components/ChatInputBox/styles/banners.css
- Modify: webview/src/App.tsx
- Modify: webview/src/global.d.ts
- Modify: webview/src/i18n/locales/en.json
- Modify: webview/src/i18n/locales/zh.json

**Interfaces:**
- Produces: useCodexThreadQueue({ threadId, turnId, active }) 返回 { queue, refresh, enqueue, steer, update, remove, reorder, resume, error }；enqueue 接收与正常 Codex 发送相同的文本/附件输入项。
- Produces: queue 的数据以 App Server queue/list 与 thread/queue/changed 为准；optimistic state 仅用于等待确认的按钮状态。
- Consumes: Task 3 的 codex_queue_action 请求和 codex-queue-result 结果事件。
- Consumes: 现有 useMessageQueue 只负责非 Codex 提供商，不改变其自动 drain 行为。

- [x] **Step 1：为新 hook 编写状态测试。** 验证 thread 切换立即清空旧队列视图并请求新列表；queue/changed 替换 native snapshot；过期请求结果不更新新 thread；失败操作保留队列和草稿；回合身份先于 thread ID 到达时仍能绑定。
- [ ] **Step 2：运行 Vitest 确认新 hook 测试失败。** 在 webview 目录运行 ./node_modules/.bin/vitest run src/hooks/useCodexThreadQueue.test.ts。本轮未保留实现前的失败运行记录。
- [x] **Step 3：实现 hook 和 bridge 协议。** action 使用 queue list/add/update/delete/reorder/start/steer；每个请求包含 requestId、threadId，steer 还包含当前 turnId；仅匹配 provider、thread、requestId 的结果能改变本地状态。
- [x] **Step 4：路由 Codex 忙碌发送。** useAppChatController 在 Codex turn 活动时调用原生 enqueue，并复用正常 Codex 发送的输入转换以保留图片附件；Claude 与其他 provider 继续走 useMessageQueue；忙碌期间的普通消息只加入队列，不清除 composer 草稿直到 native ack。
- [x] **Step 5：连接队列控件。** ChatInputBox 接收 native queue 和操作回调；MessageQueue 提供编辑、删除、排序、单条 steer 和中断后恢复入口；暂停状态由客户端记录，恢复调用原生 thread/queue/start；steer 成功后删除该项并刷新确认，失败时保留该项并显示错误。
- [x] **Step 6：加重复送达防护。** 同一队列 item 在请求未确认期间禁用二次 steer；steer 失败后先 refresh 原生队列，再允许用户重试。
- [ ] **Step 7：覆盖 provider 隔离和忙闲切换。** Codex queue、steer、编辑、重排、pause、thread 切换及失败保留均有 hook/UI 用例；Claude 通用队列现有用例通过，controller 按 provider 的路由已静态核对，但本轮没有新增 controller 级 provider 隔离集成用例。
- [x] **Step 8：运行 WebView 定向用例和类型检查。** 在 webview 目录运行计划中的四个 Vitest 文件，另加 useCodexActiveTurnId.test.ts；5 个文件共 52 个用例通过，./node_modules/.bin/tsc --noEmit 通过。

### Task 5：实现消息级分支、thread 所有权和隐私继承

**Files:**
- Modify: ai-bridge/services/codex/persistent-codex-service.js
- Modify: ai-bridge/services/codex/codex-privacy-index.js
- Modify: ai-bridge/services/codex/codex-privacy-index.test.js
- Modify: ai-bridge/services/codex/codex-item-projection.js
- Modify: ai-bridge/services/codex/codex-item-projection.test.js
- Modify: ai-bridge/services/codex/codex-native-history.js
- Modify: ai-bridge/services/codex/codex-native-history.test.js
- Modify: src/main/java/com/github/claudecodegui/provider/codex/CodexSDKBridge.java
- Modify: src/main/java/com/github/claudecodegui/provider/codex/CodexHistoryPrivacy.java
- Modify: src/main/java/com/github/claudecodegui/handler/CodexInteractionHandler.java
- Modify: src/test/java/com/github/claudecodegui/provider/codex/CodexHistoryPrivacyTest.java
- Modify: src/test/java/com/github/claudecodegui/provider/codex/CodexSDKBridgeCommandTest.java
- Modify: src/test/java/com/github/claudecodegui/provider/codex/CodexThreadOwnerRegistryTest.java
- Modify: webview/src/components/MessageItem/MessageItem.tsx
- Modify: webview/src/components/MessageItem/MessageActionButtons.tsx
- Modify: webview/src/hooks/useSessionManagement.ts
- Modify: webview/src/i18n/locales/en.json
- Modify: webview/src/i18n/locales/zh.json

**Interfaces:**
- Produces: forkCodexThread({ threadId, lastTurnId }) 调用 thread/fork 并返回新 thread 对象。
- Produces: CodexPrivacyIndex.inheritFork(sourceThreadId, forkThreadId, lastTurnId) 只复制边界内且身份可映射的分类；身份不可映射时在新 thread 上启用 conservativeMasking。
- Produces: thread/fork 成功后为新 thread 建立独立 writer lease，不把它登记为源 thread 的 descendant；按现有 load_session 流程切换至新分支。
- Consumes: Task 3 的 codex.fork 和 codex-queue-result 结果事件。

- [x] **Step 1：编写 fork RPC 和隐私边界测试。** 用 stdio peer 验证 thread/fork 带 threadId 与 lastTurnId；新 thread ID 缺失时失败；新 thread 不继承 lastTurnId 之后的分类；身份无法映射时新 thread 开启 conservativeMasking。
- [ ] **Step 2：运行 Node 分支定向用例确认失败。** 未保留实现前的失败运行记录；后续定向用例通过不替代 red-first 证据。
- [x] **Step 3：实现 fork 和隐私索引继承。** 服务端收到有效 thread/fork 结果后提取新 thread id；隐私索引以单条原子记录写入新 thread 的全部继承分类与必要的保守标记，限定到 lastTurnId；不能证明身份映射可靠时仅对新 thread 保守遮罩，不改写源 thread。
- [x] **Step 4：实现 Java 所有权和历史遮罩。** fork 成功后通过现有 CodexThreadOwnerRegistry.claim 建立独立 writer lease，不把 fork 关系合并进源 thread 的 descendant 关系；Java 历史投影识别分支级遮罩。CodexThreadOwnerRegistry 原实现已满足独立 claim，因此复用并补充所有权测试。
- [x] **Step 5：增加完成回合的分支入口。** 仅对当前 thread 中已完成且有稳定 turnId 的助手回合展示“分叉聊天”；发送 threadId 与 lastTurnId，收到新 thread 后使用现有 load_session 流程打开，不改变源会话。
- [x] **Step 6：验证子代理与 thread 隔离。** 复用 Codex App Server 子 thread 活动期间父回合仍保持活动的定向用例，并补充 fork 独立 lease 与 WebView 仅按返回的新 thread id 切换的断言；事件携带真实 threadId/rootThreadId，不绑定到父回合。
- [ ] **Step 7：运行分支定向用例。** `node --test services/codex/codex-privacy-index.test.js services/codex/persistent-codex-service.test.js` 通过（60 项）；Gradle 指定测试未能到达测试编译阶段：`maven.aliyun.com` DNS 解析失败，无法获取 `junit:junit:4.13.2`。`compileJava` 已通过。
- [x] **Step 8：运行分支 UI 用例。** `./node_modules/.bin/vitest run src/components/MessageItem/MessageItem.test.tsx src/hooks/useSessionManagement.test.ts` 通过，62 项；确认只有完成助手回合可分支、分支失败或响应缺失新 thread id 不切换当前 thread。

### Task 6：统一 Codex 思考、计划和回合活动状态

**Files:**
- Modify: ai-bridge/services/codex/codex-appserver-service.js
- Modify: ai-bridge/services/codex/codex-appserver-service.test.js
- Modify: ai-bridge/services/codex/codex-item-projection.js
- Modify: ai-bridge/services/codex/codex-item-projection.test.js
- Modify: webview/src/hooks/useCodexTurnActivity.ts
- Modify: webview/src/hooks/useCodexTurnActivity.test.ts
- Modify: webview/src/useAppChatController.ts
- Modify: webview/src/App.tsx
- Modify: webview/src/components/ChatScreen.tsx
- Modify: webview/src/components/MessageList.tsx
- Modify: webview/src/components/MessageList.test.tsx
- Modify: webview/src/components/WaitingIndicator.tsx
- Create: webview/src/components/WaitingIndicator.test.tsx
- Modify: webview/src/components/MessageItem/blocks/ThinkingBlock.tsx
- Modify: webview/src/components/MessageItem/ContentBlockRenderer.test.tsx
- Modify: webview/src/utils/thinkingVisibility.ts
- Create: webview/src/utils/thinkingVisibility.test.ts
- Modify: webview/src/i18n/locales/en.json
- Modify: webview/src/i18n/locales/zh.json

**Interfaces:**
- Produces: Codex turn activity 状态包含 threadId、turnId、运行阶段和 startedAt；活动阶段来源于 App Server 原生事件。
- Produces: 计划摘要使用现有 planUpdated 状态；未知阶段显示官方等价的通用运行提示。
- Consumes: thread/status/changed、turn/item/started、turn/item/completed、planUpdated 和 operationDone 事件。

- [x] **Step 1：补齐原生状态事件用例。** 覆盖 thinking、工具运行、等待审批、计划、失败、取消、完成、thread 切换和迟到事件；旧 turn 的事件不能改变新 turn 的阶段或计时。
- [ ] **Step 2：运行状态 hook 定向用例确认失败。** 未保留实现前的失败运行记录。
- [x] **Step 3：实现 turn 状态归属和耗时。** useCodexTurnActivity 按 threadId/turnId 归属原生事件，start 时间只在 turnStarted 建立；operationDone 或 runtimeReset 清除状态，不推测不存在的模型进度。
- [x] **Step 4：调整等待和思考显示。** WaitingIndicator 根据原生阶段显示思考、执行、审批等待、计划或通用活动提示；ThinkingBlock 仅显示明确提供的可公开 reasoning summary，不把隐藏推理或未确认文本拼接成摘要。
- [x] **Step 5：验证消息内计划及其他 provider。** turn/plan/updated 的已完成步骤回到思考状态；原生 planUpdated 仍展示计划阶段；Claude 等 provider 的 ThinkingBlock 与 WaitingIndicator 原有内容和计时回退通过定向用例确认。
- [x] **Step 6：运行状态与渲染用例。** 7 个 Vitest 文件共 79 项通过（包含 useCodexTurnActivity、useCodexPlanState、MessageItem、ContentBlockRenderer、MessageList、WaitingIndicator、thinkingVisibility）；`tsc --noEmit`、`git diff --check` 及中英文 JSON 解析通过。Node App Server、projection 和 history 定向用例共 131 项通过。

### Task 7：将 Codex 子代理展示映射到 StatusPanel 并按 VS Code 分组

**Files:**
- Delete: webview/src/components/ChatInputBox/CodexSubagentActivity.tsx
- Delete: webview/src/components/ChatInputBox/CodexSubagentActivity.test.tsx
- Modify: webview/src/components/ChatInputBox/ChatInputBox.tsx
- Modify: webview/src/components/ChatInputBox/types.ts
- Modify: webview/src/components/StatusPanel/SubagentList.tsx
- Modify: webview/src/components/StatusPanel/SubagentList.test.tsx
- Modify: webview/src/components/StatusPanel/StatusPanel.tsx
- Modify: webview/src/components/StatusPanel/StatusPanel.less
- Modify: webview/src/i18n/locales/en.json
- Modify: webview/src/i18n/locales/zh.json

**Interfaces:**
- Produces: StatusPanel 的 Codex 子代理页签按 Active / Done 分组；Waiting 归入 Active 并显示等待数量。
- Consumes: useSubagents、现有 Codex 子 thread 历史查询和 App Server 事件；Claude 继续使用原有列表布局。
- Stop 操作只在矩阵证实当前 CLI 存在受支持的原生 stop API 后加入控件。

- [x] **Step 1：核对扩展包中的分组与操作。** 覆盖 Active、Done、Waiting、错误、空列表、子 thread 历史详情、thread 切换和 Codex/provider 隔离；确认 Waiting 属于 Active。
- [x] **Step 2：在 StatusPanel 中呈现 VS Code 分组。** Codex 子代理页签按 Active / Done 分组，等待项进入 Active 并显示等待数量；删除与扩展不一致的 composer 活动区。
- [x] **Step 3：接入已有详情查询。** 点击 Codex 活动行后复用 `load_subagent_session` 显示 task 身份匹配的完整子 thread 对话，并提供返回分组列表的按钮；Claude 继续使用 `SubagentProcessDetails`，切换 thread/provider 后清除旧详情。
- [x] **Step 4：统一原生状态来源并保留 provider 隔离。** 原生 `pendingInit` 映射为 Waiting，旧 history 不覆盖未关联到当前任务 ID 的原生状态；Claude 列表布局保持不变。
- [x] **Step 5：仅按基线启用停止操作。** 当前矩阵没有确认单个子代理停止 RPC，因此不显示停止按钮。
- [x] **Step 6：运行子代理定向用例。** 当前 StatusPanel / SubagentList 用例通过；Task 8 的受影响 WebView 回归共 5 个文件、75 项通过，`tsc --noEmit` 通过。

### Task 8：按官方基线完成视觉收敛和端到端验收

**Files:**
- Modify: docs/codex/vscode-parity-matrix.md
- Modify: webview/src/components/ChatInputBox/styles/banners.css
- Modify: webview/src/components/StatusPanel/StatusPanel.less
- Modify: webview/src/components/StatusPanel/StatusPanel.tsx
- Modify: webview/src/components/StatusPanel/SubagentList.tsx
- Modify: webview/src/components/StatusPanel/SubagentList.test.tsx
- Modify: webview/src/styles/less/components/message.less
- Modify: webview/src/components/MessageItem/MessageActionButtons.tsx
- Modify: webview/src/components/MessageItem/MessageItem.tsx
- Modify: webview/src/components/MessageItem/MessageItem.test.tsx
- Modify: webview/src/components/ChatInputBox/MessageQueue.tsx
- Add: webview/src/components/ChatInputBox/MessageQueue.test.tsx
- Modify: webview/src/components/ChatInputBox/ChatInputBox.tsx
- Modify: webview/src/components/ChatInputBox/types.ts
- Modify: webview/src/components/ChatScreen.tsx
- Modify: webview/src/i18n/locales/en.json
- Modify: webview/src/i18n/locales/zh.json

**Interfaces:**
- Consumes: Task 1 基准矩阵和截图、Task 2–7 的真实状态与控件。
- Produces: 矩阵中每个适用功能差异均有实现和验证证据；宿主映射差异有明确理由。

- [ ] **Step 1：按相同主题和窗口尺寸复拍全部验收状态。** 对比空会话、思考、工具、审批、消息、队列、steer、fork、子代理和错误状态。
- [ ] **Step 2：逐项修正可见差异。** 对齐布局、信息层级、间距、字号、颜色、图标、边框、hover、focus、disabled、展开状态和动效节奏；颜色使用 IDE 主题与现有 CSS token。
- [x] **Step 3：更新差异矩阵和证据。** 更新 queue、steer、fork、思考、子代理和错误行的当前实现及残余差距；JetBrains 宿主映射和待截图状态均已标注。
- [x] **Step 4：运行所有改动影响到的定向验证。** Node App Server / history / privacy 用例 191 项通过；WebView 16 个文件、185 项通过，`tsc --noEmit` 通过；4 组 Codex Java 定向测试通过。
- [ ] **Step 5：构建 JetBrains 插件并做真实 App Server 冒烟。** `./gradlew buildPlugin` 已成功；真实 App Server / sandbox IDE 冒烟待在屏幕解锁后执行，覆盖队列、steer、fork 隐私、StatusPanel 子代理和工具窗口重载。
- [x] **Step 6：完成最终覆盖检查。** 逐行复核功能矩阵；确认 Codex 对话走 App Server、stateful RPC 与只读白名单分离、Claude 列表呈现保持原样，并保留工作区原有未提交改动。

### Task 9：补齐 VS Code 队列后续模式、消息预览与子代理记录导航

**Files:**
- Modify: webview/src/hooks/useCodexThreadQueue.ts
- Modify: webview/src/hooks/useCodexThreadQueue.test.ts
- Modify: webview/src/useAppChatController.ts
- Modify: webview/src/components/ChatScreen.tsx
- Modify: webview/src/components/ChatInputBox/types.ts
- Modify: webview/src/components/ChatInputBox/hooks/useSubmitHandler.ts
- Modify: webview/src/components/ChatInputBox/hooks/useKeyboardHandler.ts
- Modify: webview/src/components/ChatInputBox/hooks/useNativeEventCapture.ts
- Modify: webview/src/components/ChatInputBox/ChatInputBox.tsx
- Modify: webview/src/components/ChatInputBox/ChatInputBoxHeader.tsx
- Modify: webview/src/components/ChatInputBox/MessageQueue.tsx
- Modify: webview/src/components/ChatInputBox/MessageQueue.test.tsx
- Modify: webview/src/components/ChatInputBox/styles/banners.css
- Modify: webview/src/components/settings/hooks/useDragSort.ts
- Modify: webview/src/components/settings/hooks/useDragSort.test.ts
- Modify: webview/src/components/StatusPanel/SubagentList.tsx
- Modify: webview/src/components/StatusPanel/SubagentList.test.tsx
- Modify: webview/src/components/StatusPanel/StatusPanel.less
- Modify: webview/src/types/subagent.ts
- Modify: webview/src/i18n/locales/en.json
- Modify: webview/src/i18n/locales/zh.json
- Modify: docs/codex/vscode-parity-matrix.md
- Modify: docs/superpowers/specs/2026-10-22-codex-vscode-parity-design.md

**Interfaces:**
- Produces: Codex follow-up preference persisted as `queue` or `steer`, defaulting to `queue`; legacy `interrupt` normalizes to `steer`.
- Produces: Cmd/Ctrl+Shift+Enter applies the opposite behavior once, through both JCEF capture and React fallback while preserving IME and duplicate-submit guards.
- Produces: direct composer steer uses `turn/steer` with the current active turn and does not create a queue item.
- Produces: queue message preview, edit/more actions, and a retry state only when the prior steer was not acknowledged.
- Produces: queue drag starts after six pixels without changing the shared drag behavior for other lists.
- Produces: Codex subagent selection opens its child transcript with a Back action and validates history against the selected task; Claude details remain unchanged.
- Host mapping: JetBrains has one active chat surface and no independent side-chat API. Do not map “Open in side chat” to new-session creation because that interrupts the running turn; record the limitation in the parity matrix.

- [x] **Step 1：新增 queue/steer 偏好、单次快捷键和直接 composer steer。** 复用现有 native queue hook 与提交链路，保留旧配置归一化及 IME/重复键保护。
- [x] **Step 2：补齐队列预览、更多操作和安全重试。** 错误态只有在 steer 请求未确认时允许重试；已确认 steer 但删除失败时禁止重复发送。
- [x] **Step 3：为队列拖动添加六像素启动阈值。** 通过可选参数限定于 Codex 队列，并覆盖现有通用拖动用例。
- [x] **Step 4：将 Codex 子代理从摘要展开切换到完整子 thread 记录。** 支持返回列表，切换 provider/root session/task 时清理或拒绝过期选择；保留 Claude 的既有摘要卡片。
- [x] **Step 5：更新差异矩阵和设计状态。** 准确记录 side chat 宿主边界、已实现控件及仍待 GUI 验收项。
- [x] **Step 6：运行受影响的 WebView 定向用例和类型检查。** 12 个 Vitest 文件共 173 项通过；兼容性修正后另复跑 4 个相关文件共 49 项。最终 `tsc --noEmit`、Vite 构建、中英文 JSON 解析及 `git diff --check` 通过。浏览器预览已打开；锁屏期间未宣称完成真实 IDE 截图/App Server 冒烟。
- [x] **Step 7：对本任务改动及直接调用方进行两轮以内自检并修复严重或隐患问题。** 两轮内修复两项：普通提交在输入框和 ChatScreen 包装层均保留双参数回调；已确认 steer 会保留去重状态，避免其他 steer 失败后重发。

## 验收清单

- [x] Codex 的 App Server 有状态请求与只读 RPC 使用分开的受控通道。
- [x] busy turn 中普通提交进入原生队列，队列变更由 App Server 作为事实来源。
- [x] 用户可将队列消息 steer 到当前预期 turn；失败不会丢失或重复发送文本。
- [x] 已完成助手回合可 fork 到独立、可恢复的新 thread，源会话不变。
- [x] fork 后的历史在显示前继承隐私遮罩，无法确认身份映射时保守遮罩。
- [x] Codex 思考、工具、审批、计划、完成状态按原生事件显示，不虚构思维内容和进度。
- [x] Codex 子代理在 StatusPanel 中按 Active / Done 分组，Waiting 归入 Active，并能展开现有子 thread 历史详情。
- [x] Codex 活动时支持持久 queue/steer 选择、单次快捷键反转、全文队列预览、安全 Retry 与子代理 thread 记录返回导航。
- [x] 功能矩阵中每个适用差异均有实现、JetBrains 等价映射或明确的协议兼容结果；截图、真实 App Server 冒烟与列出的剩余 UI 差距明确待后续完成。
- [ ] 未发现其他 provider 回归，且与 VS Code 基准在相同场景下完成截图比对。
