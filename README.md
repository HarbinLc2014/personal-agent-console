# Personal Agent Console

一个私有、移动优先的 Agent 遥控台 MVP。手机端以可安装 PWA 运行，通过 Relay 同时管理多台个人电脑上的 Codex、Claude Code、Pi、OpenCode 等 harness；电脑端 daemon 只发起出站连接，不要求把本机终端端口直接暴露到公网。

这是一个独立的个人项目。运行状态、凭据和受管文件保留在部署者自己的设备上，不进入 Git 仓库。

## 已实现

- 多电脑上线、离线状态与 harness 自动检测
- 由 daemon 启动并持有真实 PTY 会话
- 手机实时查看终端输出、发送输入、`Ctrl-C`、停止会话
- 手机可在启动单个 Codex/Claude Code 会话时授予完全访问；该会话跳过后续 harness 权限确认
- 白名单目录浏览、手机接收文件、手机发送文件
- 新文件直接写入；覆盖已有文件必须经过一次性人工审批
- 路径穿越与符号链接逃逸防护、文件大小限制、覆盖前 stale-file 校验
- Relay 端 SQLite 持久化机器、会话、事件和审批记录
- 手机端 PWA manifest、移动/桌面响应式界面
- App token 与 daemon token 分离；daemon 启动 agent 子进程时不会传递 `FLEET_*` 凭据

当前 harness 集成是通用 PTY 适配器。协议已经预留结构化 tool-call 事件，但 Codex/Claude/Pi/OpenCode 的专用事件解析器还没有实现，因此目前这些工具调用会作为终端输出显示，不应宣称已经完成结构化工具审计。

## 会话级完全访问

新建会话时可以在手机上打开“完全访问此电脑”。授权只绑定该次会话，不会永久修改 daemon，也不会改变手机文件服务的白名单与覆盖审批规则。

- Codex 会以 `--dangerously-bypass-approvals-and-sandbox` 启动。
- Claude Code 会以 `--dangerously-skip-permissions` 启动。
- 该会话可以访问当前操作系统用户本身能访问的文件、凭据和命令，不再受 `FLEET_ALLOWED_ROOTS` 限制；白名单只约束手机文件页。
- Pi/OpenCode 暂未启用一键完全访问，直到加入并验证各自的专用适配器。

这是高风险授权，应只在你控制且信任的电脑和会话上开启。[Codex CLI 官方参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)也将其无审批、无沙箱模式标为极高风险，并建议只在外部加固环境使用；Claude Code 的对应参数见[官方 CLI 参考](https://docs.anthropic.com/en/docs/claude-code/cli-usage)。

## 结构

```text
手机 PWA ── HTTPS/WSS ──> Relay + SQLite <── 出站 WSS ── 各电脑 daemon
                                                    ├── Codex PTY
                                                    ├── Claude Code PTY
                                                    ├── Pi/OpenCode PTY
                                                    └── 白名单文件服务
```

- `apps/mobile`：React/Vite 手机控制台
- `apps/relay`：HTTP、WebSocket、事件与状态存储
- `apps/daemon`：电脑端 harness、PTY、文件安全边界
- `packages/protocol`：Relay、daemon、手机端共用的 Zod 协议

## 本机启动

要求 Node.js 24+ 和 pnpm 11+。

```bash
cd personal-agent-console
cp .env.example .env
pnpm install
pnpm build
pnpm start:local
```

启动前必须编辑 `.env`：

- 把两个 token 改成不同的长随机值，例如分别运行 `openssl rand -hex 32`
- 把 `FLEET_ALLOWED_ROOTS` 改成确实允许手机访问的项目目录
- macOS/Linux 多个目录用 `:` 分隔；Windows 用 `;` 分隔
- 保持 `FLEET_ENABLE_SHELL=0`；它只用于受控的端到端测试，不是正常使用所必需

构建后打开 `http://127.0.0.1:4317`，点击右上角连接状态并输入 `.env` 中的 `FLEET_APP_TOKEN`。

开发模式：

```bash
pnpm dev
```

开发 UI 在 `http://127.0.0.1:4318`，API 和 WebSocket 会代理到 4317。

## 接入多台电脑

在 Relay 所在设备运行 `pnpm start`。每台受管电脑各运行一个 daemon：

```bash
FLEET_RELAY_URL="wss://你的私有Relay地址/ws/daemon" \
FLEET_DAEMON_TOKEN="与Relay相同的daemon token" \
FLEET_MACHINE_NAME="工作室-Mac" \
FLEET_ALLOWED_ROOTS="/Users/you/Projects" \
pnpm start:daemon
```

daemon 的机器 ID 会保存在它自己的 `FLEET_STATE_DIR`。每台电脑使用独立状态目录，就会作为不同机器出现在手机端。

Relay 本身暂不终止 TLS，也没有端到端加密。不要直接把 4317 端口裸露到公网；应放在你自己的私有 VPN/mesh 网络或 HTTPS 反向代理后面。公网化之前还需要补设备级身份、token 轮换/吊销、速率限制和审计导出。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm e2e
pnpm format:check
```

`pnpm e2e` 会在临时目录启动真实 Relay、daemon 和 PTY，验证：机器注册、HTTP 会话输入、终端输出/完成状态、文件双向传输、覆盖审批、PWA 静态服务；结束后删除临时状态。

## 成本边界

本地开发和同一私有网络内运行不要求购买 SaaS。主要潜在成本来自你选择的公网 Relay 主机/域名/私有网络方案，以及 Codex、Claude 等 harness 自己的模型订阅或 API 用量。本项目不会自动调用模型或消耗付费额度；只有你从手机主动启动并操作相应 harness 时，才可能产生该服务自身的费用。

## 还未完成

- iOS/Android 原生壳、推送通知与后台保活
- 断线后的 PTY 进程恢复/重接；当前 daemon 重启会结束它管理的会话
- harness 专用结构化 tool-call/usage/cost 适配器
- Git diff、文件编辑器、图片/音视频内联预览
- 设备配对、每设备证书、E2EE、组织/多人权限
- Relay 正式部署、自动更新与安装包签名

因此当前交付是可运行、已本地联调的私人 MVP，不是已经上线的生产版移动 App。
