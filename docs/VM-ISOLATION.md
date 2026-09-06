# VM 隔离实验

2026-09-07，macOS 26.5 arm64。本阶段验证运行时原语，**尚未接入 Knotrail 执行器，也没有完成 T05/T06/T07**。当前 App 仍使用 `SandboxExecutor`；不能把下列结果当作它已能约束所有派生进程的证明。

## 固定依赖

- [Apple container 1.3.1](https://github.com/apple/container/releases/tag/1.3.1)，官方签名安装包的 SHA-256 为 `a7c1b9d7927d30875f2f6c7bd1d0cb06c2daa6ca57ce9e90a5144e898fdf54a8`。本次下载摘要一致，安装包通过 Apple 签名与公证核验，CLI、API server 和参与实验的 runtime、images、network、machine 插件通过 `codesign --verify --strict`。只解包运行，没有执行系统安装器。
- 该发行版的 [Package.swift](https://github.com/apple/container/blob/1.3.1/Package.swift) 固定 Containerization 0.42.0；不能用 main 分支的新接口解释这个发行版。
- Alpine 镜像固定为 `docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce`，运行 linux/arm64。它用于文件与进程实验，不是拟交付的开发工具链镜像。
- 每个 VM 关闭网络、移除全部 Linux capabilities，只共享该用例新建的临时目录。真实项目、登录缓存和应用数据库不挂入 guest。

## 重复运行

需要预先安装或解包并核验上述运行时，在正常 macOS 会话中启动其服务。测试脚本不安装软件、不启动全局服务，也不改变签名或系统安全配置。若已有 Apple container 服务，需先确认版本与当前服务属于同一个运行时；不同版本的 CLI 与服务不能混用。

```sh
node scripts/probe-vm-isolation.mjs /path/to/container
```

可省略参数以使用 PATH 中的 `container`。自定义运行时目录时，按官方启动方式设置 `CONTAINER_APP_ROOT` 和 `CONTAINER_INSTALL_ROOT`，并将同样的环境传给脚本。脚本只操作自己随机命名的容器；每例结束执行精确 ID 清理，不执行全局 stop/prune。成功后删除临时夹具，失败保留夹具供查证。被外部 SIGKILL 时脚本不能保证清理，因此 guest 写入循环自身也有次数上限。

签名核验依赖系统签名服务。本次在受限执行环境中得到 invalid signature，而通过受支持的授权方式访问系统服务后，同一份安装包和二进制通过核验。不能据受限环境的错误直接判定发布物损坏，也不能跳过核验运行。

## 本次结果

可重复脚本 6/6 通过。这里的“通过”包括成功复现两项不安全假设，具体 oracle 如下：

| 用例 | 实际观察 | 含义 |
| --- | --- | --- |
| 仅保护文件自身 | 修改、删除、替换、硬链接被拒绝，但父目录可以改名 | 只读叶节点不足以保护完整路径 |
| 保护文件并独立挂载父目录 | 上述操作与父目录改名均被拒绝，普通文件修改、创建、删除落到宿主 | 该固定目录结构下，祖先挂载可以补足改名保护 |
| 主命令自然退出 | 已产生写入的 setsid 后代停止，后续 500ms 文件大小不变 | 本次自然退出路径清理了该后代 |
| CLI SIGKILL 后显式 stop | CLI 死亡后文件继续增长；stop 后停止，原 runtime PID 消失 | CLI 生命周期不等于 VM 生命周期 |
| CLI SIGKILL 后 bootout --wait | 精确服务注销完成后写入停止，原 runtime PID 消失 | 可继续验证其作为 VM 退出屏障的用途 |
| CLI SIGKILL 后 runtime SIGKILL | runtime 被强杀后写入停止，原 PID 消失 | 本次崩溃路径未留下继续写入的 guest |

最后三例还在收尾后发送真实 `container exec`，均被拒绝，宿主未出现预定的迟到写入文件。文件保护用例也验证 `.git` 写入/删除/改名、remount 和用户命名空间创建被拒绝。观察窗口和攻击集均有限；这不是任意程序、任意故障或所有目录结构的安全证明。

## 为什么不能直接接上 CLI 就宣布完成

固定版 [RuntimeService](https://github.com/apple/container/blob/1.3.1/Sources/Services/RuntimeLinux/Server/RuntimeService.swift) 的自然退出清理会记录并吞掉 `container.stop()` 错误，之后仍设置 stopped；booted 状态也会映射成对外 stopped。因此 inspect 的 stopped 不能单独证明 VM 停止。

[ServiceManager](https://github.com/apple/container/blob/1.3.1/Sources/ContainerPlugin/ServiceManager.swift) 的默认注销只调用普通 bootout，忽略退出码。[ContainersService](https://github.com/apple/container/blob/1.3.1/Sources/Services/ContainerAPIService/Server/Containers/ContainersService.swift) 的删除路径还会忽略部分注销与磁盘清理错误。删除成功或 inspect 不存在也不是独立的运行时退出证明。本机 `launchctl help bootout` 提供单服务 `--wait`，本次实测使用该入口；等待超时不能记为停止。

同一固定版没有按 owner epoch 拒绝旧 create 请求的机制。删除完成后，迟到 create 仍可能重建相同 ID；上述“停止后发送 exec”没有覆盖在途 create/bootstrap/exec 的竞态。

## 接入前仍需完成

1. 将 VM 启动与用户命令释放分开。候选顺序是先启动固定的空闲进程，持久化 VM/运行时身份，再允许执行用户命令；尚需实际验证，不能先把用户命令放进 VM 的 init 参数。
2. 主进程或监督进程死亡后，新 owner 必须先确认旧 VM 已停止。覆盖身份保存、在途启动、命令释放、注销超时及迟到请求，不能仅依赖 PID、CLI 退出或 inspect 状态。
3. 文件保护扩展到多层祖先、预先存在的硬链接、符号链接、缺失路径及并发目录变化。实验只覆盖一个已存在的目录和文件；不能据此承诺这些情况已被保护。
4. 使用真实开发工具链验证 npm、Git、检查命令及命令输出；明确 Linux VM 与宿主 macOS 命令的兼容范围。Alpine shell 探针不能替代产品任务。
5. 接入真实 Core/owner 锁/SQLite/取消恢复链后，再执行对应强杀与打包态验收。现有文件意图协议和已写入的用户效果必须保留，不能靠丢弃工作区使测试通过。
