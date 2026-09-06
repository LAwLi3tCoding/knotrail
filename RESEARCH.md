# Knotrail：研究依据 v3.1

> 交付更新（2026-09-06）：可运行的 v0.1.0 已实现。本文保留设计与研究背景，当前能力、限制和验收以 [README](README.md)、[实现架构](ARCHITECTURE.md) 与 [验证报告](docs/VALIDATION.md) 为准。
定位：保留的源码与生态资料；当前产品决策以 [产品方案 v3.1](PRODUCT-BRIEF.md)、[竞品对比 v3.1](COMPARISON.md) 和 [架构 v3.1](ARCHITECTURE.md) 为准。

研究范围：保留 2026-09-04 的 25 个项目公开源码/官方文档快照，覆盖运行循环、持久执行、上下文、插件、工具、浏览器、隔离、评测和学习；2026-09-05 补查规划界面、节点过程、计划改版及实际需求资料。新增核查不代表重新读取了全部 25 个仓库。没有安装或运行这些项目；代码和测试源码说明了实现意图与断言，不能替代本机验证。滚动文档不是固定版本保证。

阅读顺序：[产品判断](PRODUCT-BRIEF.md) → [10 个具体场景与筛选](DIRECTIONS.md) → [详细架构](ARCHITECTURE.md) → [实施计划](IMPLEMENTATION-PLAN.md)。底层机制与实验见 [RUNTIME-GUIDE.md](RUNTIME-GUIDE.md)。

## 1. 研究结论

搭建一个自己的 pi Agent 有学习价值；作为产品，必须在一个真实任务上，比“现有 Agent + 一段脚本”更省事、更可靠或更便于控制。多模型、聊天渠道、定时任务、记忆、Skills、浏览器和多 Agent 都已有丰富实现，不能仅凭这些标签认定差异化。

v3 选择带可视计划的桌面编码工作台：每项任务先规划，Codex 式主界面提供可独立开关的规划侧栏，执行时逐节点关联输入、动作、产物与验收。值得验证的差异是计划改版后能否准确解释影响、保留有效成果并局部继续。项目托管仍是这一工作台的长任务模式；自动技能演进与通用评测工坊退出首版主线。

这一结论是产品判断，不是市场调查或性能测试结果。后续必须用真实任务证明是否值得做完整应用。

## 2. Codex 基线与更新入口

不能以旧印象来寻找 Codex 缺口。以下保留本轮研究核对的能力；2026-09-05 对编码产品和长任务框架的集中更新见 [COMPARISON.md](COMPARISON.md)，包括 Claude Code Routines、Cursor/Devin Automations 和 OpenClaw Task Flow。

| 能力 | 官方基线 | 对本项目的影响 |
| --- | --- | --- |
| 主动任务与定时工作 | 桌面 Automations 支持定时运行、Skills、项目及 worktree；同一对话可以持续跟进 | “每天替我做事”不是新卖点 |
| 事件触发 | 文档列出 Gmail、Slack、GitHub 事件；注明适用的 ChatGPT web/mobile 产品面，不等同于桌面本地事件入口 | 可研究本地构建/文件/进程事件的专用体验，不能笼统说 Codex 没事件触发 |
| 长任务 | `/goal`、持续执行、并行工作与人工介入边界 | “不需要一直催它”不是充分差异 |
| 录制与重放 | macOS 示范操作可以生成 Skill，并换输入重放 | “教一次就会”已有官方产品入口 |
| 扩展与记忆 | AGENTS.md、memories、Skills、MCP、subagents | “记住偏好”“自定义工具”已有实现 |
| 更新技能 | Automations 文档已有依据会话更新技能的用例 | 应比较回归证据、版本启用、撤回体验，而非声称自己首创技能学习 |

来源：[Automations](https://learn.chatgpt.com/docs/automations)、[Long-running work](https://learn.chatgpt.com/docs/long-running-work)、[Record and replay](https://learn.chatgpt.com/docs/extend/record-and-replay)、[Customization](https://learn.chatgpt.com/docs/customization/overview)。

本文不声称 Codex 无法通过脚本、插件或额外工程实现后文方案。更准确的问题是：某种高频任务是否缺少方便的一体化体验；自己做的产品能否降低其设置、调试和维护成本。没有查到文档，不构成“不存在”的证明。

## 3. v3 新增证据：图和规划都已存在

| 已核对能力 | 直接来源 | 对我们判断的约束 |
| --- | --- | --- |
| Codex 流式计划与步骤状态 | [App server](https://learn.chatgpt.com/docs/app-server)：`item/plan/delta`、`turn/plan/updated`，步骤状态为 pending/inProgress/completed，最终 plan item 可能不同于拼接的流式草稿 | 不能说 Codex 只关注最终结果，也不能把所有 token 当最终计划 |
| Cursor 计划和图 | [Plan Mode](https://prod.cursor.com/docs/agent/plan-mode)、[2.2 更新](https://cursor.com/changelog/2-2)：流式 Mermaid 图、从任务启动 Agent | “先规划＋流程图”本身不是领先功能 |
| Devin 逐步执行记录 | [Interactive planning](https://docs.devin.ai/work-with-devin/interactive-planning)、[Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools) | 点击步骤看命令、输出和代码已有产品入口 |
| Kiro 规格、任务与检查 | [Specs](https://kiro.dev/docs/specs/)、[Correctness](https://kiro.dev/docs/specs/correctness/)、[Karate 集成](https://karatelabs.io/kiro) | 需求—任务—测试追踪已有直接反例；Karate 为供应商功能声明，未实测 |
| OpenClaw 任务图与证明 | [Workboard](https://docs.openclaw.ai/plugins/workboard)、[Task Flow](https://docs.openclaw.ai/automation/taskflow) | 已有依赖卡片、attempt、产物与持久流程；其 proof 为 worker 自报，不能等同独立验收 |
| Mastra 动态计划与局部重跑 | [Dynamic workflows](https://mastra.ai/docs/workflows/dynamic-workflows)、[Time travel](https://mastra.ai/docs/workflows/time-travel)、[Factory](https://mastra.ai/blog/announcing-mastra-factory) | 动态图、版本和步骤重跑已有；Factory 更直接覆盖编码流程，不能把 Mastra 简化成静态流程编辑器 |
| LangGraph / Dify 可视调试 | [Studio](https://docs.langchain.com/langsmith/use-studio)、[Dify step run](https://docs.dify.ai/en/cloud/use-dify/debug/step-run) | 节点输入输出、编辑状态及继续不是新的框架能力；需比较普通开发者的实际操作成本 |

这些页面是 2026-09-05 的读取依据，服务、版本和可用范围可能变化；没有在本机运行上述产品。全面对比与来源见 [COMPARISON.md](COMPARISON.md)。不能把“文档没说明”转成“竞品做不到”。

### 有需求迹象，但还没有市场证明

[Kiro #9435](https://github.com/kirodotdev/Kiro/issues/9435) 于 2026-06-15 提出：规格过几天再实施时，相关函数或模型字段可能已变，用户需手动查 Git 差异，希望规格保存 Git ref 并在继续前识别漂移。这是“旧计划如何继续”具体的公开需求报告，支持我们选择场景；它只是一个报告，其中关于产品缺口的说法未被当作最新功能审计结论。

[Stack Overflow 2025 AI 调查](https://survey.stackoverflow.co/2025/ai) 显示，受访者对输出准确性的信任低于不信任，常见困扰包含结果接近正确但仍需修补，以及花更多时间调试生成代码。这是历史背景，说明验证负担值得研究；不能据此推断 2026 年当前模型水平、市场比例或Knotrail一定有收益。

[METR 2026-02-24 更新](https://metr.org/blog/2026-02-24-uplift-update/) 强调后续生产率测量中的选择偏差和估计不确定性。因此我们不沿用早期“AI 让开发变慢”的数字立项，而是记录实际任务的设置、规划修改、审阅、接管和修复时间，区分模型与工作台贡献。

据此提出三项可推翻的假设：计划变更影响预览降低重新理解成本；绑定输入版本的节点证据减少过期结论误用；当前工作区上的局部继续减少重复操作。它们是拟验证优势，尚无试用、成功率或付费意愿证据。名字 Knotrail是工作名，未完成商标或域名可用性核验。

## 4. 保留的 25 项项目能力地图

证据等级：**S** = 已读实现或测试源码；**D** = 已读官方 README/文档。本表没有“已在本机验证”项。许可证仅记录源码文件标注；具体子目录、依赖、模型、商标及托管服务须分别处理。

| # | 项目 / 固定源码 | 等级 | 实际机制与可借鉴内容 | 成本和边界 |
| --- | --- | --- | --- | --- |
| 1 | [pi @ 47236c8](https://github.com/earendil-works/pi/tree/47236c84450656043dd8fb21c8513d1421505ae3) | S | 模型适配、Agent loop、Session、压缩、扩展；另有公开 AgentHarness 持久 operation/usage/recovery 路径 | MIT；SDK 与 Harness 是两条路径，不可混用为同一个 owner |
| 2 | [DeepSeek Harness @ d347e70](https://github.com/deepseek-ai/deepseek-harness/tree/d347e703908d0406b7a7ef80e3a0e594d86b2215) | S | Cordis 服务依赖与可撤销注册、profile/bundle、统一工具管线、PTC | 根 LICENSE 为 MIT，当前 alpha；本项目借机制，不依赖其整个宿主 |
| 3 | [OpenClaw @ d58c93f](https://github.com/openclaw/openclaw/tree/d58c93f334ce5f867707a07591c0d032f6d1f641) | D | 本地 Gateway、渠道、事件、静态插件 manifest、单调 block | MIT；“龙虾式全渠道助手”已有成熟实现，值得学入口与长期在场方式 |
| 4 | [Hermes Agent @ 13e72fb](https://github.com/NousResearch/hermes-agent/tree/13e72fb205b735df679e0fd5f5996a34ac4accc6) | D | 区分 tool/toolset/skill/plugin；渐进加载、记忆、cron、自学习技能 | MIT；Python 工程接入有成本，优先借分类和能力组织方式 |
| 5 | [OpenHands SDK @ ac0b663](https://github.com/OpenHands/software-agent-sdk/tree/ac0b66392b93f639bcb3623791bb64d3c0c1398d) | D | Agent/Conversation/Tool/Workspace；本地、容器、远端执行及事件 | MIT；复用隔离理念，不再叠一个 Agent runtime |
| 6 | [mini-swe-agent @ 04d809c](https://github.com/SWE-agent/mini-swe-agent/tree/04d809ceab9df28f9adaed044884180159172930) | D | 线性消息、Bash、每步独立 subprocess、trajectory viewer | MIT；最小循环的教学对照，不应抄成额外生产引擎 |
| 7 | [Aider @ 5dc9490](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | D | repo map、Git/diff、lint/test 反馈 | Apache-2.0；测试后继续修复已有，机会在复现材料和独立验收 |
| 8 | [OpenCode @ 51f86c8](https://github.com/anomalyco/opencode/tree/51f86c853791c41656fb0adcf9413291e4996b87) | S/D | build/plan、权限、TS 插件 hooks 与 tools | MIT；同进程插件默认受信任，hook 不是安全沙箱 |
| 9 | [Letta Code @ feb32e3](https://github.com/letta-ai/letta-code/tree/feb32e33c4f4badd546e75b70ef202283d6580da) | D | MemFS 管 memory/prompts/skills，版本化长期状态、harness mods | Apache-2.0；旧 Letta 仓库指出活跃 runtime 已转至此处，勿沿用旧架构印象 |
| 10 | [Mem0 @ dae67f7](https://github.com/mem0ai/mem0/tree/dae67f74f5cc7bf138c7d7d6f9cec5ce4b4373b3) | D | 分层 memory、抽取、实体连接、混合检索和时间信息 | Apache-2.0；Platform 的专有优化/成绩不代表开源库实测能力 |
| 11 | [Graphiti @ a6e026f](https://github.com/getzep/graphiti/tree/a6e026f8fca27af9c1fc4cfe359c3834dc9655bb) | D | 时间有效性、episode 来源、增量知识图及混合检索 | Apache-2.0；图数据库和抽取正确性有成本，先用普通证据链接 |
| 12 | [browser-use @ fe5ad35](https://github.com/browser-use/browser-use/tree/fe5ad353091fa2ed5499b94e8fe21094bc2e9e5a) | D | 浏览器 Agent、自定义工具 | MIT；云端代理、验证码与托管服务另计；不把浏览器控制本身当差异 |
| 13 | [Stagehand @ d4f16a9](https://github.com/browserbase/stagehand/tree/d4f16a98a5061279bed997b98fd3f0c17334eedb) | D | locator 与 act/observe/extract 并用、裁剪可访问性树 | MIT；名称有商标声明；优先确定性步骤，脆弱处才用模型 |
| 14 | [Temporal @ 2220587](https://github.com/temporalio/temporal/tree/2220587dea828d938fc99253e178a13d1cb658c5) | D | 持久 workflow history、activities、worker、恢复与重试 | MIT；服务端系统，个人首版不引入；不保证外部副作用恰好一次 |
| 15 | [LangGraph @ 81bf17b](https://github.com/langchain-ai/langgraph/tree/81bf17b23123e4ef8b9d5f49fa09a0122fc2edd1) | D | 状态图、checkpointer、interrupt、跨任务 store | MIT；图状态不等于业务事实，也不自动保证外部事务 |
| 16 | [PydanticAI @ 8e26943](https://github.com/pydantic/pydantic-ai/tree/8e2694321d3b780d648aac3a3772cdb82bcee7d5) | D | 类型化输入输出、capabilities 组合、durable execution 接入 | MIT；借接口与组合方式，不把 Python 框架塞入 pi loop |
| 17 | [Mastra @ fff1c2e](https://github.com/mastra-ai/mastra/tree/fff1c2ed8bef8b6d286067ed7c148c7d9b388b67) | D | TS workflow、挂起恢复、Observer/Reflector 压缩记忆 | Apache-2.0 核心，ee 另有条款；观察记忆仍依赖存储，不保证永不失真 |
| 18 | [smolagents @ 30bb116](https://github.com/huggingface/smolagents/tree/30bb1161095dbae2271e6bc3cc4c219cc3897a57) | D | CodeAgent 用代码组织工具，也有普通 ToolCallingAgent | Apache-2.0；适合与 DSH PTC 比较，代码执行要单独隔离 |
| 19 | [MagenticLite @ d3c9d13](https://github.com/microsoft/magentic-ui/tree/d3c9d13c39288257286a66daabf7c5b5fb72ee69) | D | 当前 magentic-ui 仓库已介绍 MagenticLite：编排模型 + 浏览器模型、人类接管 | MIT；研究原型，官方列出长上下文/引导丢失等限制，非通用可靠性证明 |
| 20 | [Agent Lightning @ 218f1f7](https://github.com/microsoft/agent-lightning/tree/218f1f7c0bac0800de4d5a4e5e6f61cf7b5038b4) | D | 当前 v1 架构为 Trainer、API Gateway、Rollout Controller，采集真实轨迹训练 | MIT；涉及训练基础设施，和修改 Skill 是不同层的“学习” |
| 21 | [promptfoo @ 8091699](https://github.com/promptfoo/promptfoo/tree/8091699ca5eb1e55343718424519bdd56cf7c57f) | D | 配置化 eval、模型比较、CI 与红队检查 | MIT；需要用户自己的案例和正确 oracle；先少量固定案例，不建评测平台 |
| 22 | [Inspect AI @ eb05a68](https://github.com/UKGovernmentBEIS/inspect_ai/tree/eb05a68aee132750509f1db6189d77fdff9c4571) | D | 多轮 agent/tool 评测、scorers、可扩展任务执行 | MIT；后期对接外部评测，首版不移植 Python 评测引擎 |
| 23 | [Gondolin @ 29fa74d](https://github.com/earendil-works/gondolin/tree/29fa74d802112f29c720990aced26165e0d57d84) | S/D | Linux microVM、文件/网络控制、快照；已有 pi 工具扩展示例 | Apache-2.0；QEMU/镜像带来分发与启动成本，快照不是外部世界回滚 |
| 24 | [Sandbox Runtime @ 66d35e5](https://github.com/anthropics/sandbox-runtime/tree/66d35e5ffeba5f406db4343ef88bef0c2fd5bab6) | D | OS 文件/网络限制，macOS Seatbelt/Linux bwrap 等实现 | Apache-2.0；预览库，默认读取范围宽，必须验证实际完整执行路径 |
| 25 | [Langfuse @ 13b0e91](https://github.com/langfuse/langfuse/tree/13b0e91e5fabb4cd442ca630e3b65077d5fc05fc) | D | tracing、prompt 版本、dataset/evaluation、playground | 普通目录 MIT，ee 另有条款；自托管有运维成本，不应为本地时间线引整套服务 |

固定链接均保留完整 SHA。除特别列出的源码，下表 D 级结论主要取自相应提交的 README；它们支持功能声明，不支持吞吐、成功率和安全结论。本文没有借用项目营销 benchmark 作为本项目性能预期。

其中插件细节另据滚动官方文档：[OpenClaw manifest](https://docs.openclaw.ai/plugins/manifest)、[SDK hooks](https://docs.openclaw.ai/plugins/sdk-overview)、[Hermes tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/)、[skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)、[plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins/)。这些页面不能由表中仓库 SHA 自动固定。Letta 的迁移声明见[旧仓库 README](https://github.com/letta-ai/letta/blob/4511fa0bc91f68fbab32b91f694617271ea9012b/README.md)。

## 5. pi 中真正需要理解的两条路径

常用 SDK 的真实链路是 `createAgentSession → AgentSession + Agent → agentLoop → ModelRuntime.streamSimple`。另一条 `AgentHarness` 已实现 provider/tool 驱动、entry tree、mutable operation state、usage ledger、JSONL storage、compaction，以及未知工具结果的恢复处理。它不是只有设计文档，也不是常用 SDK 背后的同一个循环。

关键来源：[SDK](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/sdk.ts)、[Harness 根导出](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/src/index.ts)、[Harness 公共驱动测试](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/drive-public.test.ts)、[unsafe 不重放测试](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/drive-tools.test.ts#L421-L482)。

但其 storage format 4 仍标为 WIP，可能原地改变且不提供迁移；常用 SDK 的资源发现、扩展加载、完整工具集、认证和 UI 接线没有自动移植到 Harness。v3 延续常用 SDK 起步；Harness 做专项对照实验，只有实际需要中断 operation 恢复时才重议生产 owner，不能为了恢复功能重写上游已经有的内核，也不能因其“实验性”标签便忽略已有实现。[Harness 状态与非目标](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/docs/harness.md)、[实验 mini 客户端](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/experimental/mini/README.md)。

## 6. DSH 的“万物皆插件”值得学什么

DSH 通过 Cordis 让服务、监听器、工具、提示词等随插件 scope 注册和卸载；服务依赖决定插件能否激活，effects 在退出时反向清理。profile 表达命名能力组合，bundle 携带包和配置补丁；合成顺序明确，活跃任务并不一律允许热更新。[Cordis primer](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/cordis-primer.md)、[生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/cordis-tutorial/02-lifecycle-and-effects.md)、[boot/config](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/boot/app-boot/README.md)。

最可直接借鉴的是工具管线：持久意图 → 策略与审批 → 不可撤销的最终拒绝 → 执行 → 结果转换 → 冻结结果 → 审计。扩展可以提出策略，不能让后续插件撤销核心的 deny。[工具执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/tool-execution-pipeline.md)。

PTC 让模型用代码调用生成的工具 SDK，内层调用携带关联信息重新进入工具管线；仅外层结果进入模型上下文。这能减少往返和中间数据，但收益需要实测，不能用宿主 `eval` 代替。[Code runtime](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/subsystems/code-runtime.md)。

这些机制不意味着 DSH 插件能直接装到 pi。DSH 的 pi 接入只复用 `pi-ai` 模型层；Cordis scope、Worker、Node vm 都不自动形成安全隔离。我们采用“少量固定内核 + 可组合能力”，不同时运行两套 Session owner。[pi adapter](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/llm/llm-pi-ai/README.md)、[扩展边界](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/subsystems/extensions.md)。

## 7. 能直接复用、先学后用、暂不引入

| 类别 | 选择 | 原因 |
| --- | --- | --- |
| 直接复用候选 | pi coding-agent SDK；Git CLI；Node 标准库；SQLite；一个 OS sandbox/VM 后端 | 避免重写模型协议、差异算法、压缩和进程隔离 |
| 小量自建 | 任务/计划版本、节点证据与有效性、影响预览、等待和动作/检查记录 | 承载本方案的业务语义，是否形成优势仍待实测；应保持一个项目内的普通模块 |
| 学习实验 | SDK/Harness 对照、上下文投影、并行工具、取消、恢复、PTC | 实验必须有可观察失败条件，不只读文档 |
| 需求出现才接 | Stagehand、MCP、Langfuse 导出、promptfoo/Inspect、Graphiti | 每次只解决一个已出现问题，不先做通用适配框架 |
| 首版不引入 | Temporal/LangGraph/Mastra 第二循环、向量/图数据库、训练集群、插件市场 | 与当前规模和目标不匹配；不增加第二套状态真相 |

## 8. 研究边界与待证明项

本次覆盖的是代表性项目与能力类别，并非互联网上所有项目。没有用户访谈、市场规模研究、真实模型横评或成本实测。当前研究足以支持研发取舍，不足以证明商业成功或绝对领先。

实施前要证明：发布包与已读源码的差异、macOS 运行兼容性、完整工具路径隔离、取消后的子进程退出、任务/计划/节点与 pi 会话的版本边界、规划到执行的工具隔离、图/列表事件一致性、改计划后的影响覆盖、provider 最终请求捕获时点、固定 verifier 的防篡改边界，以及真实任务是否比现有工具更省人工时间。具体检查见实施计划。
