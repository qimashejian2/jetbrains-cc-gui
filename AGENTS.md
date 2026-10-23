# AI 工作入口

开始跨模块开发或排查前，先阅读 [`docs/PROJECT_ARCHITECTURE.md`](docs/PROJECT_ARCHITECTURE.md)，了解仓库结构、运行时数据流、测试入口和当前权威文档。

## 项目约定

- 这是单一 Gradle 工程，前端 `webview/` 和 Node.js 桥接层 `ai-bridge/` 由根目录构建任务集成；不要把它们误认为独立 Gradle 子项目。
- Codex 的生产运行链路是 Java provider facade → 持久化 Node daemon → 本机 `codex app-server --listen stdio://`。`CodexSDKBridge` 是沿用的 Java 类名，不代表 Codex 回合通过 SDK 执行。运行时合同以 [`docs/codex/app-server.md`](docs/codex/app-server.md) 为准。
- Webview、Java handlers 和 Node daemon 之间有明确的消息协议。修改事件名、负载或回调时，沿完整调用链核对并更新对应测试。
- 开始修改前检查 `git status`，保留已有工作区改动；不要用 `clean`、重置或批量格式化清理用户文件。
- Java 使用 JDK 17。前端构建使用 Vite 7，Node.js 需为 `20.19+` 或 `22.12+`。

## 常用命令

- 沙箱 IDE：`./gradlew runIde`
- 插件包：`./gradlew buildPlugin`
- Java 测试：`./gradlew test`
- Webview 单测：`cd webview && npm test`
- AI Bridge 测试：`cd ai-bridge && node --test`
