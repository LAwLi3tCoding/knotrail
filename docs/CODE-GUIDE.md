# Knotrail 代码文档

对应 v0.1.0；先读 [原理与架构](../ARCHITECTURE.md)，再沿下面的调用链定位代码。本项目使用 TypeScript、React、Electron、pi SDK 和 Node 内置 SQLite，构建用 esbuild，未引入 ORM、通用工作流引擎或第二套模型循环。

## 1. 目录与责任

| 入口 | 责任 |
| --- | --- |
| `src/shared/contracts.ts` | Renderer/Main 共用的数据结构、命令和返回类型 |
| `src/desktop/main.ts` | 窗口生命周期、主进程 IPC、safeStorage、目录及导出对话框、退出收尾 |
| `src/desktop/preload.ts` | sandboxed renderer 的唯一桥接面 |
| `src/core/service.ts` | 命令、状态机、规划、Run、回执、检查、恢复、定时唤醒 |
| `src/core/store.ts` | SQLite schema、同步事务、快照、项目、偏好和请求去重 |
| `src/core/validation.ts` | IPC Zod 校验与计划 DAG 校验 |
| `src/core/workspace.ts` | Git broker、worktree、文件边界、SHA-256 与累计 diff |
| `src/runtime/contracts.ts` | Runner、工具请求和结构化结果的边界 |
| `src/runtime/pi-runner.ts` | 创建并管理每 Run 独立 Worker；把工具和控制请求交回 Main |
| `src/runtime/pi-worker.ts` | 实际 pi SDK 接线、显式模型和资源加载范围、工具定义、消息事件 |
| `src/execution/contracts.ts` | 执行器、沙箱选项和 owner lock 接口 |
| `src/execution/sandbox.ts` | 沙箱能力检查、权限配置、helper 启动、取消和回收 |
| `src/execution/helper.mjs` | 纯 Node stdlib 文件操作、argv 命令、输出限制、父管道断连收尾 |
| `src/execution/lock.ts` | 内核 flock 与继承的文件描述符 |
| `src/renderer/App.tsx` | 桌面主壳、任务表单、规划栏、节点详情、工具面板、设置 |
| `src/renderer/i18n.ts` | 中英文界面字典 |
| `src/renderer/styles.css` | Codex 风格工作台布局、右侧面板、窄屏抽屉和可访问性 |
| `scripts/build.mjs` | 桌面、Worker、helper 和 Renderer 的构建 |
| `scripts/dev.mjs` | 构建并启动开发态 App |
| `scripts/live-smoke.ts` | 用户提供模型配置后的真实服务验收 |

## 2. 对外桌面接口

Renderer 只能使用 `window.knotrail`，没有直接文件或 shell API。

```ts
interface DesktopAPI {
  command<T = CommandResult>(command: AppCommand): Promise<T>;
  subscribe(listener: (event: {
    taskId?: string; seq?: number; kind: string
  }) => void): () => void;
  chooseProject(): Promise<string | null>;
  exportReport(taskId: string): Promise<string | null>;
}
```

`command` 在 Main 进入 `AppService.command()`，先经 Promise 链按顺序接收用户命令，再做 Zod 校验并分发。执行队列与命令链分开，长 Run 不堵塞暂停按钮。状态变化通过事件告知 Renderer 重新读取快照；事件丢失后仍可通过快照恢复，没有用 DOM 状态充当执行状态。

| 命令 | 输入要点 | 返回 / 行为 |
| --- | --- | --- |
| `bootstrap` | 无 | 项目、任务摘要、非敏感设置、沙箱能力 |
| `project.add` | Git 根目录 | 已有项目或新 Project |
| `task.create` | requestId、项目、目标、检查、策略、模式和预算 | 新快照；独立工作树；进入只读规划 |
| `task.snapshot` | taskId | 完整持久化快照 |
| `task.pause` / `task.cancel` | taskId、expectedRevision | 关闭准入、等待实际收尾后暂停或取消 |
| `task.resume` | taskId、expectedRevision | 先查证未知效果，再核对文件证据并继续 |
| `task.inspectEffects` | taskId | 展示未知效果的绑定证据；终态任务也可查证，不启动 Run |
| `task.previewRevision` | 新目标与 expectedRevision | 停止并生成一次性影响预览 |
| `task.previewRetry` | nodeId 与 expectedRevision | 计算本节点和后继失效集合 |
| `task.applyImpact` | requestId 与完整签发预览 | 校验原件、版本和摘要；原子消费；继续 |
| `decision.answer` | requestId、decisionId、答案、expectedRevision | 验证当前决定并记录回答 |
| `task.files` / `task.readFile` | taskId 与相对路径 | 有范围限制的只读结果 |
| `task.export` | taskId | 在应用数据目录导出报告并返回路径 |
| `settings.save` | 允许字段的 patch | 不含 apiKey 的设置 |
| `model.check` | 无 | `/models` 与精确 modelId 校验 |
| `preferences.get/save` | taskId、视图偏好 | 独立于任务执行的布局与草稿 |

未知命令和字段会失败。需要版本检查的命令收到旧 `expectedRevision` 会要求刷新；重用 requestId 却改变内容会被拒绝。报告另有原生 Save 对话框入口，用户选择路径后 Main 写文件。

## 3. 从创建到完成的函数链

```text
App new-task form
  → DesktopAPI.command(task.create)
  → main.trustedSender()
  → AppService.command() → parseCommand() → dispatch()
  → projectRoot() → prepareWorktree()
  → Store transaction(task + deduplicated request)
  → enqueue() → pump() → drive()
  → run(purpose=planning)
  → PiRunner.run() → pi-worker → createAgentSession()
  → update_plan → validatePlan() → save candidate draft
  → Worker exit → verify source/revision → append PlanRevision + ready
  → policy auto / user resume
  → run(purpose=node) → onTool() → executeRecorded() → pending receipt
  → SandboxExecutor.execute() → helper
  → outcome complete → check(node)
  → next node / finalize() → check(all)
  → completed / healthy / explicit acceptance / blocked
```

`pump()` 是全局串行执行者。多任务可以等待，但同时只运行一个任务的效果链。`stop()` 从队列移除任务，abort 当前控制器，并等待 Runner 与 helper 完成；返回后再向用户展示暂停或取消。程序退出也等待这条链，最后释放 owner fd。

## 4. pi 接线与消息边界

每个 `RunnerRequest` 包含实际 Run ID、规划/节点用途、工作目录、独立会话目录、模型配置、目标、检查、当前计划、节点、既往摘要、剩余轮数和超时。身份来自 Coordinator，不接受模型自行指定任务或 Run。

Worker 使用已固定版本的 `@earendil-works/pi-coding-agent`。项目和全局扩展、默认工具、技能和资源自动发现被关闭；只注册 Knotrail 明确提供的工具。配置显式构造 OpenAI-compatible Chat Completions 模型，支持自定义 baseUrl、modelId、thinking、contextWindow 和 maxTokens。

`turn.started` 在实际模型轮开始时写入持久预算；`assistant.delta` 用于公开文字流。工具执行与控制请求通过带消息 ID 的 RPC 排队，父进程返回 `ToolResult`。一次终止结果被接受后，双方都关闭后续准入。

`RunnerResult.usage` 可缺省，部分已知计数携带 `partial=true`。pi 将缺失用量补为零，因此 Worker 保守地把零总量响应视为未测得；全程未测得时不返回 usage，部分测得时保留计数并标 partial。取消分支不创建零用量，Renderer 只汇总有记录的值并提示缺失。

`RunnerResult` 返回 summary、sessionPath、turns、usage、aborted。不存在结构化终止结果、达到轮数上限、模型出错或 Worker 异常退出，都会成为失败路径，不靠最后一段自然语言猜测完成。

## 5. 工具协议

| 工具 | 关键参数 | 语义 |
| --- | --- | --- |
| `read_file` | path | 返回文本与 SHA-256；大文本截断 |
| `list_files` | path 可选 | 受范围限制的列表，最多 2,000 项 |
| `search_files` | query、path 可选 | 有界搜索，最多 200 个匹配 |
| `write_file` | path、content、expectedContent 或 expectedHash | 新文件用 expectedContent:null；旧文件必须匹配当前内容或 hash |
| `edit_file` | path、oldText、newText、expectedContent 或 expectedHash | 在匹配版本中进行准确文本替换 |
| `run_command` | argv:string[]、timeoutMs 可选 | 直接 spawn 参数数组；若显式调用 shell，该 shell 仍在沙箱内 |
| `update_plan` | draft、submit | 仅规划 Run；保存递增草稿或提交 DAG |
| `outcome` | kind 及对应字段 | complete、decision、wait、blocked |

文件写入先检查目标和父目录，拒绝越界、符号链接、`.git` 与 protectedPaths，再验证预期版本。helper 写临时文件，在替换前重查目标，随后 rename；保留已有文件的执行权限。模型拿到截断文本时可以使用 hash，避免必须回传整份旧文件。

用户的 `CheckSpec.command` 与工具参数不同：它在 Core 中转换为 `run_command.args.argv`。固定检查不经过模型改写。`check()` 为整批验收创建唯一 batchId，冻结 taskRevision、planId、checksDigest、inputDigest。每条回执都携带这些绑定。`batchCurrent()` 在检查前后及节点/任务落状态时复核；任何绑定变化会阻止成功，即使命令 exit code 为零。acceptedDigest 不重新读取一个未验证的摘要。

## 6. 持久化和恢复

`Store.update()` 在同步 SQLite 事务中读取任务 JSON、执行同步修改、保存并提交。不在事务中 await。任务创建、影响应用与决定回答把去重请求和对应状态一起提交。事件在同一次更新中追加，seq 严格递增。

异步效果前先持久化 pending。`executeRecorded()` 是模型工具和固定检查共用的回执入口。准入后的执行异常或结果写入失败标记 unknown；工具回调关闭 admission 并触发独立 fault AbortController，随后外层等待实际收尾。pending 写入失败时执行器不会被调用。

`unresolved()` 从动作回执计算未处置效果，不依赖节点是否被改为 stale。`requireRecovery()` 覆盖 Resume、修改/重试、drive、最终验收和决定处理，执行器准入另有检查。未知命令会冻结其他任务的新效果；未知只读动作不会触发该门。

恢复卡片是 `Decision.kind=recovery`，绑定 actionIds、actionsDigest、workspaceDigest 和证据 artifactId，Task/Plan 版本由 Decision 绑定。`decision.answer` 复核后，在一个事务中保存 resolution、回答和 requestId。保留并重新规划会创建新 TaskRevision；终态的 preserve-and-stop 只保存处置、保持终态。原 action.status 仍是 unknown。处置失败或证据变化不能解锁效果。

acceptance、model、recovery 使用显式 kind 分派，模型不能用问题文本伪装成宿主验收。当前恢复仍依赖用户查证；没有从 diff 推断命令未发生，也没有通用 exactly-once 保证。

工作树创建发生在数据库提交前，因此极端崩溃可能留下未注册的工作树。v0.1 保留它而不自动删除，便于手动审查，未实现垃圾回收器。

## 7. 前端状态

任务执行状态只来源于 `TaskSnapshot`。Renderer 持有当前项目/任务选择及可恢复 UI 偏好：主区 chat/activity/changes、规划 process/steps、graph/list、选中节点、详情页签、底部工具页签和输入草稿。

右侧规划开关存在 AppSettings；每个任务的节点和页签选择存在 TaskPreferences。打开或关闭不触发运行，切换语言不重建任务，不翻译原始模型输出、用户输入、命令或代码。

窄屏规划栏固定在右边，支持 Escape 关闭与键盘操作。文件预览仅渲染文本；Preview 不是任意 HTML 网站执行器。Terminal 展示已执行命令的真实回执，没有额外的 unrestricted interactive shell。

## 8. 构建与打包

`scripts/build.mjs` 输出：

```text
dist/
  desktop/main.cjs
  desktop/preload.cjs
  renderer/index.html
  renderer/app.js
  renderer/app.css
  runtime/pi-runner.cjs
  runtime/pi-worker.mjs
  execution/sandbox.cjs
  execution/helper.mjs
```

PiRunner 和 SandboxExecutor 单独构建，保留相邻 Worker/helper 定位。Worker 是 ESM，因为 pi 的导出使用 import；preload 是不含 Node URL banner 的独立最小 CJS，才能在 Electron sandbox 中加载。打包 `asar:false`，避免 OS 子进程访问虚拟归档路径。

`npm run package` 使用 electron-builder 生成本机 macOS App 目录。当前输出不签名、不公证；这不影响本地源码验证，但不能声称它已符合正式商店分发要求。

## 9. 测试入口与贡献约定

| 命令 / 测试 | 验证内容 |
| --- | --- |
| `npm run typecheck` | 全部 TypeScript 契约 |
| `npm test` | Core 状态与证据、真实 pi HTTP fixture、真实 OS 隔离与进程收尾 |
| `npm run test:ui` | 真实 React + 模拟桥接的交互回归 |
| `node tests/desktop-smoke.mjs` | 真实 Electron/preload/Core/pi/helper 完整链路 |
| `npm run smoke:live` | 用户配置远端模型后，真实生成并修改临时项目 |
| `npm run package` | 本地打包；打包可执行文件另运行桌面 smoke |

UI fixture 不能证明模型接线；pi HTTP fixture 不能证明某个线上模型质量；构建成功不能证明 Electron preload 和子进程加载。验收报告逐项区分这些证据。

修改执行协议时，优先在 Core 的状态入口和 Runner/Executor 边界补一个可观察失败的回归。不要让 Renderer 成为第二个调度器，也不要让模型自行填写 verified 或 completed。添加新工具必须同时定义参数边界、允许阶段、沙箱权限、回执与取消语义。
