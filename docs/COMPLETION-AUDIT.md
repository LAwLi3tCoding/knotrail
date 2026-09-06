# 全目标完成度审查

审查日期：2026-09-06。初次代码基线：`f689600`；本次更新读取其后的 Core、共享协议、测试和 Renderer，并同步 README、架构、代码及用户文档。本文不将上一轮测试通过或 `v0.1.0` 交付声明当作全部需求完成的证明。此前固定验收一致性、规划发布和 unknown 恢复门修复已有独立复核；本轮 M3 文件观察、维护复验及相关修复已通过回归、独立复核和实际打包态验证；这次局部交付已验证，完整目标仍未完成。

**结论：完整目标尚未完成。** 已有真实 pi SDK、Electron/React、SQLite、工具执行边界、双语工作台和公开交付所需工程文件。规划来源复核、统一验收批次、未知效果恢复准入与持久用户处置之后，本轮又加入带来源/条件的本地 Wait、跨 Wait 消费记录、漏查合并，以及不重跑写节点的维护固定检查。本地路径已通过本轮局部交付验证；选择性复用、文件效果自动查证、完整崩溃实验、真实开发案例与同题比较仍有实现或证据缺口。账户认证接入与真实模型验收只是其中一部分，不能替代下文列出的开发工作。

认证与步骤展示阶段：Codex access-only 登录、受限网络重试与凭据过滤已实现并独立复核；主对话整体步骤与逐 Run 工具/产物/决定记录已实现，两项当前/历史导航反例原样复跑通过。该阶段 check 为 80 项（79 通过、1 项预期跳过），UI 14/14，打包态模拟服务任务通过。真实 Astra 已完成只读调研并提交有效计划，但源代码与打包桌面的完整任务均被响应头前 ECONNRESET 打断；本机安装及真实完整任务仍未完成。品牌统一以普通英文文本 Knotrail 展示，界面已移除独立 K 图标。

固定验收修订阶段：用户现在可编辑检查、审阅旧新定义并生成新 TaskRevision；旧计划与回执保留原定义，新保护路径在真实沙箱中生效。当前 check 为 84 项（83 通过、1 项预期跳过），UI 24/24；独立审查发现的取消重开与迟到 Apply 丢稿问题已修复，两份原始反例原样复跑通过，最终结论为 pass。开发态和最新打包态的受控桌面修订链均通过，包含重新规划、保护文件拒写、两次固定检查及版本导出。完整产品目标与真实账户验收仍保持未完成。

2026-09-07 新增要求：默认快速开启会话并在同一工作区持续对话，无需每次填写大量配置。快速入口、task.message、同会话历史和逐消息预算已实现；Core 50/50、真实 pi 与 Codex 协议 17/17、全套 UI 46/46 与开发态两轮对话桌面链路已通过。审查发现的侧栏回退、偏好丢稿和同事件序列旧快照覆盖暂停状态，三份原始反例原样 3/3 通过；实际桌面发现的滚动跟随问题也已修复，最终打包态原视口断言通过，九个构建文件摘要一致，最终独立复核为 pass。输入/产物绑定的只读分析已完成，尚未实施，仍保留在后续范围；完整产品目标继续保持未完成。

## 1. 审查口径

需求来源为 [实施计划](../IMPLEMENTATION-PLAN.md) 的 M0—M4、T01—T20，[运行时路线](../RUNTIME-GUIDE.md) 的阶段内 L 项，以及 [产品方案](../PRODUCT-BRIEF.md)、[界面约定](../UI-DESIGN.md)、[原 v3 设计](DESIGN-V3.md)。文档顶端将当前能力转交给 README 的交付说明，不撤销这些已由用户要求实现的原范围。

状态定义：

| 状态 | 含义 |
| --- | --- |
| 已有实现 | 能定位真实代码和相应测试断言；仅证明所列范围，不自动证明整项 oracle |
| 部分 | 有运行路径，但遗漏原要求的一部分，或测试只覆盖较窄场景 |
| 缺失 | 当前协议、代码或实际验收材料不存在所要求的行为 |
| 进行中 | 本轮另有实现者正在修复；不能提前记为通过 |
| 外部依赖 | 需要真实模型服务或真实使用者等外部条件；仍保留要求 |
| 原定后置 | 原方案明确不要求首版交付，不能误算成本次阻塞项 |

本报告没有重新执行测试、访问线上模型或核验 GitHub 远端；测试来源指向的是当前测试文件中的实际断言。完整发布仍需由交付负责人读取最终提交、当次测试结果、远端仓库可见性、远端 SHA 和 CI。已有 [验证报告](VALIDATION.md) 是历史运行记录，不替代上述当前证据。

上一轮 `npm run check` 为 46 项（45 通过、1 条反向沙箱能力分支跳过），UI 为 7 项；当时打包的实际 Electron App 经真实 pi SDK 和回环协议服务完成沙箱改文件及两次固定检查，Renderer 错误为 0。该轮独立审查发现的跨任务终态复活和真实 pi 缺失用量补零均已复现、修复并复跑通过。这些是此前代码的证据，不能直接覆盖本轮新增调度路径。

M3 首轮 `npm run check` 为 55 项（54 通过、1 条预期反向沙箱能力分支跳过），其中 Core 33 项、runtime 7 项。后续独立审查复现了来源消费后撤销仍可执行、显式修改目标后无法使用已有合格来源、A → B → A → B 被终身去重拦住的三个反例；对应实现已修复，原反例回归通过，并补了 Run 中撤销与条件恢复等边界。

M3 当时的 `npm run check`：60 项，59 通过、1 条预期反向沙箱能力分支跳过，其中 Core 38 项、runtime 7 项；typecheck 与 build 通过。当时 UI 9/9 通过，包含托管状态 Pause 和真实 consumedAt 展示。本报告没有自行重跑这些命令。独立审查已正式通过，open_findings=[]，三个原始反例未经修改复跑 3/3 通过，四项修复均已解决。重新打包的实际 App smoke 也已通过：packaged=true，真实 pi SDK 与回环协议服务完成两项固定检查，右侧规划、中英切换及加密安全存储正常，rendererErrors=0。本轮局部交付验证已完成。持久 Wait 的数据库边界重建不等于真实进程强杀，loopback pi 也不等于真实远端模型或自然任务验证。

## 2. M0—M4 阶段

| 阶段 | 目前成立的部分 | 尚未成立的原要求 | 判定 |
| --- | --- | --- | --- |
| M0 桌面交互 | Codex 式三栏、双语与独立右规划；主对话 PlanTracker、StepEvidence、工具参数/输出、决定及历史；节点状态与 Plan/Run 身份绑定，删除节点说明；UI 14/14，当前/历史两项导航反例复核通过；纯文字品牌展示及窄屏检查通过 | 真实用户三个交互问题、同宽参考界面对照、完整宿主错误双语和真实重载/断连仍缺证据；本轮步骤全景截图主要为浅色 | 部分；本轮逐步展示已实现 |
| M1 真实规划到执行 | `pi-worker.ts` 显式 SDK 与资源白名单；`service.ts` 只读规划、Ready、节点 Run；候选在 Runner 收尾后核对 taskRevision/旧 planId/工作区 inputDigest 再发布；Ready 后首次执行前变化会重新规划；该发布门已有独立复核，另有真实 Electron 单文件 smoke 与 OS 边界测试 | 真实依赖升级未运行；逐来源输入、实际产物和授权条件未进入完整校验；实际提交后强杀实验仍缺；detached/setsid 后代清理仍不满足完整收尾边界 | 部分；真实模型验收有外部依赖 |
| M2 节点证据与改计划 | 真实动作、Run、artifact、check、计划版本、一次性影响预览；目标修订保留旧 Plan；CheckBatch 绑定 taskRevision/planId/checksDigest/inputDigest，节点及最终提交复核；本轮增加等待观察摘要及固定验收修订、版本化检查历史 | 改目标一律丢弃所有节点完成资格，无合格独立分析复用；缺实际产物消费引用和逐来源输入身份；两个真实开发题及中途改约束未运行；T12/T18 原修复及本轮观察扩展已有独立复核 | 部分，所列修复已复核 |
| M3 局部继续与托管 | 现有 worktree 上新 Run；恢复门与持久 typed recovery 处置；WaitState 绑定 Task/Plan/Run/Node、来源/条件/身份/基线；最近消费摘要映射、真实再次变化、显式修订清空去重、漏周期合并；新增 observationCurrent/assertObservation 复核执行与发布准入；维护专用 verification Run 和 observationDigest | 无文件前后状态 witness 和自动后置状态查证；真实强杀/休眠及完整后代收尾实验不足；独立发现的三个反例已修复，回归和独立复核通过；局部复用无完整输入证据；真实长期任务未运行。CI adapter 仍是原条件项，未实现 | 部分，本地托管局部交付已验证 |
| M4 同题比较与交付 | 构建、打包、导出命令、CI 定义、原理与代码文档存在；已有交付记录另待最终远端回读 | 三类真实任务、充分配置的 1—2 个基线、人工总分钟/重复工作/用量/维护成本和继续使用意愿未记录；没有满足“至少两项降低人工总分钟”等投资门槛的材料 | 交付工程部分存在；比较验收缺失 |

## 3. T01—T20 验收逐项映射

下表把一个 oracle 中的多项要求分开判断，不能用其中一条成功断言给整行盖章。

| ID | 当前代码/测试证据 | 缺口与所需证据 | 状态 |
| --- | --- | --- | --- |
| T01 | `service.ts` 的 `onTool` 拒绝 Planner 非读工具；`pi-worker.ts` 规划工具清单只有读取/控制；`validation.ts:validatePlan` 校验 DAG、依赖、ID、固定检查覆盖；`core.test.ts` 前两项、`runtime.test.ts` 首项 | Core fixture 仅主动试 write；缺实际 pi 对任意 shell/项目脚本的拒绝场景。输入、预期产物和来源允许为空/任意字符串，未校验必要前置问题与授权范围 | 部分 |
| T02 | `onControl(update_plan)` 以 Run 内 draftSequence 拒绝旧草稿；提交只保存候选，Runner 收尾后在事务中核对 taskRevision/旧 planId/inputDigest 才建立 Plan 和 Ready；候选提交后来源变化拒绝发布、Ready 后变化重规划的 Core 回归已有通过结果和独立复核 | 截断 JSON/`stopReason=length`、重复乱序草稿和实际进程提交后强杀尚无完整集成断言；这些剩余触发不能由现有来源变化测试替代 | 部分，发布门已修 |
| T03 | IPC 严格 schema 不允许 Ready/status 字段；expectedRevision、一次性 host 签发 preview；`core.test.ts` 检查旧 revision、篡改/replay、取消后旧决定 | 没有绑定“人工开始所审阅 Plan 摘要/授权”的独立凭据；`task.resume` 仅 task revision，未测试同 TaskRevision 换 Plan 后晚到开始；计划授权校验仍不完整 | 部分 |
| T04 | `task.create` 在同一 DB 事务保存 Task 和 requestId；重复请求返回同一 Task；requestId 参数冲突在 `Store.request` 拒绝 | 缺首次 pi 消息前真正终止宿主再启动的案例；现有恢复测试直接插入 running/pending 记录，不能证明该崩溃窗口。worktree 创建早于事务，可能留下未注册目录，已有代码文档披露 | 部分 |
| T05 | `execution.test.ts` 覆盖路径越界、符号链接、受保护文件及祖先目录重命名；`workspace.test.ts` 覆盖 Git filters；Main 只读相对路径；执行全程进 helper | [安全边界](SECURITY.md) 已确认 detached/setsid 后代可以脱离进程组。文件/网络限制与全部后代效果停止是不同承诺，不能以“可信项目”说明替代原 oracle 的后代收尾 | 文件边界已有；完整效果边界未满足 |
| T06 | `PiRunner.run` abort 与外层等待；`SandboxExecutor` killGroup；`execution.test.ts` 普通后代取消/宿主突然死亡与 EPERM 收尾测试；`core.test.ts` Run deadline | 缺不响应 provider 的独立超时案例；恶意/主动脱离进程组的后代仍可能活动，未确认停止时的新 owner 写入不能保证 | 部分 |
| T07 | `lock.ts:acquireOwnerLock` 内核锁、规范路径；测试重复宿主/别名/helper 持有租约/Main 死亡 | 合约没有 `hostEpoch`，Worker/RPC 没有 epoch；无真实旧 IPC 延迟到接管后的拒绝实验；逃逸后代可能不保留 fd。现有单 fd 和普通进程组测试不足以支持全部接管场景 | 部分 |
| T08 | 所有工具 sequential；合法控制后 parent admission=false、worker abort；runtime 首项将 submit 放在批次前、后置 read 不执行；普通文本自称完成会失败 | 缺终止控制位于首/末并混合 write、前序效果尚在收尾的完整矩阵；普通文本拒绝已经有断言，不能据此推出混合效果均满足 | 部分 |
| T09 | `App.tsx` 订阅后读完整快照；规划开关只存 settings；主对话显示同一 Decision；UI fixture 验隐藏更新、节点/页签保留及主对话回答 | 当前测试没有销毁/重连 renderer 后恢复同一最新快照，也没有断连期间 worker 持续推进与无 submit 重发断言；selectedNode 被新版移除时只回退首节点，没有明确说明 | 部分 |
| T10 | 预览先 `stop`，应用 preview 校验 revision、planId、workspaceDigest、原件和幂等 ID；旧 Plan 保留 | 目标变化测试发生在 Ready，非运行中改约束；缺旧 Worker 迟到事件与新版草稿竞争的集成测试；事件函数用当前 taskRevision/activePlan 默认值，需要按旧 Run 来源证明归属 | 部分 |
| T11 | 单节点 retry 计算显式 DAG 下游；objective 变化保守失效所有节点 | 没有证明有效的独立分析复用。`inputs/outputs` 只是字符串；没有来源 hash、消费 artifact ID 或 unknown shell 输入模型。retry 对非下游保留只看连线，不先核对该节点实际输入是否改变 | 缺少核心能力 |
| T12 | `CheckBatch` 同批绑定 taskRevision、planId、checksDigest、inputDigest；检查前后、节点及最终提交复核；本轮新增已消费 Wait 的 observationDigest，`batchMatches()` 重读来源；Core 覆盖观察在检查后撤销导致节点失败、不设置 acceptedDigest | 工作区批次修复和本轮观察扩展均已有独立复核；单个本地 Wait 不等于完整环境/外部来源向量。CI 身份验证为原条件项“真实案例需要 CI 时”，尚无案例选择与 adapter 证据 | 所列修复与观察扩展已复核 |
| T13 | CheckSpec 保留在 Task，不由模型计划覆盖；遗漏 check ID 阻止计划；protectedPaths 在工具和 sandbox 同时限制；旧人工接受摘要失效有测试；现有 previewRevision/applyImpact 已支持用户 checks 修订、TaskRevision 历史、旧新定义预览、保护路径更新和旧决定失效，Core 新增四项回归及 SQLite 最后写失败回滚通过 | 受控桌面验收修订任务已通过，真实自然开发题仍未完成；检查文件变更目前混在 diff，缺专门有效性/覆盖说明；旧接受和最终累计补丁的进一步一致性与 T12/T18 一并复验 | 部分 |
| T14 | previewRetry 停止任务，applyImpact 事务标所选及下游 stale，并清 acceptedDigest；新增恢复门，unknown 未处置时拒绝 preview/apply；用户保留当前文件后新 TaskRevision 重新规划，不 reset/stash/clean | 非 unknown 的外部改动在 retry 预览前仍未完整 reconcile，非 DAG 下游旧 verified 可能被保留；新 attempt 仍在之后 `run()` 单独事务登记；缺“人工修改＋活动下游＋旧 pass”完整端到端测试 | 部分 |
| T15 | 启动 pending→unknown；新增 `unresolved/requireRecovery` 和共享 `executeRecorded`，恢复/影响变更/drive/固定检查/finalize 不能越过未处置效果，read/list/search unknown 不冻结；回执写失败关闭 admission 并 abort；未知命令阻止其他 Task 执行；typed recovery 绑定动作集合、工作区摘要、Plan/TaskRevision 和证据 artifact，持久 preserve-and-replan 或终态 preserve-and-stop，历史 status 仍为 unknown。Core 新回归覆盖新 toolCallId、影响路径、timer/其他任务、陈旧决定、终态处置与处置事务失败 | 尚无逐文件 before/after witness 和自动后置状态确认；恢复事实目前为用户处置，不能称自动证明已执行/未执行。真实强杀、启动窗口及任意后代收尾未全验；持续存储故障与保留后后续计划不重发旧语义操作仍需扩展证明 | 部分，恢复准入已实现 |
| T16 | `WaitState/readObservation/observeWait` 实现本地 source/condition/身份/基线、Run 收尾登记、consumedAt；consumedObservations 改为每节点/来源/条件的最近摘要映射，支持 A → B → A → B 和不满足后恢复相同内容；applyImpact/非终态恢复处置清空去重、events 留历史。observationCurrent/assertObservation 在 drive/Run/工具准入/发布/非恢复决定处复核；Set 合并 missedIntervals/gapSince；维护只运行固定 batch。Core/runtime/UI 对应回归已通过 | 三个原始独立反例复跑 3/3 通过，独立复核和重新打包态 smoke 均通过。真实休眠/强杀/自然隔夜任务仍缺。旧无来源 Wait 明确阻塞要求修订；CI adapter 未实现，仍按原案例条件触发 | 部分，本地等待/维护局部交付已验证 |
| T17 | 实际 turn.started 累加 task.turnCount；剩余 maxTurns 传每次 Run；Run timeout、绝对到期、取消及最后允许 turn 完成有回归；新增相同信息重复等待不增加模型 Run、新信息释放后耗尽预算不再启动模型的断言；verification Run 无模型轮次 | 消费指纹覆盖等待信息，尚无通用无进展/重复失败停止依据；没有任务总 elapsed 预算或每 Run 工具上限；反复重规划的预算覆盖仍需验证。必须按原约定明确各预算覆盖，不以一个 maxTurns 代表全部 | 部分 |
| T18 | SQLite 同步事务与内嵌 artifact；新增批次最终 CAS 及 `executeRecorded`：准入后抛错/回执事务失败记 unknown，Run 关闭准入并 abort，持续写库失败置内存 effectsFrozen。Core 已有 pending 写失败零执行、文件已写但回执丢失不再准入、artifact 提交失败不完成、恢复处置事务失败继续冻结，以及最终检查后变化回归 | 新故障路径已有当前测试和独立审查；现有注入以 Store.put 抛错为主，尚未证明真实 SQLite I/O 故障、磁盘满/强杀和持续恢复失败的全部窗口 | 修复/故障回归已复核，真实故障实验待验 |
| T19 | 右侧 CSS、窄屏 drawer、inert、Escape、焦点返回；UI 测试检查右侧/焦点/溢出 | 测试宽度是 390/736/1024，原要求 360/736/1024；App minWidth=760，实际桌面不能在 736/360 复现同一壳；没有每宽全部面板组合和深浅主题对照 | 部分 |
| T20 | system/zh-CN/en、独立 responseLanguage；typed acceptance/recovery 文案保留模型问题原文；缺失用量显示 Unavailable/Partial usage；新增等待/维护共享双语卡片、观察摘要和 verification Run 用量区分，Codex 设置与登录/连接错误已本地化，UI 14 项通过 | 宿主 `task.error`、impact.reason、capabilities.reason 和原始来源错误仍需完整双语边界。尚未断言切换前后所有 ID/版本/命令集合不变或跨重启 locale 恢复 | 部分 |

## 4. L01—L16 与高阶实验

按实施计划 §6 的映射评判；不把明确后置的 Harness、热 steer、PTC、多 Agent 强加给首版。

| 实验 | 阶段适用性与当前证据 | 仍需完成的验证 | 状态 |
| --- | --- | --- | --- |
| L01 最小循环与流 | M1；`runtime.test.ts` 经真实 pi 和 loopback HTTP 读工具后第二轮提交；text_delta 与真实 session 文件存在 | 没有旧 partial 快照不随后续 token 变化的断言；fixture 流只发单段 content，再发结束 | 部分 |
| L02 上下文与 payload | M1；worker 将 objective/checks/plan/node/context 送 prompt；HTTP fixture 捕获 requests；本轮 context 增加实际 Wait 来源、身份、时间、内容和消费记录，Core 断言内容进入后续 Run | AGENTS/Skill 自动发现全部关闭，未有显式白名单材料注入或缺一资源的 payload 对照。近 8 条 Run 摘要、决定和单个 Wait 仍不能替代已采用前驱产物内容/来源 | 缺少所约定实验与部分功能 |
| L03 参数与权限 | M1；TypeBox 工具 schema、Zod IPC、helper 路径与预期 hash 有测试 | 没有数值字符串/非法额外字段/参数准备转换后的最终策略断言；未接 hook，不能声称其改参后重验已实验 | 部分 |
| L04 顺序与并行 | M1 生产取 sequential；worker 和 Agent 显式 sequential，父 RPC Promise 串行 | 缺两延迟工具的完成顺序/模型结果顺序对照；并行不是生产必需，但学习实验未有可运行证据 | 部分 |
| L05 阻止与终止 | M1；Planner write 拒绝、submit 后 read 未调用、文本不能完成 | 缺 allow/block/terminate 混合批次与后置 hook 不反转 deny 实验；生产未接 hook 不等于这项实验已通过 | 部分 |
| L06 steer/followUp | 原方案按需后置；当前没有热 steer API | 原方案未要求首版实施，不计本次阻塞 | 原定后置 |
| L07 两种取消 | M1/M3 的 SDK/工具路径；真实 helper 普通后代、PiRunner 等待清理有回归 | provider 等待与忽略信号/脱离进程组边界未全满足；Harness RPC/operation 取消属于后置 | SDK 部分；Harness 后置 |
| L08 持久接受/崩溃 | M1/M3 SDK 部分；Task 接受事务、合成 running/pending 恢复；新增文件效果后回执提交失败、换 toolCallId 仍不执行、unknown 处置失败继续冻结的 Core 回归 | SDK 首轮前真实强杀、真实进程效果前后崩溃尚未完成；没有自动文件 witness 查证；Harness accept/drive 不在生产路径 | SDK 部分；Harness 后置 |
| L09 压缩与分支 | 未列入首版阶段必做；worker 显式关闭 compaction，每 Run 新 session | 高阶成本/投影对照未运行，不应标为生产能力，也不阻塞首版 | 原定后置 |
| L10 资源/插件生命周期 | pi 项目扩展 poison 哨兵测试证明默认发现未运行 | DSH profile/bundle、重复激活/退出/冲突撤销不存在实现。原方案首版只运行随包可信代码，不需要第三方插件执行；如将静态贡献生命周期列为交付，仍需最小真实实现与测试 | 资源禁用已有；生命周期未实现 |
| L11 watch/重连 | M0/M2 产品层；App 全量 snapshot 与订阅通知，不由 UI 改执行状态 | 未测试先快照/插入事件竞争、销毁 UI 后 worker 持续与重连无 submit；Harness watch 后置 | 产品层部分 |
| L12 回归/配方演进 | 原方案明确后置；没有 Skill 版本实验 | 非首版门槛，不要求添加自演进系统 | 原定后置 |
| L13 规划权限/发布 | M1；见 T01/T02；真实 pi 清单与 Core DAG；新代码在 Runner 收尾后校验规划工作区和版本再 Ready，首节点前来源变化会重规划；相应 Core 回归已存在 | 缺无效/截断计划实际协议端到端、逐输入来源/产物契约及真实提交后强杀实验；本轮发布路径已独立复核 | 部分，发布门已修 |
| L14 节点/前端归属 | M0/M2；Core 两节点回归、UI fixture、桌面单真实节点链；UI 按 planId/taskRevision/Run/批次区分 Current/Historical；maintenance scope、observationDigest、共享观察卡片及真实 consumedAt，新增 PlanTracker、RunRecord 与决定回看，UI 14/14 通过 | 缺真实两节点与断 UI/重开整体链，当前有效性与后续节点修改输入仍需端到端证据；该展示已实现，真实两节点链仍需补验 | 部分 |
| L15 修订/失效 | M2；版本历史、签发影响预览、旧 revision 拒绝 | 合格分析复用、来源输入未变证明、未知依赖保守失效缺实现；晚到 pass 见 T12；UI fixture 的 retained research 为人工设定，不是 Core 计算证据 | 核心能力缺失/部分进行中 |
| L16 局部继续 | M3；恢复门现已阻止未处置 unknown 后续运行，Core 回归包含用户文件变化使旧恢复决定失效、新决定保留文件后重新规划，以及同 Run 换 toolCallId 仍不重复效果 | 自动本地效果 witness 与真实强杀恢复尚缺；不能用 Core fixture 证明真实 pi/执行器/桌面整条恢复链或完整后代收尾 | 部分，恢复前置已实现 |

PTC、候选记忆有效性实验、多 Agent、跨仓/多人、云执行、第三方任意代码隔离和外部业务写幂等均属于原方案后置。它们不构成本次未完成的理由。当前已承诺的本地执行收尾和来源查证不能因这些后置项而跳过。

## 5. 其他明确产品和文档要求

| 要求 | 当前证据与边界 | 判定 |
| --- | --- | --- |
| 产品名字 | README、窗口、package 使用 Knotrail；界面仅显示普通英文文本 Knotrail，不使用中文别名或独立品牌图标 | 已有 |
| 快速会话与连续对话 | 默认入口仅需项目与消息；同一 Task/worktree 追加消息并重新规划，保留历史；无检查的一轮显示 idle/finished，不冒充验收通过；高级计划任务保留原流程 | 本轮 Core、协议、UI、开发态与打包态桌面回归通过，独立复核 pass；模型智能表现仍需真实账户任务验证 |
| 基于 pi，参考 Codex 与 DSH | 真实使用 pi 0.85.1；Codex/DSH/Catdesk 布局来源有记录；主视图实际存在。DSH source/context/tool/check 仅四个静态说明，没有 profile/bundle 生命周期 | SDK 已有，借鉴实现部分 |
| 可见规划全过程与节点产出 | draft event、最终 Plan、Run、工具事件、artifact/check 全由 Core 产生；旧 Plan 可选；UI 已按检查批次和版本身份展示当前/历史记录，并补观察来源与维护批次 | 基本路径及新增证据身份已有；typed 输入、实际消费产物和完整有效性证明仍欠缺 |
| 不能只呈现最终结果 | App 过程、活动、历史、检查、diff、事件展开均存在 | 已有 |
| 强化整体计划、todo、工具调用和决定的逐步展示 | 主对话整体待办、当前与历史 Run、工具参数/输出/检查/产物、已记录决定与回答；关闭规划栏仍能查看 | 已实现；动态 UI、独立反例和打包模拟服务通过，真实完整任务受网络阻断 |
| 右侧规划独立开关 | UI 状态独立于 task 命令，开关默认关闭并持久化，主对话仍展示决定 | 已有；断连与精确宽度证据仍见 T09/T19 |
| 原计划可修改任务目标/范围/必需验收 | `task.previewRevision` 接受 objective / checks 至少一项，签发预览中比较完整检查定义；应用后新 TaskRevision 重规划。Renderer 编辑与历史定义已接入，维护拒绝空检查，旧接受失效 | 固定验收修订已实现并通过受控桌面链路；真实开发题仍缺证据 |
| 日常开发可运行 | 可以在干净 Git 源仓库建立普通文件 worktree；读写/argv/check 真执行 | 真实依赖升级与 API/页面/测试题未验证；symlink/submodule/未提交源修改明确拒绝，工具链依赖复现未覆盖 |
| 详细原理文档 | `ARCHITECTURE.md` 解释进程、Task/Run/Plan、回执、检查、持久化、安全边界；本轮补来源/基线/消费、维护复验和漏查 | 已同步本轮修复和验证状态，不可用文档替代原要求 |
| 详细代码文档 | `docs/CODE-GUIDE.md` 增加 Wait 控制参数、观察/维护函数链、持久字段和边界测试；`USER-GUIDE.md` 增加实际登记、来源边界、修复和漏查操作 | 已有；来源撤销/修订边界和全目标缺口仍保留 |
| 导出版本/节点/动作/检查引用一致 | `service.ts:report` 导出 Plan、checks、artifact Run/digest、完整 ActionReceipt/Decision 处置；本轮加入 wait/health、观察事件历史与 CheckReceipt.observationDigest | 原有和新增身份字段已写入导出；尚无完整输入/覆盖向量，新字段及引用需在本轮最终导出验收中核对 |
| 创建 public GitHub 并推送 | 仓库工作流和已有交付记录存在；此只读审查未执行 GitHub 操作 | 交付负责人最终回读 public/SHA/CI，不根据聊天认定 |
| 最新 Astra 与 Codex 账户登录接入 | 每 Run 只读已有 ChatGPT access token，固定官方 SSE、到期边界、凭据过滤，认证与传输独立复核通过；实际 Astra 返回只读工具与有效计划 | 接入已实现；完整源代码及打包桌面任务均遭遇响应头前 ECONNRESET，不能称完整真实任务通过 |
| 本机安装后实际使用验收 | 用户新增要求在实现完成后安装到本机，并通过实际授权会话完成真实任务 | 本机安装和该路径的实测尚未完成；旧打包 smoke 不能替代安装、登录、实际开发链路验收 |
| 我们有何优势/业内价值 | 原方案有明确假设与竞品研究 | 没有自然任务数据支持实际优势；必须完成 M4 同题比较，不能从更完整流程图推出成本更低 |

## 6. 优先继续实现的工作

以下是当前无需真实 API key 就可推进的工作，按阻止假成功/重复效果的优先级排列。不是新增路线，也不是缩小用户要求。

1. **补足 T12/T18 的真实故障证据。** 工作区批次、存储修复及本轮观察修复已有独立复核和打包态验证；前一轮完整 check 84 项中 83 通过、1 项预期跳过。验收修订与快速会话均有真实 SQLite 事务最后写失败的回滚验证；后续仍需构造真实 I/O、磁盘满和强杀窗口，不能将触发器、Store.put 注入或当前通过结果当作这些实验已经完成。
2. **补全已有 unknown 恢复门的自动查证和真实故障证据。** 普通 Resume、影响变更、drive/wake、固定检查及完成入口现已受门控制，未知命令冻结其他 Task，用户处置绑定动作、Plan/版本、workspaceDigest 和 artifact，原 unknown 历史保留。下一步为确定性文件操作保存前后 witness，只自动确认确实可证明的当前后置状态；命令仍由用户查证处置。补实际强杀和保留后不盲目重发旧效果的端到端验证。
3. **建立最小、可验证的输入和产物引用。** 对研究节点保存读取文件摘要、节点语义、实际产物 ID；Node prompt 带入有效前驱产物。改目标或 retry 时只复用证据仍适用的分析节点；shell 隐含覆盖或共享文件不明则说明原因并扩大重读/复验。不能先按 DAG 保留，再假设输入没变。
4. **验证已实现的候选与 Ready 分离，并补齐输入契约。** 新代码已在 Runner 收尾后复核 TaskRevision/旧 Plan/工作区来源，Ready 后首节点前变化也会重规划；相应 Core 回归已增加。下一步补截断草稿、迟到旧事件、真实提交后强杀，及声明输入/产物/必要条件的校验。
5. **继续完成固定验收修订的自然任务验收。** API、表单、旧新定义比较、TaskRevision、保护路径更新和旧接受失效已经实现；Core 四项新回归、UI 十项新回归、独立反例及开发态/打包态受控案例通过。它不是自然模型完成 API/页面/测试功能的收益证据；仍须在原定真实开发题中使用这一能力。
6. **完成本地 Wait 与维护路径的验收。** 来源/条件/基线、最近消费映射、漏周期、unknown 观察和专用固定维护检查已经实现，来源撤销与修订去重反例已修复。本轮独立复核和打包态验证已通过；继续验证真实启动/休眠、强杀恢复、期限/暂停/取消竞争和完整导出；用隔夜变化任务确认多次观察。CI 平台只读 adapter 仍按真实案例是否需要触发，不把本地状态文件视为 CI 身份验证。
7. **补足逐步展示的完整使用证据和双语。** 主对话整体计划、todo、逐次工具/产物/决定、历史身份与移除节点说明已实现，UI 14/14 与独立导航反例通过。继续补 Core 自有错误/影响原因本地化、完整暗色、重载偏好、原文/命令不变及真实恢复交互；不要将本轮浅色截图推广为所有状态已验证。
8. **准备真实题和同题比较材料。** 建立两个真实小项目题及隔夜变化题，固定起点、检查、约束变更时机、授权、预算、记录格式；先用协议 fixture 验证收集链，随后接真实模型，允许基线使用其成熟计划/项目规则。记录人工总分钟、重复工作、验收准确性、总用量和失败，不能将合成脚本收益替换自然使用结果。
9. **完成本机安装与真实任务验收。** Codex 登录适配已实现并复核，实际 Astra 已提交计划；当前源代码和打包桌面完整任务受 ECONNRESET 阻断，无凭据请求也能复现，IPv4/IPv6 或关闭连接复用均未消除。保留真实失败记录，继续定位或在网络恢复后验证；不能反复无界重试或扩大权限获得绿灯。实现原范围后安装到本机，配置登录类型并用真实任务验收；公开材料只记录能力与结果。

宿主后代终止缺口也必须解决或保持明确未完成：原方案要求隔离不成立时在 VM/container 中继续实验，未授权把要求降为“仅普通子进程”。可先对本地 sandbox 的限制构造持续回归、选择一个可实现的隔离后端并验证真实工具链；不要仅修改安全说明后标 T05/T06/T07 完成。

## 7. 最终关闭目标所需证据

- 原 M0—M4 与 T01—T20 所有首版必需项有当前实现和覆盖原触发的证据；明确后置项保持后置，条件项说明实际案例是否触发。
- 原型 fixture、Core 替身、真实 pi loopback、真实桌面、真实远端模型、自然任务比较分别记录，不互相冒充。
- 最终代码经适用测试、真实 macOS 打包态启动及关键任务链验证；安全收尾、未知效果和过期验收等已知失败路径修复后独立复核。
- 两个真实开发题和隔夜变化题有当前输入上的固定验收、必要人工审阅和全过程产物；强基线比较有版本/配置/成本口径及实际结果，允许结果“不占优势”。
- 最终原理/代码/使用/安全/验证文档与实现一致；不再用“待实施”正文和已交付声明互相覆盖；公开仓库最终 SHA、public 状态与 CI 读回一致。
- 用户新增的整体计划/todo/工具调用/决定逐步展示有实际界面验收；本机安装、Codex 登录和真实模型任务分别有完成证据，不能由构建或协议替身替代。

在上述证据齐备前，应报告“可运行工程已交付，完整原方案继续实现”，不能把该状态改写为“全部完成，只差填写 API key”。
