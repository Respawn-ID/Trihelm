<p align="center">
  <img src="./assets/logo.png" width="128" height="128" alt="Trihelm logo" />
</p>

<h1 align="center">Trihelm</h1>

<p align="center">
  <strong>Antigravity 多模型自主编排中枢</strong><br/>
  <a href="./README.md">English</a> | 简体中文
</p>

<p align="center">
  以 Antigravity 为总控，自动按任务难度和模型特长调度本地 DeepSeek Harness（3 路并发池）、Codex CLI（GPT-6.2 Sol / Astra 与 ChatGPT 内置生图）以及 Antigravity 内建模型，自带 Git Worktree 并行隔离、独立只读复查与零轮询事件唤醒。
</p>

---

## 一句话让你的 AI 自动安装（推荐）

本仓库根目录自带专门给 AI 读的 [`AGENTS.md`](./AGENTS.md) 安装剧本。你不需要手动折腾配置，直接把仓库链接发给你的 **Antigravity**（或 Claude Code / Codex / Cursor），说一句：

> **“读一下 `https://github.com/Respawn-ID/Trihelm` 里的 `AGENTS.md`，帮我安装 Trihelm 插件。”**

AI 会自动检查 Node.js 和 Git、拉取仓库、先用 `--dry-run` 预览路径、运行 `node install.mjs`（绝不覆盖你原有的其他 MCP 配置），并在最后引导你重启验证。

---

## 手动一键安装（macOS / Linux / Windows）

```bash
git clone https://github.com/Respawn-ID/Trihelm.git
cd Trihelm
node install.mjs
```

零依赖安装脚本会自动完成三件事：
1. 把插件本体、图标（`assets/logo.png`）、自主路由规则和技能手册安装到 `~/.gemini/config/plugins/codex-dsh-orchestrator`；
2. 在 `server/` 里自动安装唯一运行依赖 `@openai/codex-sdk`；
3. 自动探测你电脑上的 `node`、`codex`、`dsh` 路径，把 `codex-dsh-orchestrator` 安全合并进 `~/.gemini/config/mcp_config.json`（保留你原有的所有其他 MCP 配置）。

> **为什么注册在全局 `mcp_config.json`？** 这样可以绕开 Antigravity 插件内置 MCP 加载器偶尔丢工具参数的问题，确保全部 11 个工具稳定加载。

安装完成后重启 Antigravity（或重载 MCP Server），在聊天框里问一句 **“检查编排器状态”** 即可验活。

---

## 它帮你自动做什么

装好后，平时像正常聊天一样提需求就行，不用每次手动挑模型，Trihelm 会自动分流并在外派前一句话告诉你：

| 场景 | 自动交给谁 | 说明 |
| :--- | :--- | :--- |
| **问答 / 读代码 / 30 行内小改** | **Antigravity 主控（Gemini 4 Neon）** | 直接改完，不额外外派 |
| **常规功能开发 / 写测试 / 多模块并行** | **DeepSeek Harness（`dsh_run`）** | 3 路 ACP 并发池 + Git Worktree 隔离，自动沿用你本机 DSH 默认模型（同时兼容原版模型名和 `auto/` 路由名） |
| **初版前端美学设计 / 复杂多文件重构** | **Antigravity 内建 Claude Opus 5.5** | 遇到初版视觉设计会先一句话问你要不要切 Opus 5.5（审美更好）；如果 Opus 没额度就由 Gemini 4 Neon 接手，视觉定型后的常规增补交给 DSH 省额度 |
| **日常代码复查 / 跨文件排错 / 生图修图** | **Codex Sol（`gpt-6.2-sol`）** | 日常主力；生图/修图/透明背景抠图优先走 **ChatGPT 内置 `image_gen`**（无需额外 `OPENAI_API_KEY`），支持传本地参考图 `images` |
| **极难算法 / 深层并发死锁 / 连卡 2 次** | **Codex Astra（`gpt-6.2-astra`）** | 严格控频，只在真正攻不下的硬骨头上单次只读诊断，不浪费在日常小活上 |

### 核心工程保障（`v1.4.0`）
- **零计时器事件唤醒（`server/wait-job.mjs`）**：长任务走异步后台，跑完后 100ms 内自动唤醒 Antigravity，等待期间不消耗 token、不设轮询计时器。
- **派发前冷却拦截与透明额度保护**：按错误类型分时长冷却（临时限流 3 分钟、额度耗尽 30 分钟、登录失效仅提示不锁死），冷却期内自动提前拦截提醒（可传 `ignoreCooldown: true` 强行重试）；任何外派出错第一时间一句话通知，遇到额度空 **0 次重试、绝不静默偷切其他通道**。
- **任务串联与重复报错自动刹车**：支持传入 `taskId` 和一句话 `acceptance`（验收条件），自动统计返工次数；同一非额度报错或独立复核连续退回 ≥ 2 次时自动标出 `loopWarning`，防止廉价模型反复撞墙。
- **返回瘦身与报错优先摘要**：自动合并 `codex_run` 冗长的通过命令记录（失败命令原样保留）；超 `16,000` 字的外派回复自动落盘到 `outputFile` 并附上总行数，优先把省略段里的关键报错行摘进摘要，主控用自带 `read_file` 按行看即可。*(如需进一步压缩日常终端命令输出，可本机搭配原生 [`rtk`](https://github.com/rtk-ai/rtk) 的 Agent Hook 模式，注意不要替换系统 `PATH` 里的 `git` 命令。)*
- **按影响大小分级检查**：普通低风险改动跑通本地测试、主控看完 `git diff` 直接交付；重要/高风险改动或发 PR 前才开全新只读会话找另一个模型独立复查（同时防止外派模型靠删改原有测试来蒙混过关）。
- **路径护栏 & 并行合并预检**：写代码任务带 `allowedPaths` / `forbiddenPaths`（默认保护 `.env*` 和 `.git/`）；`worktree_list` 按状态二选一预检冲突——已提交的干净分支走只读 `git merge-tree` 查真冲突（含与主分支合并检查），有未提交改动时退回文件名重合检查，绝不重复报错。

---

## 环境要求

- **必需**：Antigravity、**Node.js ≥ 18**、**Git**。
- **外部后端按需安装（只装其中一个也能正常运行，不会报错卡死）**：
  - **Codex CLI**（登录 ChatGPT 账号）→ 解锁 `gpt-6.2-sol`、`gpt-6.2-astra`、`codex_review` 和 ChatGPT 生图/修图。
  - **DeepSeek Harness（`dsh`）** → 解锁 3 路并发编码池；**支持任意官方模型名（如 `deepseek-flash` / `deepseek-v4-pro`）或第三方路由组名（如 `auto/deepseek-v4.1-flash`）**，默认直接沿用你在 DSH 里选好的模型，也能自动做跨名称映射。

---

## 安装脚本常用参数

```bash
node install.mjs --dry-run                       # 只预览将改动什么，不落盘
node install.mjs --dsh-concurrency 4             # 修改 DSH 并发数（1～6，默认 3）
node install.mjs --codex-bin /自定义路径/codex     # 手动指定 codex 路径
node install.mjs --dsh-bin /自定义路径/dsh         # 手动指定 dsh 路径
node install.mjs --uninstall                     # 干净卸载（保留你其他 MCP 配置）
node install.mjs --uninstall --purge-data        # 卸载并清空历史任务记录与统计
```

如需在环境变量里固定 DSH 默认模型，也可在 `~/.gemini/config/mcp_config.json` 的 `codex-dsh-orchestrator.env` 中设置 `DSH_DEFAULT_PROVIDER` 和 `DSH_DEFAULT_MODEL`（不设则自动沿用本机 DSH 当前选中模型）。

---

## 提供的 11 个 MCP 工具

| 分类 | 工具 |
| :--- | :--- |
| **状态与统计** | `orchestrator_status` |
| **Codex / 生图** | `codex_run`（支持 `verdictMode`、`images`、`allowedPaths`、`async`）、`codex_review` |
| **DeepSeek Harness** | `dsh_run`（并发池、自动模型名适配、`verdictMode`、`allowedPaths`、`async`）、`dsh_close` |
| **Git 并行隔离** | `worktree_create`、`worktree_list`（带冲突预检）、`worktree_cleanup` |
| **异步后台任务** | `job_status`、`job_cancel`、`job_list`（配合 `server/wait-job.mjs` 自动唤醒） |

---

## 本地开发与测试

```bash
cd server
npm install
npm test
```

## 开源协议

MIT
