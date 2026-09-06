# v0.1.0 验证报告

验证日期：2026-09-06。平台：macOS arm64；Node.js 25.8；Electron 44.2；pi 0.85.1。下列结果区分真实应用链路、受控模型协议和真实远端模型，避免把一类证据当成另一类。

## 自动检查

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| TypeScript 全仓检查 | 通过 | Main、Renderer、Core、Runner、工具与测试契约 |
| `npm run check` | 31 项：30 通过、0 失败、1 条反向能力分支跳过；构建通过 | Core、真实 pi SDK、操作系统执行器、Git broker |
| 受限环境的沙箱不可用分支 | 单独验证通过 | 不支持或嵌套限制时 fail closed |
| React UI 回归 | 4 组通过 | 布局、双语、偏好、决定、影响预览、表单与文件范围；使用模拟 IPC |
| 开发态 Electron smoke | 通过 | 真 preload → Core → pi SDK → sandbox → 文件修改 → 固定检查 |
| 打包态 macOS App smoke | 通过 | 打包后 Worker/helper 和依赖可加载；相同完整任务链通过 |
| safeStorage | 通过 | 合成密钥加密、文件权限 0600、接口不回传明文、清空删除 |
| 独立只读代码审查 | 最终 pass，无未处理发现 | 修复后逐项复现关键缺陷 |

跳过项是在沙箱可用的验证环境中，用于检查“不支持平台/不可用沙箱”的相反分支，不是跳过实际执行测试。

## 任务与状态覆盖

- 创建请求持久去重，requestId 不能对应不同参数。
- 规划阶段写请求被 Main 拒绝；审阅模式 ready 前不修改工作树。
- 草稿允许不完整；最终计划拒绝环、未知依赖、重复 ID 和遗漏固定检查。
- 所有节点与最终验收检查绑定当前文件摘要；无命令时要求人工验收。
- 修改文件后旧人工验收失效；修改目标保留历史并提升版本。
- 影响预览由 host 签发、检查原件并一次性消费，不能换请求 ID 重放。
- 取消后的旧决定不能重启任务；截止日过去后的无效回答不改变既有终态。
- 最后一个允许的 turn 可以完成任务，不要求虚假的额外轮数。
- Run 超时取消已经准入的父层工具，并阻止自动重试。
- 绝对截止时间作用于 Run 和最终验收，过期任务不能落成 completed。
- 崩溃中未确认操作变为 unknown，阻止自动重放。

## 执行与安全覆盖

真实 macOS 测试覆盖越界文件读写、符号链接、`.git`、保护文件及其祖先目录重命名、环境凭据隔离、网络默认拒绝、显式 IP 与 DNS 授权、输出截断、超时和正常后代回收。

owner 内核锁测试验证重复宿主被拒绝、路径别名不能取第二把锁、宿主关闭自身 fd 后 helper 仍持有租约，以及 Main 突然死亡后的普通子进程回收。文本操作测试验证旧内容和 SHA-256 冲突拒绝、截断读取后的 hash 编辑及已有执行权限保留。

Git 过滤器回归在项目声明恶意 clean filter 后，分别触发脏工作区检查和累计 diff，确认过滤器未执行。模型配置回归确认非法 token 配置不替换密钥，切换 endpoint 未填新 key 时清除旧凭据；加密记录绑定端点，配置不一致时阻止发送。

## 真实桌面链路

`tests/desktop-smoke.mjs` 启动临时 Git 项目与独立 App 数据目录，使用本地 OpenAI 协议服务给出可控模型响应。模型循环仍是真实 pi SDK，没有用测试替身代替 Runner 或 SandboxExecutor。

流程依次读取文件、提交计划、在 ready 检查零修改、通过真实 IPC 开始、修改目标文件、运行节点与最终两次固定比较命令、完成并保存报告。检查源仓库没有变化、Renderer 错误为零、规划面板确实位于右侧，以及中英文切换。开发态和打包可执行文件都运行了这条链路。

截图在临时目录生成，未把测试项目或本机资料打包进入源码仓库。

## 复现命令

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:ui
npm run test:desktop
npm run package
```

打包态测试可通过脚本的 `KNOTRAIL_ELECTRON_EXECUTABLE` 指定生成的可执行文件。系统禁止启动图形 App 或嵌套 sandbox 时，需在正常 macOS 会话中运行；不能把沙箱失败改成 unrestricted 执行来获得绿灯。

真实远端模型验证：

```sh
export KNOTRAIL_MODEL_ID='provider-available-model-id'
export KNOTRAIL_BASE_URL='https://provider.example/v1'
# 在本机安全设置 KNOTRAIL_API_KEY，不要把密钥写入仓库或聊天。
npm run smoke:live
```

脚本创建并清理临时 Git 项目，要求模型先提交计划再改文件，只有独立固定检查通过才报告 passed。API 请求可能产生费用；它不是固定响应的 HTTP fixture。

## 尚未被这些测试证明的事情

- 本次没有可用的用户远端模型凭据，因此没有真实远端模型或 GPT-6 Astra 服务端工具调用验收。模型服务选择、API 兼容性、质量、价格和吞吐仍需实际接入后验证。
- 未测量与 Codex、Claude Code、OpenHands 等产品的任务成功率、长期费用或领先幅度。
- 没有恶意进程全生命周期隔离保证。受控实验证实 detached/setsid 后代可脱离普通进程组；详见 [安全边界](SECURITY.md)。
- 没有代码签名、公证、自动更新、云端调度或其他平台的运行承诺。

GitHub CI 的远端状态应以仓库当次工作流记录为准；本地测试通过不冒充远端 CI 已通过。
