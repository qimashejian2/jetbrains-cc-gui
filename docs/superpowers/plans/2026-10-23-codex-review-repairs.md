# Codex review repairs implementation plan

**Goal:** 修复 2026-10-23 复审确认的六项问题，保留工作区已有改动。

**Architecture:** 延续 Webview → Java facade → Node daemon → Codex app-server 的现有合同。会话代次在请求入口冻结，释放后的代次不能恢复运行时；分支写入所有权在实际加载时获取。输入框按草稿合并进行中的原生提交；队列完整展示本地和原生已接受消息，并由 Node 聚合原生分页。Fork 前记录原生完整线程目录作为安全基线；目录外线程持续隔离，直接 `thread/start` 和完成分类的分支才记录可信身份，不以全局锁阻断后续 Fork。

**Tech Stack:** Java 17、Node.js 20.19+ 或 22.12+、React、TypeScript、现有 JUnit/Node test/Vitest。

**Spec:** 本轮代码复审的六项发现及用户“全部”修复授权。

## 实施任务

- [x] Fork 隔离：持久化分叉前完整线程目录基线；未知线程保留隔离策略而不持有全局锁，已分类分支和直接新建线程可记录可信身份。旧全局临时记录迁移为保守隔离；损坏记录继续 fail-closed。
- [x] 会话代次：修改 `CodexSDKBridge.java`，为队列列表、恢复和重试传递同一冻结代次；释放开始即禁止新恢复。Node 对已释放的显式代次保留墓碑，已退役服务不能重新启动。
- [x] 租约采纳：Fork 仅验证返回结果；实际 `preconnect` 或发送时领取新线程租约。
- [x] 草稿提交：以正文、附件身份和跟进模式合并同一草稿的 pending 提交，失败可重试，新草稿仍可发送。
- [x] 混合队列：按原生→本地顺序展示；删除和重排按来源路由，本地发送等待已有原生队列。
- [x] 原生分页：冻结服务和运行时代次，循环读取至空游标；异常、重复游标和释放不能返回部分结果。
- [x] 验证与文档：定向 Node（174 项）、Java 选定用例、Vitest（44 项及提交钩子 14 项）和 TypeScript 均已通过；`docs/codex/app-server.md` 已更新。最终异步会话代次加固后，重新编译 Java 主代码与测试代码（`--rerun-tasks`，成功）；该加固后的测试套件未重跑。两轮内完成自检与本轮问题修复。

## 验证入口

- Node：`codex-privacy-index.test.js`、`persistent-codex-service.test.js`、`codex-appserver-service.test.js`。
- Java：`CodexSDKBridgeCommandTest`、`CodexThreadOwnerRegistryTest`、`CodexHistoryPrivacyTest` 与直接受影响的执行器用例。
- Webview：`useSubmitHandler.test.ts`、`useAppChatController.test.tsx`、`useCodexThreadQueue.test.ts`、`MessageQueue.test.tsx`，以及 `tsc -p tsconfig.test.json --noEmit`。

不提交或清理用户工作区，不执行全量格式化，不把服务夹具测试表述为真实 IDE 冒烟。
