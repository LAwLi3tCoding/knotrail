# Knotrail 代码文档

对应当前工作区；先读 [原理与架构](../ARCHITECTURE.md)，再沿下面的调用链定位代码。本项目使用 TypeScript、React、Electron、pi SDK 和 Node 内置 SQLite，构建用 esbuild，未引入 ORM、通用工作流引擎或第二套模型循环。本轮等待与维护修复已通过回归、独立复核和实际打包态验证；完整完成度见 [审查记录](COMPLETION-AUDIT.md)。

## 1. 目录与责任

| 入口 | 责任 |
| --- | --- |
| `src/shared/contracts.ts` | Renderer/Main 共用的数据结构、命令和返回类型，包括 WaitState、SourceObservation、HealthObservation |
| `src/desktop/main.ts` | 窗口生命周期、主进程 IPC、safeStorage、目录及导出对话框、退出收尾 |
| `src/desktop/preload.ts` | sandboxed renderer 的唯一桥接面 |
| `src/core/service.ts` | 命令、状态机、规划、Run、回执、检查、恢复、定时唤醒 |
| `src/core/store.ts` | SQLite schema、同步事务、快照、项目、偏好和请求去重 |
| `src/core/validation.ts` | IPC Zod 校验与计划 DAG 校验 |
| `src/core/workspace.ts` | Git broker、worktree、文件边界、SHA-256 与累计 diff |
| `src/runtime/contracts.ts` | Runner、工具请求和结构化结果的边界 |
| `src/runtime/pi-runner.ts` | 创建并管理每 Run 独立 Worker；把工具和控制请求交回 Main |
| `src/runtime/pi-worker.ts` | 实际 pi SDK 接线、显式模型和资源加载范围、工具定义、消息事件 |
| `src/core/codex-auth.ts` | 每 Run 只读 Codex 本机登录，返回 access token 与到期时间 |
| `src/runtime/codex-provider.ts` | 固定官方 SSE 传输、access-only provider、请求到期复核 |
| `src/runtime/redaction.ts` | 嵌套结果与跨分片文本的凭据过滤 |
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
| `task.resume` | taskId、expectedRevision | 先查证未知效果；未消费等待先观察，已有维护记录先复验，其余核对文件证据并继续 |
| `task.inspectEffects` | taskId | 展示未知效果的绑定证据；终态任务也可查证，不启动 Run |
| `task.previewRevision` | 新目标与 expectedRevision | 停止并生成一次性影响预览 |
| `task.previewRetry` | nodeId 与 expectedRevision | 计算本节点和后继失效集合 |
| `task.applyImpact` | requestId 与完整签发预览 | 校验原件、版本和摘要；原子消费；继续 |
| `decision.answer` | requestId、decisionId、答案、expectedRevision | 验证当前决定并记录回答 |
| `task.files` / `task.readFile` | taskId 与相对路径 | 有范围限制的只读结果 |
| `task.export` | taskId | 在应用数据目录导出报告并返回路径 |
| `settings.save` | 允许字段的 patch | 不含 apiKey 的设置 |
| `model.check` | 无 | API 模式校验 `/models` 与 modelId；Codex 模式仅检查本机登录格式/有效期，不发请求 |
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

长期任务从这条主链分出两条路径：

```text
outcome(wait) → Runner settled → readObservation() → persist WaitState
  → nextCheckAt / resume → wake() → drive() → observeWait()
  → waiting / unknown / already consumed: schedule next observation
  → newly satisfied: persist consumedAt + observation key → continue task

initial final acceptance → maintain healthy
  → nextCheckAt / resume → drive() → verifyMaintenance()
  → Run(purpose=verification) → check(scope=maintenance)
  → healthy / unhealthy / unknown + HealthObservation + nextCheckAt
```

第二条路径不调用 `PiRunner`。固定检查仍走 `executeRecorded()` 和相同的效果恢复门，没有另建一套执行器。

## 4. pi 接线与消息边界

每个 `RunnerRequest` 包含实际 Run ID、规划/节点用途、工作目录、独立会话目录、模型配置、目标、检查、当前计划、节点、既往摘要、剩余轮数和超时。登记过等待时，context 还包含 WaitState 的来源身份、最近观察时间/内容和消费记录，并明确原项目观察不会自动复制到 worktree。身份来自 Coordinator，不接受模型自行指定任务或 Run。维护用的 verification Run 不构造 RunnerRequest。

Worker 使用已固定版本的 `@earendil-works/pi-coding-agent`。项目和全局扩展、默认工具、技能和资源自动发现被关闭；只注册 Knotrail 明确提供的工具。API 模式显式构造 OpenAI-compatible Chat Completions 模型，支持自定义 baseUrl、modelId、thinking、contextWindow 和 maxTokens。

`ModelConfig.authSource='codex-login'` 时，Core 的 `model()` 调用 `readCodexLogin()`，使用内部 apiKey 字段传递 access token，并附 expiresAt；这两个字段都不进入设置回读。Renderer 无权提交 expiresAt，也不能为此模式指定其他 baseUrl 或粘贴密钥。Worker 注册 `codexProvider()` 后使用 pi 内置 `openai-codex` 模型元数据。provider 不能改成其他别名，否则 Responses 的 `call_id|item_id` 可能在下一轮函数结果中丢失。

该 provider 不加载 OAuth store，不刷新令牌；每次 POST 前复核到期和精确官方 URL，禁用 WebSocket 和 SDK 通用重试，禁止重定向。仅在收到响应头前遭遇指定连接中断时，最多额外尝试两次，等待可取消且再次校验到期；HTTP 错误与响应头后的断流不重试。Worker 记录 `provider.retry`，并将已知用量标为 partial，因为服务端可能已经处理过中断请求。没有收到模型工具调用前不会执行本地效果。Core 和 PiRunner 的总期限也受 access token 到期约束。Codex 模式的输出上限采用服务端约束，不发送无效的 Chat Completions token 参数。

`turn.started` 在实际模型轮开始时写入持久预算；`assistant.delta` 用于公开文字流。工具执行与控制请求通过带消息 ID 的 RPC 排队，父进程返回 `ToolResult`。一次终止结果被接受后，双方都关闭后续准入。

`RunnerResult.usage` 可缺省，部分已知计数携带 `partial=true`。pi 将缺失用量补为零，因此 Worker 保守地把零总量响应视为未测得；全程未测得时不返回 usage，部分测得时保留计数并标 partial。取消分支不创建零用量，Renderer 只汇总有记录的值并提示缺失。verification Run 不调用模型，汇总时排除，不能把它当成模型用量缺失。

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

`outcome(kind=wait)` 的最小有效控制结果如下；它是 Worker 工具参数，不是一个新的桌面 IPC 命令：

```json
{
  "kind": "wait",
  "reason": "等待外部确认文件",
  "minutes": 5,
  "source": { "kind": "project_file", "path": "status/review.txt" },
  "condition": { "kind": "contains", "text": "approved" }
}
```

`waitSchema` 独立校验 1—43,200 的整数分钟间隔、安全相对路径和严格字段。source 仅支持 workspace_file / project_file；condition 为 changed、exists 或带非空文本的 contains。once 拒绝 wait，不能用控制结果把单次任务升级为持续任务。

用户的 `CheckSpec.command` 与工具参数不同：它在 Core 中转换为 `run_command.args.argv`。固定检查不经过模型改写。`check()` 为整批验收创建唯一 batchId，冻结 taskRevision、planId、checksDigest、inputDigest。存在已消费等待时另存 observationDigest。每条 CheckReceipt 保存这些绑定及 node/final/maintenance scope。`batchMatches()` 核对绑定和来源当前内容，`batchCurrent()` 还要求该批通过；检查前后及节点/任务落状态时复核，变化会阻止成功，即使命令 exit code 为零。acceptedDigest 不重新读取一个未验证的摘要。

## 6. 持久化和恢复

`Store.update()` 在同步 SQLite 事务中读取任务 JSON、执行同步修改、保存并提交。不在事务中 await。任务创建、影响应用与决定回答把去重请求和对应状态一起提交。事件在同一次更新中追加，seq 严格递增。

异步效果前先持久化 pending。`executeRecorded()` 是模型工具和固定检查共用的回执入口。准入后的执行异常或结果写入失败标记 unknown；工具回调关闭 admission 并触发独立 fault AbortController，随后外层等待实际收尾。pending 写入失败时执行器不会被调用。

`unresolved()` 从动作回执计算未处置效果，不依赖节点是否被改为 stale。`requireRecovery()` 覆盖 Resume、修改/重试、drive、最终验收和决定处理，执行器准入另有检查。未知命令会冻结其他任务的新效果；未知只读动作不会触发该门。

恢复卡片是 `Decision.kind=recovery`，绑定 actionIds、actionsDigest、workspaceDigest 和证据 artifactId，Task/Plan 版本由 Decision 绑定。`decision.answer` 复核后，在一个事务中保存 resolution、回答和 requestId。保留并重新规划会创建新 TaskRevision；终态的 preserve-and-stop 只保存处置、保持终态。原 action.status 仍是 unknown。处置失败或证据变化不能解锁效果。

acceptance、model、recovery 使用显式 kind 分派，模型不能用问题文本伪装成宿主验收。当前恢复仍依赖用户查证；没有从 diff 推断命令未发生，也没有通用 exactly-once 保证。

工作树创建发生在数据库提交前，因此极端崩溃可能留下未注册的工作树。v0.1 保留它而不自动删除，便于手动审查，未实现垃圾回收器。

### 持久等待与维护观察

`readObservation()` 按 Task 的项目 ID 或 workdir 解析根目录，再用 realpath、设备/目录身份和来源声明形成 sourceIdentity。普通文件内容最多 32,000 字符；非普通文件、符号链接、越界、不可读或超大来源为 unknown。明确不存在的文件保存 digest:null，不与读取错误混为一谈。观察只读一个声明的本地文件，没有网络请求或 CI 平台身份校验。

`run()` 在 Runner 返回且无中止后才读取基线、保存 WaitState；TaskRevision/Plan 不符时拒绝登记。`observeWait()` 则核对当前 Task/Plan/Wait ID 和期限后更新最近观察。第一次来源不可达时，不臆造基线；之后首次有效读取建立基线。changed 比较内容摘要，不比较文件 mtime。

`observationSourceKey()` 按 nodeId、source、condition、sourceIdentity 分组；`observationKey()` 再包含内容摘要。consumedObservations 为 `Record<string, string>`，只保存每组最近已消费的摘要，消费时与 consumedAt 一同落事务。键不含 Run/Wait ID，连续重复登记相同信息不会再次调用模型；实际 A → B → A → B 不会被历史见过的 B 永久抑制。明确观察到 waiting 时删除该组最近消费记录，因此条件恢复成相同合格内容可以再次触发；unknown 不清除该记录。applyImpact 和非终态保留后重规划处置清空映射，events 保留历史。

`observationCurrent()` 对已消费 Wait 重读来源，要求可确定读取且摘要仍等于消费时记录；`assertObservation()` 在 drive、Run 开始、executeRecorded 的 pending 前后、Run 收尾、计划发布事务及非恢复决定接受入口复核，避免来源撤销后仍准入执行。`batchMatches()` 复用相同检查。三个原始独立反例未经修改复跑 3/3 通过，独立审查确认已解决且无未关闭发现；本次修复不能代替真实进程、外部服务和整个目标的验证。

`verifyMaintenance()` 新建有界 verification Run；固定检查通过且批次仍匹配才记 healthy，明确失败记 unhealthy，中止、读取/执行不确定或批次来源变化记 unknown。HealthObservation 保存最近 checkedAt、inputDigest、batchId、runId、reason。检查仍可能产生真实命令效果，unknown 命令回执会进入已有恢复门。维护不自动安排模型修复或重跑原 edit 节点。

`wake()` 由本机每秒定时扫描触发，将到期等待或维护任务加入 Set 队列。漏过多个周期只观察当前状态一次，missedIntervals 表示错过的完整间隔数，gapSince 指向上次观察时间；下一次从当前时间排期。系统休眠时没有观察，恢复后靠定时扫描补查；没有独立云进程或系统级常驻调度器。无来源的旧版 Wait 会阻塞并要求修订任务，不能回退为按时间调用模型。

`report()` 导出当前 wait/health 和 wait.*、maintenance.observed 事件历史，并保留检查的 observationDigest。数据库边界重建测试证明持久状态可以被重新读取，不等于已做真实进程强杀实验。

## 7. 前端状态

任务执行状态只来源于 `TaskSnapshot`。Renderer 持有当前项目/任务选择及可恢复 UI 偏好：主区 chat/activity/changes、规划 process/steps、graph/list、选中节点、详情页签、底部工具页签和输入草稿。

右侧规划开关存在 AppSettings；每个任务的节点和页签选择存在 TaskPreferences。打开或关闭不触发运行，切换语言不重建任务，不翻译原始模型输出、用户输入、命令或代码。

`PlanTracker` 在主对话呈现全部当前节点，以 activePlanId、TaskRevision 和 NodeState 计算已验证数量。`StepEvidence` 按节点的 runId 分离当前与历史产出；同名节点在另一版 Plan 中的记录不成为当前完成依据。`RunRecord` 用 runId + toolCallId 找到 tool.started 中的参数，并与 ActionReceipt 输出、检查和 Artifact 关联，缺失参数明确标为未记录。`DecisionRecord` 复用宿主决定文案规则，保留模型问题原文。

计划版本选择由 App 统一持有；当前步骤入口显式选择 current，手动切换的历史版本在侧栏关闭/打开期间保留。`EventStep` 同时用于主对话与活动记录，只为当前 Plan/TaskRevision 的节点提供当前步骤入口，旧事件显示历史标签。所选节点被新版删除时给出说明，不悄悄展示另一个节点。

`TaskObservations` 在主对话、规划过程与定时任务页复用，展示 Wait 来源/条件、最近观察内容与摘要、Task/Plan/Run 身份，以及维护健康、批次和漏查时间。标签来自中英字典；观察内容和来源错误保留原文。卡片从真实 consumedAt 显示消费时间，不以 satisfied 推断已消费。`scheduledStatuses` 为等待和三种维护状态提供暂停入口，两项已纳入本轮通过的 UI 回归。整体计划、todo、工具调用和决定逐步展开的强化尚未全部完成。

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

等待/维护的最小回归位于 `tests/core.test.ts`：来源不变不增加模型 Run、自身写入建立基线、来源不可达/过大/替换、跨 Wait 消费去重、暂停恢复先观察、漏周期合并、持久边界重建、观察变化使验收失效，以及维护失败/unknown 仅运行检查。新增来源在恢复前/Run 中撤销、显式改目标后使用现有来源、A → B → A → B 与不满足后恢复相同内容的回归。`tests/runtime.test.ts` 经真实 pi 协议验证 Wait 必填参数拒绝和终止后的写入不准入；`tests/ui-workbench.spec.ts` 验证双语观察卡片与维护证据。真实远端模型、真实休眠/强杀和自然长期任务仍需独立验收。

Codex 登录适配的合成回归位于 `codex-auth.test.ts`、`codex-runtime.test.ts` 及 Core/runtime 测试中，覆盖轮换、固定地址、到期取消、工具 ID 和脱敏；这些测试不使用用户凭据。实际账户与安装验证另见验证记录，公开文档不记录真实凭据、私有会话或本机私有路径。

修改执行协议时，优先在 Core 的状态入口和 Runner/Executor 边界补一个可观察失败的回归。不要让 Renderer 成为第二个调度器，也不要让模型自行填写 verified 或 completed。添加新工具必须同时定义参数边界、允许阶段、沙箱权限、回执与取消语义。
