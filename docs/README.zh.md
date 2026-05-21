# Hydra

<p align="center">
  <img src="../resources/logo.jpg" alt="Hydra" width="600" />
</p>

<p align="center">
  <strong>多头齐进，代码狂飙。</strong><br>
  直接在 VS Code 中编排 AI 代理军团，让并行开发成为现实。
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=zhoujinjing.hydra-code">
    <img src="https://vsmarketplacebadges.dev/version/zhoujinjing.hydra-code.svg" alt="Marketplace" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=zhoujinjing.hydra-code">
    <img src="https://vsmarketplacebadges.dev/installs/zhoujinjing.hydra-code.svg" alt="Installs" />
  </a>
  <a href="../LICENSE.md">
    <img src="https://img.shields.io/github/license/joezhoujinjing/hydra" alt="License" />
  </a>
</p>

<p align="center">
  <img src="hydra-demo.gif" alt="Hydra 在 VS Code 中编排并行 AI 代理的演示" width="800" />
</p>

🌏 **其他语言:** [English](../README.md) | **中文**

---

## 愿景

在希腊神话中，Hydra（九头蛇）是一个每砍掉一个头就会长出两个头的神兽。在软件工程中，我们也面临着类似的“怪兽”：任务积压的速度永远快于代码产出的速度。

**Hydra** 彻底反转了这个隐喻。我们不再与增长对抗，而是拥抱它。你将成为开发过程中的“中枢神经系统”，根据需要随时生成并编排多个 AI 代理“头”。一个头负责构建认证模块，一个头负责优化数据库，第三个头负责编写测试——所有工作同时进行，所有状态在侧边栏一目了然。

**停止串行思考，开启并行时代。**

---

## 并行开发的故事

想象一下，你需要从旧代码库平移 40 个功能。独自一人完成这件工作通常需要数周的苦战。而使用 Hydra，流程如下：

1. **启动 Copilot**（指挥官）：在 `main` 分支上告诉它：“分析这 40 个功能，并将它们拆解为 8 个逻辑组。”
2. **委派 Worker**（兵团）：只需一条指令，Copilot 就会生成 8 个 Worker。每个 Worker 拥有独立的 git 分支、隔离的工作区（worktree）以及专属的 AI 代理（Claude、Gemini 或 Codex）。
3. **编排与监控**：你只需关注侧边栏。8 个终端正在跳动，8 个代理正在疯狂输出。你可以实时看到它们的 CPU 占用、Git Diff 以及任务进度。
4. **审查与交付**：当 Worker 完成工作，你审查代码，合并分支，搞定收工。

**原本需要数周的工作，现在只需数小时。**

```text
[ 你：首席架构师 ]
         │
         ▼
 [ COPILOT (main) ] ──────────────────┐
 (规划、监控、审查)                      │
         │                            │
         ├─> [ WORKER 1 (feat/auth) ] ─┼─> "正在构建 OAuth2 流程..."
         ├─> [ WORKER 2 (feat/ui)   ] ─┼─> "正在调整看板样式..."
         ├─> [ WORKER 3 (fix/perf)  ] ─┼─> "正在优化数据库查询..."
         └─> [ WORKER 4 (docs/api)  ] ─┼─> "正在生成 API 文档..."
                                      │
                                 [ AI 军团 ]
```

---

## 为什么选择 Hydra？

- **串行瓶颈**：任务切换的成本极高。等待一个 AI 代理跑完再去启动下一个，是对你最宝贵资源——时间的极大浪费。
- **环境隔离**：Hydra 为每个代理分配独立的 git worktree。不再有“代码串门”导致的幻觉，也不再有多个代理修改同一目录下的文件引发的 Git 冲突。
- **灵魂永驻**：每个代理都运行在 `tmux` 会话中。即使你关掉 VS Code、重启电脑，甚至通过手机 SSH 连入，你的代理军团依然在为你彻夜工作。

---

## 60 秒快速上手

1. **安装**：在 VS Code 应用商店搜索 **"Hydra Code"**。
2. **环境**：确保系统中已安装 `tmux` 和 `git`。
3. **启动 Copilot**：打开 Hydra 侧边栏（机器人图标），点击 **"Create Copilot"**。
4. **创建第一个 Worker**：
   - 点击 **"Create Worker"**。
   - 输入分支名（如 `feat/my-new-idea`）。
   - 选择代理（如 `claude`）。
   - **见证奇迹的时刻。**

---

## 核心能力

### 🏛️ 指挥中心（侧边栏）
侧边栏不再仅仅是文件树，它是你 AI 军团的高保真仪表盘。
- **实时生命体征**：查看每个代理的 CPU 占用、终端活跃度和面板计数。
- **Git 洞察**：追踪每个 Worker 领先主分支的提交数，以及精准的文件变更统计。
- **一键触达**：快速进入任何代理的终端，或将会话直接嵌入为编辑器标签页。

### 💂 AI 军团（Worker 与 Worktree）
Hydra 自动处理繁琐的 Git 管理工作。
- **隔离工作区**：每个 Worker 在 `.hydra/worktrees/` 下都有专属目录，绝不干扰你的主工作区。
- **自主模式**：支持以自动批准权限启动 Worker，实现“你睡觉，它干活”。

### 🧠 核心大脑（Copilot）
Copilot 是你的技术负责人。它无需独立工作区，直接运行在当前文件夹，通过 `hydra` CLI 指挥所有 Worker。

### 🖇️ 智能工具
- **CLI 优先**：通过 `hydra` 命令，你（和你的代理）可以从终端控制一切。
- **智能粘贴**：复制了图片？在终端按 `Cmd+V`，Hydra 会自动保存并插入路径。完美解决向代理反馈 UI bug 的痛点。

---

## 参考与文档

- [**AGENTS.md**](../AGENTS.md) — 完整的“代理操作手册”（CLI 参考、内部架构与高级配置）。
- [**应用场景**](../examples/) — 真实用例，如[功能平移](../examples/parity-port.md)和 [gRPC 生成](../examples/grpc-generation.md)。
- [**更新日志**](../CHANGELOG.md) — 查看最新版本的变化。

## 系统要求
- **tmux** — 持久运行的引擎。
- **git** — 环境隔离的基础。
- **VS Code 1.85.0+**

## 许可证
[MIT](../LICENSE.md) — 为 AI 原生开发的未来倾情打造。
