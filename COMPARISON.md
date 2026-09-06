# Knotrail（程迹）：竞品对比与优势判断 v3.1

> 交付更新（2026-09-06）：可运行的 v0.1.0 已实现。本文保留设计与研究背景，当前能力、限制和验收以 [README](README.md)、[实现架构](ARCHITECTURE.md) 与 [验证报告](docs/VALIDATION.md) 为准。
核对日期：2026-09-05。本文比较官方文档和公开源码已描述的能力，与 Knotrail 的待实施设计。没有同题产品实测、性能排名、市场规模或独家能力证明。可用性还受版本、套餐、组织策略和部署方式影响；没有找到文档不能推导产品没有某项功能。

## 1. 新结论

**“先规划、计划画图、节点可展开”值得做好，但已经不是空白市场。** Cursor 有流式 Mermaid 计划，Devin 有步骤活动，Kiro 有需求—设计—任务及验证关联；Codex App Server 已提供计划文本流、步骤状态和执行 items。OpenClaw Workboard、Mastra Factory 进一步构成可扩展的产品替代。

Knotrail 的主线改为：**计划可以改，过程看得清，已有成果接得上。** 它是一款基于 pi 的桌面编码工作台，主界面沿用 Codex 的对话工作方式，规划侧栏由用户独立开关，执行图关联真实节点产物。持续委托负责隔天继续和等待条件，不再单独承担产品定位。

最值得验证的是一个操作闭环：用户中途改要求 → 看见计划差异与影响 → 核对已有成果 → 在当前工作区修改受影响部分 → 重新验证当前交付。用户获得的好处应是少解释、少查找、少重复劳动，而非更多日志或更复杂的流程图。

这不是已建立的技术壁垒。现成产品加插件可能完成同样的事情。独立桌面是本项目明确选择的交付形态；它对其他用户是否更值得采用，仍需比较接入、日常使用和维护的总成本。

## 2. 应当怎样比较

| 比较对象 | 实际提供什么 | 应比较的问题 |
| --- | --- | --- |
| 编码产品 | 编辑器或桌面、模型与工具、工作区、计划、检查与交付 | 同一任务在修改要求、中断、接管时，哪一种更少人工且交付正确？ |
| 持续 Agent 产品 | 任务、事件、调度、插件与状态界面 | 是否已经能承载我们的计划和节点语义？定制需要多少代码？ |
| Agent / 工作流框架 | 图、状态、模型调用、调试、执行与恢复 | 哪些能力可复用？采用后还要编写哪些产品与业务规则？ |
| 持久任务框架 | 队列、定时、等待、重试、跨 worker 恢复 | 当前部署是否需要这些机制？外部动作与项目事实由谁核对？ |

一次模型运行很长、进程能恢复、事件能触发任务、任务跨多次运行保持一致，是不同能力。可视化图、调试器 time travel、文件回滚和外部业务动作恢复也不是同一件事。

比较时必须区分“官方明确描述”“文档未能确认”“我们拟实现”。下表中的待验证项均表示对照实验问题，不是对竞品能力缺失的断言。

## 3. 编码 Agent：规划和过程展示已经很成熟

| 产品 | 当前官方证据 | 对 Knotrail 的直接约束 |
| --- | --- | --- |
| **Codex** | App Server 提供 `item/plan/delta` 计划文本流、最终 plan item、`turn/plan/updated` 步骤状态，以及 command/fileChange/tool 等执行 items；成品另有 Goal 和 Automations。[App Server](https://learn.chatgpt.com/docs/app-server)、[长任务](https://learn.chatgpt.com/docs/long-running-work)、[Automations](https://learn.chatgpt.com/docs/automations) | 自己的计划栏和步骤界面可以建立在现有接口上。不能说 Codex 只展示最终结果，也不能把事件流当作 pi 独占优势；要比较修改计划与查证产物的实际体验 |
| **Claude Code** | Plan Mode 先调查、提出可修改计划，再转为执行；Desktop 有 diff、预览、终端和文件面板，也支持执行中纠正方向。Goal、桌面调度和云端 Routines 覆盖持续推进。[Plan](https://code.claude.com/docs/en/permission-modes)、[Desktop](https://code.claude.com/docs/en/desktop)、[Routines](https://code.claude.com/docs/en/routines) | 先规划、有界面、随时调整都不是新能力。我们的机会要落在计划修订、已产出内容和当前检查的明确关系，不能仅比较裸 CLI |
| **Cursor** | Plan Mode 可调查代码、澄清、编辑并保存计划。2.2 起已有流式 Mermaid 和将选定 to-do 发送给新 Agent；原生 Automations 支持持续工作。[Plan Mode](https://prod.cursor.com/docs/agent/plan-mode)、[2.2 更新](https://cursor.com/changelog/2-2)、[Automations](https://cursor.com/docs/cloud-agent/automations) | 这是“规划专栏＋图＋分步骤执行”的强基线。官方建议回退、改计划、重跑是一种调整路径；是否有更细的现成方法应在实际版本中核对 |
| **Devin** | Interactive Planning 有调查发现、代码引用和可调整详细计划；Progress 能点击步骤查看 shell、代码与浏览器活动，支持暂停接管。Automations 可触发或继续工作。[Planning](https://docs.devin.ai/work-with-devin/interactive-planning)、[Session Tools](https://docs.devin.ai/work-with-devin/devin-session-tools)、[Automations](https://docs.devin.ai/product-guides/automations) | “每一步发生了什么”已有成品体验。官方历史记录还明确按计划步骤归组动作，不能将过程可见性作为空白。[步骤归组记录](https://docs.devin.ai/release-notes/2025) |
| **Kiro** | Specs 有专门入口，产出需求、设计、任务；实时显示任务状态，可单独执行，并按依赖分批并行。Refine/Sync Files 可更新相关设计与任务。[Specs](https://kiro.dev/docs/specs/)、[迭代](https://kiro.dev/docs/specs/best-practices/) | 最直接的计划优先编码竞品。需求追踪、任务图、单任务执行、计划修改都必须作为现有基线。图好看不能证明我们更实用 |
| **OpenHands** | SDK 提供 Agent、Conversation、Tool、Workspace，支持本地、容器和远端执行，可接入 SDLC。[SDK](https://docs.openhands.dev/sdk/index)、[SDLC](https://docs.openhands.dev/openhands/usage/essential-guidelines/sdlc-integration) | 它是自建编码产品的底座替代。选择 pi 的理由应是具体运行机制和定制收益，不能因它是另一个框架就忽略已有工作区实现 |
| **OpenCode** | Headless server、异步 prompt、会话、SSE、插件和 SDK 支持外接界面。[Server](https://opencode.ai/docs/server/)、[Plugins](https://opencode.ai/docs/plugins/) | 外接桌面与执行状态并非我们独有；计划与版本有效性的业务层也能由宿主应用添加，需比较实际接线成本 |

Kiro 的 IDE 属性测试能显示需求、属性、任务和生成代码的关联；官方同时说明这提供证据而非正确性证明。[Correctness](https://kiro.dev/docs/specs/correctness/) Devin 还有完成后的 Session Insights，用问题时间线和错误假设帮助用户理解过程。[Insights](https://docs.devin.ai/product-guides/session-insights) 因此“其他 Agent 不验证、不解释过程”都不能作为比较起点。

### 来源新鲜度

Claude 的英文官方页面明确说明 **Ultraplan 研究预览已移除**。部分译文和搜索摘要仍展示旧能力，应以当前移除说明为准。[Ultraplan 状态](https://code.claude.com/docs/en/ultraplan)

Cursor 流式图的证据来自 2025-12-10 的正式更新，说明它早已存在，不代表当前产品止步于 2.2。历史功能记录可证明曾发布，不能单独保证当前所有入口和交互细节不变。

## 4. 持续 Agent 与框架：任务图也不是新的底座能力

| 对象 | 官方已提供什么 | 项目级产品仍需核对什么 |
| --- | --- | --- |
| **OpenClaw Workboard / Task Flow** | Workboard 有 specify/decompose、动态子卡及依赖、attempt/proof/artifacts；Task Flow 保存 revision、等待与取消并跨 Gateway 重启。[Workboard](https://docs.openclaw.ai/plugins/workboard)、[Task Flow](https://docs.openclaw.ai/automation/taskflow) | Workboard 的 proof 是 worker 自报，独立验证门禁需要接入；它已能承载相当多计划与成果语义。应比较编码产物、验证新鲜度与变更继续体验，而非 SQLite 或状态数量 |
| **Mastra Dynamic Workflows / Studio** | Beta 的 Dynamic Workflows 可由 LLM 或用户生成 JSON 图并校验、注册；同 ID 更新后，新 run 使用新图，旧 run 保留旧图。Studio 可显示路径与原始输出，Time Travel 可从步骤改变输入重跑。[动态图](https://mastra.ai/docs/workflows/dynamic-workflows)、[Studio](https://mastra.ai/docs/studio/overview)、[Time Travel](https://mastra.ai/docs/workflows/time-travel) | 动态计划、图界面和步骤重跑已有机制。工作流版本变化不自动解决当前代码、人工修改或外部副作用；不兼容的步骤重跑也会失败 |
| **Mastra Factory** | 官方于 2026-07-27 介绍从 intake、triage、planning 到 building、review、completion 的流程，并有代码、验证、文档与后续监控界面。[Factory](https://mastra.ai/blog/announcing-mastra-factory) | 这是完整流程体验的强反例，不能把 Mastra 仅当底层 SDK。部署成本、真实交付和计划变更处理仍需实测，介绍页不是我们的对照实验 |
| **LangGraph / Deep Agents / LangSmith Studio** | checkpoint、interrupt、动态 Send/Command、持久存储和子 Agent；Studio 可查看节点状态、修改输出并 fork。[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[动态执行](https://docs.langchain.com/oss/python/langgraph/workflows-agents)、[Deep Agents](https://docs.langchain.com/oss/python/deepagents/going-to-production)、[Studio](https://docs.langchain.com/langsmith/use-studio) | 不能说它只能固定图，或没有步骤修改与可视化。还要定义项目授权、产物版本、检查有效性、当前工作区继续和用户交接 |
| **Dify** | 可给单节点输入变量、检查输出并单步调试；有运行历史与路径、草稿和发布版本。[Step Run](https://docs.dify.ai/en/cloud/use-dify/debug/step-run)、[History](https://docs.dify.ai/en/cloud/use-dify/debug/history-and-logs)、[Version Control](https://docs.dify.ai/en/cloud/use-dify/build/version-control) | 节点输入/输出/重跑是成熟工作流体验。编码工作区、计划从用户意图生成，以及代码改变后的复验是另外的产品接线 |
| **Temporal** | Event History、Workflow replay、Activity、Timer、Signal，支持长期和跨 worker 流程。[Workflow Execution](https://docs.temporal.io/workflow-execution) | 恢复 workflow 不等于外部动作恰好一次，也不自动生成面向开发者的计划与产物界面；云端可用性上应复用它，不自行竞争 |
| **Trigger.dev** | TypeScript 任务、队列、重试、等待、回调 token、幂等键和执行状态。[介绍](https://trigger.dev/docs/introduction)、[等待](https://trigger.dev/docs/wait-for)、[幂等](https://trigger.dev/docs/idempotency) | 它解决执行基础。何时应让 Agent 行动、哪些产物仍有效、未知动作如何查证，需要应用定义；任务去重不等于业务动作幂等 |
| **DeepSeek Harness（DSH）** | Cordis 插件组合、可替换模型/工具/session/loop、会话持久化。pi 适配使用 pi-ai，并非 pi coding-agent SDK。[固定源码架构](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/architecture.md)、[持久化](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/session/session-persistence/README.md) | 可学习静态能力组合、生命周期和工具管线。计划栏、节点产物、业务完成与变更继续仍由产品实现；首版没有理由移植完整容器再另跑 pi loop |

以上对象不能全部堆进一个应用。当前保留 pi SDK 为单次运行内核，应用只增加任务、计划与成果关系；有明确云端或复杂执行需求后再选一个合适框架。

## 5. 三个主打假设，必须经得住强反例

| 我们要提供的行为 | 机制与边界 | 最强替代 | 怎样证明有用 / 何时不成立 |
| --- | --- | --- | --- |
| **计划 v1→v2 的影响预览** | 比较目标、步骤、输入和检查；标出需重做或复验的节点及原因。先覆盖显式依赖和可核对输入，未知时扩大复验；不宣称精确语义影响分析 | Kiro Refine/Sync Files、Cursor 计划修改、Mastra 动态图 | 在中途修改兼容要求的同题任务中，统计人工解释、查找、无效重做和错误复用。现成方法同样省事，则优势不成立 |
| **节点产物与当前输入绑定的验证** | 每个 attempt 保存产物和检查关联，区分历史执行成功与当前证据有效性。旧结果过期意味着核对或复验，不能直接重放写动作 | Devin 步骤、Kiro 测试关联、Kiro＋Karate、CI 必需检查 | 改代码、条件和环境后不出现过期 pass 冒充当前结果；用户查证比日志＋diff更快。若只是换了展示形式，不能称可靠性优势 |
| **中断或局部重做时查证复用成果** | 当前 worktree 上新 attempt；先核对事实、人工修改和未知动作，复用仍适用的产物。最终交付按当前必需验收，不要求所有中间快照永远不变 | OpenClaw Workboard/Task Flow、LangGraph Studio、Mastra Time Travel、成品接管功能 | 恢复后接管更快，不覆盖人工工作、不重复未知动作、不隐去验证缺口。框架能实现相同体验且维护更少，则应复用 |

这些机制并不保证模型更聪明，也不保证更省 token。用户可能花更少时间接管，却多一次核对运行；必须记录总成本，不能只选有利指标。

### 不能忽略验证插件组合

Karate Labs 的官方集成说明描述了读取 Kiro specs、把验收项与实际测试运行关联、区分 claimed done 与 verified，并通过 MCP 返回结果的能力。[Karate 与 Kiro](https://karatelabs.io/kiro) 这说明“计划＋真实验证”可以由现有产品组合获得，是重要对照。

该页面是供应商对自身能力的说明，尚未在本项目实测。其“所有 spec 工具都不验证完成”的概括不能当作竞争事实。检查关联也需要核对实际覆盖、测试质量及适用版本，不能把一个 release verdict 当成完整正确性证明。

## 6. 哪些需求已有证据，哪些还只是设想

| 证据 | 支持什么 | 不支持什么 |
| --- | --- | --- |
| 用户明确要求桌面、先规划、规划过程和节点产物可见 | 本项目交付范围与个人偏好成立 | 其他开发者会迁移或付费 |
| Kiro 用户在计划延迟实施后需手工查 log/diff，提出 gitRef 与恢复时漂移检查；所核对页面当前为 Open。[Issue #9435](https://github.com/kirodotdev/Kiro/issues/9435) | 有具体用户遇到“计划依据已变、恢复前难核对”的问题 | 需求普遍、Kiro 最新版绝无替代、我们的方案已经更好 |
| 多家产品持续增加计划、过程、验证和恢复界面 | 这些能力是明确的竞争区域，应认真比较 | 一项功能已被证明能提高整体生产率，或存在无人服务的市场 |
| 三项能力能在同一模型与工作区之上设计实现 | 有可进入原型验证的工程路径 | 状态机设计已经等于安全、好用或可靠交付 |

市场判断应以实际用户任务、持续采用和维护成本为依据。历史开发者问卷可以说明信任问题的背景，不能证明他们需要 Knotrail 的具体产品组合。

## 7. 强基线如何完成同一项任务

主试题：兼容依赖升级。固定代码起点、目标版本、范围、交付物和检查；在同一合理时间点新增旧配置兼容要求。第二题为跨接口、页面和测试的小功能。另加暂停后人工修改再继续的恢复场景。

| 路径 | 公平允许的能力 | 需要记录的实际成本 |
| --- | --- | --- |
| Codex | 正式规划流程、现有计划/执行面板、项目规则与 Skill；需持续推进时用 Goal/Automation | 用户改要求、理解影响、核对当前结果所需操作和人工分钟 |
| Claude Code | Plan Mode、Desktop、项目技能、确定性检查；持续任务可选 Goal、Routine 或桌面任务 | 不把它限制为一次 CLI 调用；审批策略和实际可用工具必须记录 |
| Cursor | Plan Mode、计划文件和图、to-do 分派、需要时原生 Automation | 计划修改、回退或局部执行的实际设置与返工，不预设只能全量重跑 |
| Devin | Interactive Planning、Progress、接管、测试记录及 Automation | 云端环境和集成的便利计入收益，不能忽略其已有步骤细节 |
| Kiro | Specs、Refine/Sync Files、单任务执行、IDE 可用属性测试；必要时加入可实际安装的验证工具 | 计划修改和验证关联的真实表现；插件接入与维护分别记录 |
| OpenClaw / Mastra | Workboard/Task Flow 或 Factory/Studio 的对应工作流，允许有界插件 | 为达到同等界面和版本语义所需新增代码、配置、部署与维护 |
| Knotrail | 桌面计划栏、节点详情、任务/计划版本、当前输入验证与查证后继续 | 尚未实现的行为不能用未记录的人工操作补齐；本地退出或睡眠限制明确展示 |

不必购买全部产品。首轮选用户能实际使用的一项强编码基线，优先覆盖 Kiro、Cursor 或 Codex，并选一个最接近的产品/插件组合。框架以必要组件和接线成本比较，不与成品硬算解题胜率。

如果产品无法使用同一模型，报告应称产品对照，不称模型或 harness 的纯净实验。自然任务与故障注入分开统计；对需要人判断的验收，固定判定依据，不使用 Agent 自评替代。

至少观察五项结果：

1. 用户理解计划、决定和节点当前状态所花的时间。
2. 修改要求后重复说明与人工核对的次数和分钟。
3. 不必要重做、错误复用、覆盖人工修改或重复未知动作。
4. 当前代码与当前验收条件下的有效交付，以及明确保留的验证缺口。
5. 模型用量、运行时间、初始设置和后续维护的总成本。

## 8. 为什么仍然选择 pi 与自己的桌面

| 选择 | 更适合什么目标 | 本项目取舍 |
| --- | --- | --- |
| 现成编码产品＋规则/插件 | 尽快完成工作，减少自建维护 | 最低成本强对照；不预设它无法达到目标体验 |
| Codex App Server、OpenCode server 或 OpenHands SDK | 自己做界面，同时复用已有执行与环境能力 | 都可成为宿主底座；需要实际比较可修改范围和接口成本 |
| OpenClaw 插件或 Mastra Factory 扩展 | 复用已有任务、计划和过程管理 | 与产品设想直接重叠；可以迫使我们证明独立应用的额外收益 |
| **pi SDK＋计划与成果层＋桌面** | 需要自己的编码工作台，并理解、修改 pi 的执行机制 | 当前选择。只新增用户会操作的产品层，不复刻模型循环 |
| DSH 原生插件 | 主要研究全插件 Agent runtime | 学机制，未选为第二个生产 loop |
| pi AgentHarness | 实际需要恢复同一未完成 operation，且版本风险可接受 | 专项实验后再决定，非首版前置 |

pi 源码分析固定在 [47236c8](https://github.com/earendil-works/pi/tree/47236c84450656043dd8fb21c8513d1421505ae3)。SDK 与 AgentHarness 是不同运行路径；Harness 有实质实现，也有文档列出的格式 WIP 等边界。源码阅读不构成长周期兼容性保证。[SDK](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/sdk.ts)、[Harness](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/docs/harness.md)

长期可积累的价值更可能来自真实任务中的交互细节、项目规则、检查方式和失败处理经验。开放模型或拥有一套图编辑器本身不构成壁垒。

## 9. 劣势、验证节奏与收缩条件

当前方案明确承担这些限制：

- 本地应用退出或机器睡眠时不推进；成熟云端产品及持久任务平台更适合全天候工作。
- 首版一个 Git 项目、一条活动写运行；图中多个节点不意味着多 Agent 并行，多仓与远端交付覆盖较窄。
- 影响分析依赖显式关系和可核对输入；未知时复验更多，不能保证最少重做或完整语义判断。
- 验证只能覆盖已声明、实际执行的条件；旧证据失效不代表旧代码一定错误，也不自动要求重放写动作。
- 桌面、沙箱、数据迁移和依赖更新都有维护成本，不能只比较模型价格。
- 目前有个人需求和设计，没有真实用户采用、付费或留存证据。

前端从 M0 开始。首五日用于交互演示与最薄技术验证，计入完整首版 **28—44 工程日**的粗估；两者均不是正式 Agent 或竞争优势的承诺。[实施计划](IMPLEMENTATION-PLAN.md)

若现成产品加小插件同样减少人工且维护更少，就缩小自建范围；若只有学习 pi 的价值，可以保留个人工作台，但不宣传已经找到行业空白。继续扩建的依据应是用户在真实变更中反复获得可观察的收益，而不是完成了更多面板。
