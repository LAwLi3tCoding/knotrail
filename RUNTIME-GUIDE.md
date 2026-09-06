# Knotrail：从 pi 理解 Agent Runtime v3.1

> 交付更新（2026-09-06）：可运行的 v0.1.0 已实现。本文保留设计与研究背景，当前能力、限制和验收以 [README](README.md)、[实现架构](ARCHITECTURE.md) 与 [验证报告](docs/VALIDATION.md) 为准。
本文是源码阅读与拟实施实验路线，实验尚未运行。固定源码：[pi 47236c84450656043dd8fb21c8513d1421505ae3](https://github.com/earendil-works/pi/tree/47236c84450656043dd8fb21c8513d1421505ae3)。目标是能追踪、解释和修改实际执行机制，而非仅会调用 `prompt()`。

当前生产决策：常用 coding-agent SDK；AgentHarness 为独立实验与后续候选。本文件的实验清单不是首版必须全部实现的功能，阶段映射见 [实施计划](IMPLEMENTATION-PLAN.md)。

## 1. 先看清三层

| 层 | 解决什么 | 不自动解决什么 |
| --- | --- | --- |
| pi-ai / Models | 模型、消息、流式事件、provider 差异 | 用户任务、沙箱、检查是否通过 |
| Agent / AgentHarness | 何时请求模型、执行工具、处理上下文与停止；Harness 增加持久 operation | 桌面进程管理、外部效果恰好一次、业务正确性 |
| 本项目产品层 | 任务/计划版本、规划专栏、节点与产物关联、观察、等待、授权与检查 | 不再实现一个模型循环 |

`Skill` 是可加载的指令和资源；`Tool` 是具有参数与执行语义的能力；`Plugin` 是注册贡献并随生命周期清理的模块；`Bundle` 是为某种任务打包的一组能力；`Profile` 是某次运行最终选用的配置。这五者不能混称。

## 2. 常用 Coding-agent SDK 的真实链路

```text
createAgentSession（显式 ModelRuntime / Settings / SessionManager / ResourceLoader）
  → AgentSession + new Agent
  → prompt → agentLoop / runLoop
  → transformContext → convertToLlm
  → streamFn / ModelRuntime.streamSimple → provider HTTP 或 WebSocket
  → assistant 流式事件 → 工具参数准备和校验 → tool.execute
  → 工具结果进入上下文 → 下一次模型请求
  → AgentSession 处理扩展、持久化、重试、压缩与 settled
```

第一批阅读：[sdk.ts](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/sdk.ts)、[agent-loop.ts](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/src/agent-loop.ts)、[agent-session.ts](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/agent-session.ts)。

| # | 机制 | 源码揭示的细节 | 在本项目中学会回答的问题 |
| --- | --- | --- | --- |
| 1 | Provider 适配 | 共用 Model/Context/AssistantMessage，实际协议仍不同 | 为什么“OpenAI 兼容”不能保证工具行为相同？ |
| 2 | 流式输出 | 部分 partial 对象会持续改变 | 日志为什么要复制快照，不能保存可变引用？ |
| 3 | 推理相关字段 | reasoning/signature 是 provider 内容，可能不透明 | 哪些内容实际返回，哪些内部推理不可见？ |
| 4 | 模型上下文 | 产品消息先变换，再转换成 provider 消息 | UI 上的聊天记录为什么不等于请求输入？ |
| 5 | Schema 校验 | 克隆参数、兼容处理、类型转换后校验 | 执行策略应该判断原字符串还是最终参数？ |
| 6 | 参数准备 | prepareArguments 可处理兼容性 | 改参后如何避免权限判断失效？ |
| 7 | Agent loop | 工具结果可触发下一轮模型请求 | 用户的一次请求为什么包含多个 turn？ |
| 8 | 事件订阅 | Agent listener 可按顺序 await | 慢审计插件为什么会拖慢运行？ |
| 9 | 工具并行 | 默认可并行；完成顺序与写回消息顺序不同；顺序工具影响批次 | 两个并行调用谁先完成，模型又先看到哪个？ |
| 10 | 文件写锁 | FileMutationQueue 保护规范化后的单个文件 | 为什么它挡不住 shell 或跨文件竞争？ |
| 11 | 工具 hook | before/after 可以阻止或转换结果 | 哪一层才应拥有不可撤销的最终拒绝？ |
| 12 | terminate | 一批工具的终止语义不能简单等同于一个工具返回停止 | 混合批次为什么仍可能继续请求模型？ |
| 13 | steer / followUp | 在不同边界注入输入 | 引导为什么不能瞬间终止当前 shell？ |
| 14 | abort | AbortSignal 是协作取消；Session.abort 还会等待 idle | 工具内 await 停止为何可能等待自己？不理会信号的子进程如何停止？ |
| 15 | retry | 活动上下文和持久历史对失败消息的处理不同 | 一次网络失败为什么不能从 UI 消息数推算成本？ |
| 16 | compaction | 摘要是额外模型调用，历史树仍在 | 压缩省的是后续上下文，不是删除存储？ |
| 17 | 截断响应 | stopReason=length 时已解析工具调用不会正常执行 | 工具 JSON 看似完整为什么仍不能执行？ |
| 18 | Session 树 | JSONL 条目、parentId、压缩投影 | 分支历史与磁盘工作区为何是两个状态？ |
| 19 | 落盘时点 | 首个助手消息前可能延迟首次写入；message_end 通知早于追加 | 什么事件才能证明任务或结果已保存？ |
| 20 | 资源发现 | 默认会发现项目/全局配置和包 | 如何确保只运行明确选择的扩展？ |
| 21 | Extension | TS/JS 与应用同进程运行 | 插件 API 限制为什么不等于阻止 import fs？ |
| 22 | RPC | 命令、事件、反向 UI 询问有不同方向 | 长请求期间如何继续展示事件并回答审批？ |
| 23 | Client 协议 | pi-client 是实验性传输层 | 断线后不能把请求盲目重发的原因是什么？ |

v3 生产先将工具全部设为 sequential。核心 update_plan 的最终提交与结果建议工具接受后关闭新效果入口、触发 abort，并由外层等收尾；不能只返回 terminate，也不能在工具内部 await Session.abort。混合批次的最小验证见实施计划 T08。显式使用 noTools: "builtin" 与工具白名单，单独传 customTools 仍可能保留内置工具。

进一步源码：[消息类型](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/ai/src/types.ts)、[参数验证](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/ai/src/utils/validation.ts)、[SessionManager](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/session-manager.ts)、[ResourceLoader](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/resource-loader.ts)、[Extensions](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/core/extensions/types.ts)、[RPC 类型](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/modes/rpc/rpc-types.ts)、[Client](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/client/README.md)。

## 3. 专项实验：AgentHarness 路径

```text
ModelRuntime + JsonlSessionRepo + static tools/resources
  → AgentHarness.create（只 attach，不自动驱动副作用）
  → lane("main")
  → lane.accept（持久接受 operation）
  → lane.drive（推进指定 operation）
  → provider intent → stream → settlement
  → tool intent → tool.execute → settlement
  → operation result / lane snapshot / usage ledger
```

Harness 自己持有 entry tree、operation state 和 usage ledger；如未来选用，应用仅把任务/计划/节点、授权与检查结果关联到它。不能把 Harness 的运行状态再镜像成另一套可独立写入的状态机。

与 SDK 不同的关键学习点：

1. **接受与执行分离**：任务可以持久接受但尚无活跃 driver；UI 收到请求和工具已经执行是两个事实。
2. **意图与结果之间有不确定窗口**：外部调用成功但结果还未提交时崩溃，不能凭日志推断成功或失败。
3. **safe replay 是契约**：恢复时持久意图和当前工具都须声明 safe；写操作不能因为参数相同就视为安全重放。
4. **attach 不推进**：读取恢复状态本身不能启动 provider/tool；示例 mini 会另行 resume，本项目不照搬自动 resume。
5. **watch 是快照加事件边界**：先缓冲订阅再取快照；本地一致性测试不等于网络重连已被验证。
6. **存储事务不覆盖世界**：entry/state/usage 可以一起提交，数据库无法把外部 shell 或网页提交也放进同一事务。
7. **持久取消与 RPC 取消不同**：请求 Context 取消不自动写入 operation 的持久取消；停止任务要同时覆盖两条链路。

已读测试源码：[公共驱动](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/drive-public.test.ts)、[恢复](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/restore.test.ts)、[tools](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/drive-tools.test.ts)、[watch](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/watch.test.ts)、[compaction](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/test/harness/runtime/drive-structural.test.ts)。这些测试本次没有执行。

当前明确的边界：format 4 WIP；`watchSession()` 是未实现 stub；完整 named/streaming fork 尚未闭合；JSONL dead bytes 尚不回收；统一 telemetry 不完整。因此该实验只用一个 session 的一个 lane、`lane.watch()` 和从固定案例重新建 session，不承诺任意运行中分叉和跨版本恢复。[状态说明](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/agent/docs/harness.md)。

`mini/worker/run.ts` 已展示 ModelRuntime、JsonlSessionRepo 和四个基本工具的接线，不必自己再写模型认证系统。需要补的是应用自有凭据配置与工具沙箱，不能照搬其默认宿主配置发现。[mini worker](https://github.com/earendil-works/pi/blob/47236c84450656043dd8fb21c8513d1421505ae3/packages/coding-agent/src/experimental/mini/worker/run.ts)。

## 4. 十二个实验，每个都要留下可运行证据

前期使用受控 faux provider、临时目录、假凭据和本地服务，不调用真实用户项目。只有 provider 接线和实际任务验证需要真实模型。实验文件在对应阶段实际建立，当前不生成空壳。

| 实验 | 做什么 | 必须看到的现象 / oracle | 产品用途 |
| --- | --- | --- | --- |
| L01 最小循环与流 | 让假模型读文件后回答，记录事件与 partial 快照 | 先模型、再工具、再模型；旧快照不会随新 token 改变 | 时间线和单步理解 |
| L02 上下文与 payload | 插入 AGENTS、Skill、工具结果，追到最终 payload | 缺少一个资源时能指出哪段输入不同；所有变换后的捕获与 transport 比对 | 上下文解释 |
| L03 参数与权限 | 数值字符串、非法字段、hook 改参、越界路径 | 策略看到校验后的参数；改参后重验；非法动作未执行 | 工具闸门 |
| L04 顺序与并行 | 两个延迟不同的工具；对照顺序批次 | 完成顺序与模型结果顺序可不同；顺序策略无并发写入 | 并行语义 |
| L05 阻止与终止 | allow/block/terminate 组合 | 被拒绝工具调用次数为 0；后置 hook 无法反转核心 deny | 策略规则 |
| L06 引导和队列 | 工具进行时 steer，空闲时 followUp，再取消 | 输入只在相应边界消费；下一实验不继承上次的输入 | 用户控制 |
| L07 两种取消 | provider 等待、合作工具、忽略信号且派生子进程的工具 | SDK abort 与进程退出分别核对；Harness 再测 RPC/operation 取消；停止后无新写入 | 停止按钮 |
| L08 持久接受与崩溃 | SDK 首轮前退出；Harness accept 后、effect 前后强杀 | SDK 接收记录保留；Harness 恢复不重放原 unsafe 调用；新语义重复另测 | SDK 恢复边界；Harness 后续取舍 |
| L09 压缩与分支 | 小窗口压缩，再从案例新建 session | 完整历史仍在；输入投影变短；新实验有独立工作区 | 案例对照 |
| L10 资源与插件生命期 | 放置不会实际执行的恶意扩展哨兵；重复 activate/dispose | 未批准代码未运行；重复装卸没有残留监听器/重复工具 | 静态插件宿主 |
| L11 watch 与重连 | 快照捕获时插入事件；断 UI 但保留 worker | 投影等于权威快照；UI 重连不重发 submit | 桌面可靠性 |
| L12 回归与配方 | 两版 Skill 跑相同案例；保留一组不可见案例 | 换版本可解释变化；候选不能修改 verifier 或启用自身 | 后续候选演进，非首版 |

先做 SDK 生产路径相关实验；L06 热引导按需要，L08 的 Harness 部分和 L12 技能演进后置。L11 在 SDK 产品层检查 UI 快照/事件，Harness watch 另测。每个实验只保留最小失败复现和断言，不按所有函数铺测试。先读相关源码 → 用实验打破一个假设 → 写出观察结果 → 再接入产品。能解释失败原因，比展示很多日志更重要。

## 5. 将规划与节点接到真实循环

产品的调用链是 `Task → Planning Run → PlanRevision Ready → Node Run → Artifact/Check → 下一个节点或修订计划`。每个 Run 仍执行上面的 SDK loop；图节点不是每一次模型 turn，也不是一次工具调用。一个节点应有用户能理解的目标与产物，内部可以做多轮调用。

Planner 使用同一 SDK，但只注入受控读工具和核心 update_plan。草稿更新附真实 runId/draftId/sequence，完整解析后保存；token 只供草稿展示。最终提交需 DAG、依赖、输入、范围与必需验收校验，Planner 收尾后再核对输入，才能由 Coordinator 发布。前端不能直接写 Ready，也不能从聊天中猜计划已经完成。

Node Run 固定当前 TaskRevision/PlanRevision、节点语义、有效前驱产物和相关来源。工具回执由执行器绑定 Run 和 nodeId；模型自报完成仅提出核对请求。NodeAttempt 就是一次 node-purpose Run。pi Session 是该次消息历史，不能替代整个任务的计划或完成状态。

改目标或步骤后创建新版本；先停止旧效果，再分析明确依赖与实际产物引用。旧图保留当时结果，当前视图区分执行结果与证据有效性。证据过期意味着需要重读/复验，不代表允许盲目重放工具。局部继续在当前工作区开新 attempt；不能把会话分支或 workflow time travel 当作文件系统及外部世界回滚。

规划侧栏可由用户独立开关；开关不传成 Run 暂停/取消，不改变 loop，关闭期间仍更新任务数据，重新打开读取最新快照。主对话和侧栏中的必要问题指向同一 Decision，不创建重复决定。规划专栏只展示可核对的事实、来源、问题、选择和简短理由，不承诺内部思维链。图/列表与节点详情消费同一 TaskSnapshot 和 sequenced events；延迟动画不能改变实际状态，历史消息不能凭顺序归错节点。

### 四个产品接线实验

| 实验 | 最小触发 | 必须看到的现象 | 阶段 |
| --- | --- | --- | --- |
| L13 规划权限与发布 | 假模型请求项目写；提交缺依赖/有环/截断草稿；再提交完整候选 | 项目无效果；无效草稿不 Ready；合法计划停止规划后才执行 | M1 |
| L14 节点归属与前端 | 两节点各自产物/检查，关闭规划栏后继续，重开与断 UI 恢复；图/列表切换 | 同一版本、节点、attempt 的实际记录一致；关闭不影响执行或问题回答，重开保留选择与最新状态，无重新 submit | M0/M2 |
| L15 计划改版与失效 | 改一项兼容条件，晚到旧 pass；独立分析输入保持不变 | 受影响证据过期，合格分析可复用；未知依赖保守复验；旧版不驱动新图 | M2 |
| L16 局部继续 | 用户修改后重做指定节点，前次写结果未知 | 保留人工修改、先查证，新 attempt 读取当前状态；不重放旧 patch | M3 |

以上均为待实施实验。首版阶段仅运行支撑实际功能的最小集合；不因学习清单完整就要求所有高阶路径一并交付。

## 6. 后续三个高阶实验

- **PTC**：同一批查询分别逐工具调用和受限代码批量调用，比较真实往返、用量与检查结果；内部工具必须仍经策略和审计，不能直接访问宿主。
- **记忆**：同一事实在两个代码版本变化，比较直接检索、带来源/有效期的检索与不使用记忆；观察是否引用过期结论。
- **多 Agent**：同一任务先单 Agent，再拆成具有独立输出和检查的子任务，计算人工分钟数、冲突、总成本；证据支持后才引入生产调度。

这三个实验均非第一版必做项。不要为了“理解所有机制”一次实现所有生态系统；用相同案例逐项打开能力，才知道改动究竟带来什么。
