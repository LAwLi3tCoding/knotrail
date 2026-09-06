# Knotrail · 程迹

Knotrail 是基于 pi SDK 的本地编码 Agent 桌面应用。每项任务先形成结构化计划，再按节点执行；对话、工具活动、代码变更、验收结果和历史尝试都可以在同一个工作区查看。

主界面沿用 Codex 的任务导航与对话布局，参考 DSH 的活动视图和配置分组，以及 Catdesk 的工具面板组织方式。右侧规划栏独立开关，底部文件、终端和产物预览独立开关。界面支持简体中文与 English，模型回复语言单独设置。

本仓库包含可运行代码，不是静态交互演示。当前发布面向个人开发者的 macOS 本地使用；其他平台的执行入口会拒绝运行。模型服务需要自行配置，不包含模型账号或 API 使用额度。

完整原方案仍在实现中。选择性复用、带来源的长期等待、完整崩溃恢复实验和真实同题比较尚未完成；逐项状态见 [完成度审查](docs/COMPLETION-AUDIT.md)。

## 已实现的工作流程

- 选择 Git 项目，创建独立工作区，设置目标、验收命令、执行方式和预算。
- pi 调研项目并提交计划草稿；主进程校验计划后，自动执行或等待用户开始。
- 查看节点依赖、真实状态、工具输出、变更产物、检查结果与历次运行。
- 在主对话回答决定；即使规划栏关闭，也不会漏掉待答问题。
- 暂停、恢复、取消；修改要求和重做节点先显示影响，再应用修订。
- 用有限持续任务处理外部等待，或用维护任务按周期重新检查。
- 保存任务、事件和界面偏好，导出 Markdown 任务报告。

影响处理采用保守规则：修改目标会使原计划全部节点失去完成依据；重做节点会使该节点及其下游失效。已有文件和历史记录保留。当前不提供任意节点回滚，也不宣称能自动证明无关成果可以安全复用。

## 快速开始

需要 macOS、Git、Node.js 24 或更新版本。安装原生依赖时可能需要 Xcode Command Line Tools。

```sh
npm ci
npm run dev
```

`dev` 会先构建，再启动 Electron；目前修改源码后需要重新运行。只启动已经构建的应用可使用：

```sh
npm run build
npm start
```

首次使用：

1. 打开「设置 → 模型」，填写 OpenAI 兼容 Chat Completions 地址和该服务实际可用的模型 ID；需要支持工具调用。
2. 按需填写 API 密钥并保存。密钥通过操作系统安全存储加密，不回传给前端。
3. 点击「测试已保存连接」。该操作检查服务商模型列表与准确的模型 ID；实际工具调用能力仍需通过任务验证。
4. 打开一个已经有提交、工作区干净的 Git 仓库，创建任务。
5. 填写有意义的验收命令，例如 JSON 数组 `["node", "check.mjs"]`。如果不提供命令，任务最终会等待人工验收。

完整操作、命令示例与恢复方法见 [用户指南](docs/USER-GUIDE.md)。

## 验证与构建

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:ui
```

`npm run check` 执行类型检查、核心测试和构建。UI 测试单独执行：它使用真实 React 前端和可控 IPC 测试替身，验证交互与状态保存，不能替代真实模型和操作系统执行验证。

```sh
npm run smoke:live
npm run package
```

`smoke:live` 用于独立检查真实模型链路，配置和结果应以该脚本的实际提示及验证文档为准。`package` 生成 macOS 应用目录；当前构建没有开发者签名、公证或自动更新服务。

## 实现边界

| 项目 | 当前行为 |
| --- | --- |
| 执行平台 | macOS `sandbox-exec`；不可用时拒绝执行 |
| 项目输入 | Git 根目录，需要已有提交且工作区干净；当前不支持符号链接与子模块 |
| 并发 | 整个应用一次只有一条活动任务执行，其他任务排队 |
| 模型接入 | 显式配置 OpenAI 兼容 Chat Completions 模型，不使用桌面产品订阅作为 API 凭据 |
| 命令环境 | 不加载用户 shell 配置，不继承用户凭据；网络默认关闭，可显式开启 |
| 恢复 | 核对当前工作区与历史证据；异常退出留下的未知动作需要检查后显式恢复 |
| 调度 | 依赖 App 进程和本机运行；退出、睡眠或离线期间不提供云端执行 |
| 外部交付 | 查看和导出报告；不会自动提交、合并、推送或发布用户项目 |

只运行可信仓库和命令。文件与网络沙箱不是虚拟机，主动脱离的后台进程可能无法随任务回收；本项目不作为运行恶意代码的隔离平台。

## 代码入口

```text
src/desktop/     Electron 主进程、受限 preload、操作系统密钥存储
src/core/        唯一状态写入口、SQLite、计划与影响校验、Git 工作区
src/runtime/     pi SDK 会话与独立模型工作进程
src/execution/   文件与命令执行、macOS 沙箱、所有者锁
src/shared/      前后端命令与快照契约
src/renderer/    双语 React 工作区、右侧规划、证据与工具面板
```

详细文档：

- [用户指南](docs/USER-GUIDE.md)
- [实现原理](ARCHITECTURE.md)
- [代码指南](docs/CODE-GUIDE.md)
- [验证记录与方法](docs/VALIDATION.md)
- [安全边界](docs/SECURITY.md)

根目录原始产品与研究方案保留了设计背景；实际能力和限制以代码、用户指南与验证结果为准。

## 依赖与参考

运行时基于 [pi-mono](https://github.com/badlogic/pi-mono)，扩展组织思路参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。Knotrail 是独立项目，不代表上述项目或 Codex、Catdesk 的官方发行版本。

MIT License，见 [LICENSE](LICENSE)。
