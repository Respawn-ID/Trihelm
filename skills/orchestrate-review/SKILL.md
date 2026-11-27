---
name: orchestrate-review
description: >-
  Autonomous multi-model orchestration playbook for Antigravity (Gemini 4 Neon /
  built-in Claude Opus 5.5), pooled DeepSeek Harness (dsh via ACP), and local
  Codex CLI (GPT-6.2 Astra / Sol): pre-flight complexity triage (L0/L1A/L1B/L2),
  2-failure cascading escalation, brief contracts with path ownership guardrails,
  Git worktree parallelization, 30-min async job tracking, deterministic gates,
  and fresh-context structured Verdict cross-verification.
---

# 主控自主路由、多模型协作与验收规范（Trihelm v1.4）

Antigravity 担任**唯一自主主控（前置分诊、路由决策、契约派单、Worktree 隔离与串行合并、失败级联升级、确定性门控与异构验收）**，统筹本机 **DeepSeek Harness (`dsh` 3 槽并发池)**、**Codex CLI (`GPT-6.2 Astra` / `GPT-6.2 Sol`)** 以及 **Antigravity 本体模型（Gemini 4 Neon / 内建 Claude Opus 5.5）**。

> **自主触发原则**：无需等用户点名具体后端，收到任务后直接按下方路由决策树自主分派，并在外派前用**一句话简报路由理由**；若用户明确指定模型或要求“你自己直接写”，立即服从用户覆盖。

---

## 一、五模型核实定位与路由矩阵

| 层级 | 执行方 / 工具 | 默认模型 / 通道 | 核心甜点场景 | 避坑边界 |
| :--- | :--- | :--- | :--- | :--- |
| **L0 · 总控/直通** | **Antigravity 主控** | **Gemini 4 Neon (High)**（日常默认）或内建 **Opus 5.5** | 仓库全局测绘、拆单排兵、深度 Code Audit、单文件小改（<30 行）、配置微调、终审与串行合并 | 不把大批量多文件纯体力代码留在主控硬写 |
| **L1A · 高吞吐纯代码主力** | `dsh_run` / `dsh_close` | **DeepSeek Harness 默认模型**（3 槽 ACP 并发池；默认不硬写 `provider`/`model`，自动沿用本机 DSH 默认模型，也兼容原模型名 `deepseek-flash`/`deepseek-v4-pro` 与 `auto/*` 路由名自动映射） | 需求清晰的后端/全栈开发、主流语言（Python/Go/TS/JS）算法实现、批量补单测、2～3 个独立模块 Worktree 并行写 | 精细前端视觉动效与冷门小众语言非强项 |
| **L1B · 初版美学前端 & 精品重构（额度较紧）** | **Antigravity 本体**（不调独立本地 `claude` CLI） | **内建 Claude Opus 5.5**（**初版前端美学通常优先**，无额度时由 **Gemini 4 Neon** 接手；默认 `medium` 档） | **初版美学前端/UI 视觉与交互设计（Opus 审美好）**、复杂多文件架构级重构、复杂组件状态工程、要求一次 merge-ready 的核心主干 | 当前会话为 Gemini 4 Neon 遇到初版美学前端时，**先一句话通知并询问用户：切内建 Opus 5.5 负责（优先），还是直接由 Neon（本体）接手（Opus 没额度时直接由 Neon 扛，不交给 DSH 画初版视觉）**；视觉定型后的常规逻辑增补、批量编码和单测外派 DSH 省额度；不把默认配额兜底甩给 Opus |
| **L1C · Codex 日常高频主力** | `codex_review` / `codex_run` | **GPT-6.2 Sol**（日常默认 `medium`；复杂排障/高危验收 `high`） | **Codex 侧默认首选**：日常 PR/Diff 独立交叉验收（高检出、低误报）、常规跨文件 Bug 排查、常规设计复核、轻量/中等常规编码及 DSH 兜底 | 日常遇到疑难先让 Sol (`high`) 或 Neon 攻关；确实解不动再升 Astra |
| **图像生成/编辑（优先）** | `codex_run`（内置 `$imagegen` / `image_gen`） | **ChatGPT 图像模型**（经 **GPT-6.2 Sol**, `low`/`medium` 调度，无需 `OPENAI_API_KEY`） | **所有位图生成与编辑首选**（照片、插画、UI 概念图、产品图、透明背景抠图、风格迁移），优先于 Antigravity 内建 `image-generator` | 绝不为此消耗 Astra 额度；传参考图/待修图用 `images: [...]`；项目素材通过 `workspace-write` + `allowedPaths` 落盘到工作区（或由主控从 `~/.codex/generated_images/` 复制）；仅当 ChatGPT 图像通道出错/配额空（先一句话汇报）或用户点名时再降级至内建 `image-generator` |
| **L2 · 低频重型外脑（严格控频）** | `codex_run`（`async: true`） | **GPT-6.2 Astra**（`high` / `xhigh` / `max` / `ultra`） | **低频高门槛触发**：仅限前沿科研/数学/极难算法、Neon + Sol (`high`) 仍无法定位的跨服务并发/性能死锁、或连续失败 ≥ 2 次后的级联升级 | **严控调用频次**：日常审查/常规排障一律先用 Sol；确需调用时把精简上下文攒齐一次 `read-only` 问透，落地与复核交回 DSH / Sol，禁止零碎反复调 Astra 或做大段重写 |

---

## 二、推理强度自适应矩阵（Reasoning Effort）

遵循**「各家官方甜点起步 + 按任务阶段粗粒度选档 + 极限档仅作逃生舱」**原则，派单时显式传入对应的 `reasoningEffort`（避免全局拉满导致过度思考、延迟暴涨和配额浪费）：

| 模型 / 工具 | 轻量 / 查代码 / 标准单测 | 日常主力（默认甜点） | 复杂排障 / 高危验收 | 极限逃生舱（必配 `async: true`） |
| :--- | :--- | :--- | :--- | :--- |
| **DSH (`dsh_run`)**<br>*DeepSeek V4.1 Flash* | `off`（纯格式化）<br>`low`（读代码、标准单测、简单改 Bug） | **`high`**（多文件功能实现、常规重构） | **`high`**（常规）<br>**`max`**（并发/安全关键逻辑） | **`max`**（长上下文复杂模块攻坚） |
| **Codex Sol（日常首选）**<br>*`codex_review` / `codex_run`* | `low`（快速扫查） | **`medium`**（日常 PR / `verdictMode` 验收、轻量常规编码） | **`high`**（常规复杂排障、跨文件设计复核、高风险验收——先于 Astra 使用） | 确实攻不下再升 Astra |
| **Codex Astra（低频控频）**<br>*`codex_run` (`async: true`)* | 严禁用于日常轻活/常规审查 | **`high`**（仅高门槛算法/重型架构，攒齐上下文单次调用） | **`xhigh`**（Neon + Sol 仍未解决的跨服务死锁、2 次失败级联诊断） | **`max` / `ultra`**（罕见逃生舱：前沿科研数学、内核级优化，必配 `read-only`） |
| **Antigravity 主控**<br>*Gemini 4 Neon / 内建 Opus 5.5* | Neon `medium` / `low`<br>Opus 5.5 `low` | **Neon `high`**<br>**Opus 5.5 `medium`** | Neon `high`→`xhigh`<br>Opus 5.5 `high`（Debug）/ `xhigh`（跨包大重构） | Neon `xhigh`<br>Opus 5.5 `max`（慎用，防跑成超长任务） |

---

## 三、标准 4 段派单契约（写代码任务必带）

向 `dsh_run` 或 `codex_run` 派发修改任务时，Prompt 必须明确以下 4 段，并同步通过工具参数传入 `allowedPaths` / `forbiddenPaths` 做硬校验：

```text
Owns (allowed paths): <明确可改的相对路径列表>
Must not touch: <禁止触碰的文件/目录，及共享核心文件>
Task: <一句话清晰目标>
Done when: <必须通过的验证命令> passes and <可观测结果>.
Report: 列出改动文件、实际执行命令的最后 10-20 行输出；凡未实测项必须标 "not measured"。同一障碍尝试超 2 次立即停止并向主控汇报。
```

---

## 四、外派出错通知、失败级联升级与熔断机制（Always-Notify + Cascading Escalation）

> **统一透明原则**：**无论外派模型（DSH / Codex Astra / Codex Sol）发生普通执行/代码/超时出错，还是额度空/限流，都必须第一时间用一句话通知用户**（说明“谁出了什么错 + 下一步动作”），绝不静默吞错。

防止“过早升级烧钱”与“廉价模型死循环”（**仅适用于代码/测试/逻辑/普通执行报错；配额耗尽走下方第五节，绝不重试**）：

1. **本地自修窗口与任务串联**：派单可传稳定的 `taskId` 与一句话 `acceptance`（验收条件），服务端自动统计返工次数并在同类非额度报错或复核连续退回 ≥ 2 次时返回 `loopWarning`（`loopDetected: true`）。外派模型报常规语法、类型、单测或临时执行错误时，**先一句话通知用户**，再允许原执行方（如 DSH）复用原 `sessionId`/`threadId` 自行修复 **1～2 轮**。
2. **连续失败 ≥ 2 次触发升级（含程序刹车信号）**：
   - 若收到 `loopWarning.loopDetected: true`、同一障碍连续失败 ≥ 2 次，或被 Verifier 连续 `REJECTED` 2 次，**立刻一句话通知用户并停止原 Worker 死磕**；
   - 主控提炼精简失败包（当前 `git diff` + 关键报错尾部 + 已尝试失败路径），按根因类型升级：
     - **底层根因 / 并发死锁 / 算法逻辑死胡同** → 若尚未用过 Sol 深度排查，可先用 **Codex Sol（`high`, `read-only`）** 快速核查；若 Sol/Neon 仍未定位或确属硬核根因，再单次升级给 **Codex Astra（`read-only`, `async: true`）** 产出修正计划（严控 Astra 调用频次）；
     - **复杂多文件重构 / 前端状态缠绕** → 该用就用，升级给 **Antigravity 内建 Claude Opus 5.5**（主控已是 Opus 5.5 直接接管，否则提示切模型或 `/swarm` 并说明其额度较紧）。
3. **HITL 人工暂停**：升级后仍无法收敛、发现需求存在根本歧义、或出现严重 `scopeAudit.violations` 时，立刻暂停自动循环，给出 ≤15 行阻塞报告交由用户拍板。

---

## 五、额度耗尽与限流处理规范（派发前冷却拦截 + 一句话先汇报）

服务端对冷却期按错误类型分时长管理：**临时限流（429）冷 3 分钟、额度耗尽冷 30 分钟、登录失效仅提示不锁死**；派发前会自动拦截处于冷却期的模型并返回 `cooldownBlocked: true`（用户要求强行重试时可传 `ignoreCooldown: true`）。

当任意后端返回 `errorKind: "quota_exhausted" | "rate_limited" | "auth_error"` 或 `cooldownBlocked: true`（含 `reportBeforeFallback: true`，或报错出现 `429` / `insufficient_quota` / `usage limit` / `capacity` / 额度不足）时：

1. **零重试**：绝不计入代码自修次数，绝不反复重撞已空额度的通道。
2. **先一句话向用户汇报并等待拍板（严禁静默切走）**：立即暂停当前受影响轨道，简明告知：
   - 哪个后端/模型额度空或限流（附原因摘要）+ 当前进度；
   - 建议的接棒选项（按高配额优先排序），等用户确认后再切通道继续。
3. **推荐接棒顺序（不把较紧的内建 Opus 5.5 作为常规默认第一兜底，需要时再选项列出）**：
   - **DSH (`DeepSeek V4.1 Flash`) 额度空** → 首选推荐 **Codex Sol (`gpt-6.2-sol`, `medium`)** 接手编码/单测；次选 **Gemini 4 Neon** 主控直接完成。
   - **Codex Astra (`gpt-6.2-astra`) 额度空** → 诊断/架构首选推荐 **Gemini 4 Neon (`high`/`xhigh`)**；偏实现推荐 **DSH (`max`)**；若涉及复杂重构/架构也一并列出 **内建 Opus 5.5** 供选择（备注额度较紧）。
   - **Codex Sol (`gpt-6.2-sol`) 额度空** → 保持异构交叉验收：DSH 写的代码推荐 **Gemini 4 Neon** 主控审；主控写的代码推荐 **DSH (`read_only` + `verdictMode: true`)** 审。
   - **Antigravity 主控当前模型额度空** → 提示用户在顶部切换可用内置模型（Neon ↔ Opus 5.5，保留上下文），或在活跃 `/swarm` 中获用户批准后调用 `swarm(action: "model")` 切换。

---

## 六、长耗时任务与事件驱动无感唤醒（彻底告别定时轮询与 3 分钟硬超时）

- **短任务（预计 < 2 分钟）**：常规只读 Review、小改动 → 同步调用（支持 `notifications/progress` 实时推送）。
- **长任务（预计 ≥ 2 分钟，甚至 10～30 分钟）**：Astra 深度推理、DSH 多文件实现、大范围验收 → **必须传 `async: true`**（默认 30 分钟超时）：
  1. **事件驱动即时唤醒（默认首选，零 token、不用 `schedule` 计时器）**：
     - 异步启动后直接拿到返回的 `waitCommand`（即 `node .../server/wait-job.mjs <jobId>`），若同时跑多个并行任务可传 `--all <id1> <id2>` 或 `--any <id1> <id2>`；
     - 用后台 `run_command` 启动该命令（`WaitMsBeforeAsync: 500`, `NotificationTimeoutSeconds: 600`）然后直接结束本轮挂起等待；
     - 任务落盘进入终态后 `wait-job.mjs` 在 **100ms 内退出**，Antigravity 自动收到完成唤醒通知，再调用 `job_status(jobId, waitSeconds: 0)` 取完整结果（自带 MCP 进程存活保护，不会死等）。
  2. **大输出自动瘦身与报错优先摘录**：超长响应（默认 >16,000 字符）会自动落盘到 `outputFile` 并附上总行数 `outputTotalLines`，同时从省略段落中优先摘出关键报错行；`codex_run` 冗长的成功命令轨迹也会自动合并统计（失败命令原样保留）。主控按需用自带 `read_file(outputFile, StartLine, EndLine)` 分段查看细节。
  3. **运维与观测**：方向跑偏或用户喊停时调用 `job_cancel(jobId)` 精准中止；`job_list()` 查看任务；`orchestrator_status()` 查看连通性、并发池、**跨窗口共享的 `telemetry.activeCooldowns`（分时长冷却）、返工统计、活跃循环警告及当日各模型调用频次/token 统计**。

---

## 七、核心协作与验收流程

### 1. 单轨道开发 + 确定性先验 + 分级异构验收
1. **带护栏派单**：写任务必传 `allowedPaths` / `forbiddenPaths`；未开 Worktree 时严禁两方同时写同一 `cwd`。
2. **先跑本地检查 + 防止乱改原有测试**：
   - 主控先核对 `scopeAudit.violations`、`scopeAudit.diffStat`（各文件增删行数，及 DSH `deniedActions`）和 `git diff`；
   - **禁止偷懒改坏原有测试**：修 Bug 或重构时，不能让外派模型通过删减或放宽原有测试来勉强跑通；需要时把已有测试目录放进 `forbiddenPaths`，并在结束后检查 `scopeAudit.changedFiles`；
   - 主控亲自运行本地测试 / 类型检查 / lint；没跑通就直接复用原 `sessionId`/`threadId` 打回返工，不浪费第二个模型去审没跑通的代码。
3. **按改动影响大小决定要不要额外找别的模型复查**：
   - **普通低风险改动（日常大多数）**：常规功能增改、界面样式微调、文档和非核心小改 → 本地测试和构建通过、主控看完 `diff` 没问题就**直接交付**（不额外拉 Codex 再审一轮，也不为小改动硬补多余测试）；
   - **重要 / 高风险改动或发 PR 前**：涉及核心架构重构、并发/状态逻辑、登录安全、支付/数据库迁移，或用户明确要求严格复查 → 找另一个模型开新会话跑 **`verdictMode: true`** 只读复查（高风险改动最后由用户确认）：
     - 常规及重要改动 → 优先 **Codex Sol**（`codex_run(model: "gpt-6.2-sol", verdictMode: true)`，日常 `medium` / 高风险 `high`，或 `codex_review`）；
     - 极高风险核心改动 → 换另一个强模型复查（DSH 写的优先交 **Codex Sol (`high`)** 或 **Neon**；Opus 5.5 写的优先交 **Codex Sol (`high`)** 或 **Neon**；仅极端安全/并发核心才动用 Astra）。
4. **交付或返工（汇报一律说人话）**：向用户汇报进度、报错和最终结果时直接说人话，不堆“门控/门禁/断言/爆炸半径/异构裁决”这类黑话，讲清楚改了什么、跑没跑通、有没有问题即可；`REJECTED` 则复用原实现方 `sessionId`/`threadId` 附带问题清单返工。

### 2. 多模块真并行写模式（按需 Git Worktree + DSH 3 槽并发池）
当任务可清晰拆分为 2～3 个互不重叠的独立模块（如 `@api`、`@ui`、`@tests`）时：
1. **建隔离区**：调用 `worktree_create(repoCwd, name, copyEnv: true, symlinkDirs: [...])` 获取独立 `worktreePath` 与 `orch/*` 分支。
2. **真并行派发**：将各自 `worktreePath` 作为 `cwd`、各自模块路径作为 `allowedPaths`，并发派发 `dsh_run(..., async: true)` / `codex_run(..., async: true)`。
3. **独立验收**：各轨道在对应 `worktreePath` 内过确定性测试 + 异构 `verdictMode: true` 验收。
4. **冲突预检 + 主控串行合并与清理**：合并前先调用 `worktree_list(repoCwd)` 检查 `mergeWithMain` 和 `potentialConflicts`（已提交的干净分支走只读 `git merge-tree` 真冲突检查，有未提交改动时自动退回文件名重合检查，绝不重复报两套）；**绝不让子 Agent 自动解合并冲突**；由主控在主仓库逐一审 diff 并串行合并/cherry-pick，最后调用 `worktree_cleanup(repoCwd, worktreePath, deleteBranch: true)` 清理现场。

### 3. 会话卫生
- **返工**：复用原实现方的 `sessionId`（DSH 并发池按亲和路由回原进程）或 `threadId`（Codex）。
- **验收**：永远开新会话（`verdictMode: true` 强制拒绝传 `sessionId`/`threadId`）。
- **收尾**：任务结束后调用 `dsh_close(sessionId)` 释放会话；清理已合并的临时 Worktree。
