#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { DshAcpPool } from "./lib/dsh-pool.mjs";
import { classifyBackendError, formatMcpErrorText } from "./lib/errors.mjs";
import { DEFAULT_INLINE_LIMIT, spillLargeOutput } from "./lib/output.mjs";
import { resolveCodexBin, resolveDshBin } from "./lib/paths.mjs";
import { auditScopeAfterRun, captureGitSnapshot, resolveScopeConfig } from "./lib/scope.mjs";
import { TelemetryStore } from "./lib/telemetry.mjs";
import { parseVerdictResponse, prepareVerdictArgs } from "./lib/verdict.mjs";
import { worktreeCleanup, worktreeCreate, worktreeList } from "./lib/worktree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WAIT_JOB_SCRIPT = path.join(__dirname, "wait-job.mjs");

const SERVER_VERSION = "1.3.0";
const CODEX_BIN = resolveCodexBin();
const DSH_BIN = resolveDshBin();
const DSH_MAX_CONCURRENCY = Number(process.env.DSH_MAX_CONCURRENCY) || 3;
const JOBS_DIR =
  process.env.JOBS_DIR ||
  path.join(
    os.homedir(),
    ".gemini",
    "antigravity",
    "plugin_data",
    "codex-dsh-orchestrator",
    "jobs"
  );
const METRICS_FILE =
  process.env.METRICS_FILE || path.join(path.dirname(JOBS_DIR), "metrics.json");
const telemetry = new TelemetryStore(METRICS_FILE);

const DEFAULT_SYNC_TIMEOUT_MS = 150_000; // 2.5 min (safely under 3 min MCP call limit)
const DEFAULT_ASYNC_TIMEOUT_MS = 1_800_000; // 30 min for deep reasoning / large tasks
const MAX_WAIT_SECONDS = 120; // cap long-poll at 2 min
const MAX_TEXT_CHARS = 120_000;
const MAX_PERSISTED_JOBS = 50;

function log(...args) {
  process.stderr.write(`[codex-dsh-orchestrator] ${args.join(" ")}\n`);
}

function truncate(str, max = MAX_TEXT_CHARS) {
  if (typeof str !== "string") return "";
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n\n...[truncated ${str.length - max} chars]`;
}

function resolveCwd(cwd) {
  const target = cwd ? path.resolve(cwd) : process.cwd();
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Working directory does not exist: ${target}`);
  }
  return target;
}

function resolveTimeoutMs(args, isAsync) {
  const raw = Number(args?.timeoutMs);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return isAsync ? DEFAULT_ASYNC_TIMEOUT_MS : DEFAULT_SYNC_TIMEOUT_MS;
}

function createAbortError(message = "Aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

// ---------------------------------------------------------------------------
// 1. Codex Runner (@openai/codex-sdk streamed + official `codex review`)
// ---------------------------------------------------------------------------

function createCodexClient() {
  return new Codex({
    codexPathOverride: CODEX_BIN,
  });
}

function resolveInputImages(images, cwd) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const resolved = [];
  for (const raw of images) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = path.isAbsolute(raw.trim()) ? raw.trim() : path.resolve(cwd, raw.trim());
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`Input image file does not exist: ${abs}`);
    }
    resolved.push(abs);
  }
  return resolved;
}

function validateCodexArgs(args) {
  if (!args?.prompt || typeof args.prompt !== "string") {
    throw new Error("`prompt` (string) is required.");
  }
  const cwd = resolveCwd(args.cwd);
  resolveInputImages(args.images, cwd);
  return prepareVerdictArgs("codex", args);
}

async function runCodex(args, { signal, onProgress, isAsync = false } = {}) {
  const verdictPrep = validateCodexArgs(args);
  const cwd = resolveCwd(args.cwd);
  const sandboxMode = verdictPrep.active
    ? verdictPrep.sandboxMode
    : args.sandboxMode || "read-only";
  const approvalPolicy = args.approvalPolicy || "never";
  const timeoutMs = resolveTimeoutMs(args, isAsync);
  const scopeConfig = resolveScopeConfig(args);
  const shouldAuditScope = sandboxMode !== "read-only" || scopeConfig.hasExplicitScope;
  const beforeSnapshot = shouldAuditScope ? captureGitSnapshot(cwd) : null;

  const threadOptions = {
    workingDirectory: cwd,
    sandboxMode,
    approvalPolicy,
    skipGitRepoCheck: args.skipGitRepoCheck ?? true,
  };
  if (args.model) threadOptions.model = String(args.model);
  if (args.reasoningEffort) threadOptions.modelReasoningEffort = String(args.reasoningEffort);
  if (Array.isArray(args.additionalDirectories) && args.additionalDirectories.length > 0) {
    threadOptions.additionalDirectories = args.additionalDirectories.map(String);
  }

  const codex = createCodexClient();
  const thread = args.threadId
    ? codex.resumeThread(String(args.threadId), threadOptions)
    : codex.startThread(threadOptions);

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort(createAbortError("Cancelled by caller"));
  };
  if (signal) {
    if (signal.aborted) {
      onExternalAbort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const progress = {
    stage: "starting",
    threadId: args.threadId ? String(args.threadId) : null,
    model: args.model ? String(args.model) : "default",
    reasoningEffort: args.reasoningEffort ? String(args.reasoningEffort) : null,
    verdictMode: verdictPrep.active,
    commandsRun: 0,
    filesChanged: 0,
    reasoningSteps: 0,
    lastActivity: "Launching Codex CLI",
  };
  const emitProgress = () => {
    if (onProgress) onProgress({ ...progress });
  };
  emitProgress();

  try {
    const turnOptions = { signal: controller.signal };
    if (verdictPrep.outputSchema && typeof verdictPrep.outputSchema === "object") {
      turnOptions.outputSchema = verdictPrep.outputSchema;
    }

    const inputImages = resolveInputImages(args.images, cwd);
    const turnInput =
      inputImages.length > 0
        ? [
            { type: "text", text: verdictPrep.prompt },
            ...inputImages.map((imgPath) => ({ type: "local_image", path: imgPath })),
          ]
        : verdictPrep.prompt;

    const { events } = await thread.runStreamed(turnInput, turnOptions);
    const items = [];
    let finalResponse = "";
    let usage = null;
    let turnFailure = null;

    for await (const event of events) {
      if (event.type === "thread.started") {
        progress.threadId = event.thread_id;
        progress.stage = "running";
        progress.lastActivity = "Thread started";
        emitProgress();
      } else if (event.type === "turn.started") {
        progress.stage = "reasoning";
        progress.lastActivity = "Turn started";
        emitProgress();
      } else if (event.type === "item.started") {
        const item = event.item;
        if (item?.type === "command_execution") {
          progress.lastActivity = `Running command: ${truncate(item.command || "", 120)}`;
          emitProgress();
        } else if (item?.type === "web_search") {
          progress.lastActivity = `Web search: ${truncate(item.query || "", 120)}`;
          emitProgress();
        }
      } else if (event.type === "item.completed") {
        const item = event.item;
        if (item) items.push(item);
        if (item?.type === "agent_message" && typeof item.text === "string") {
          finalResponse = item.text;
          progress.lastActivity = `Message generated (${finalResponse.length} chars)`;
        } else if (item?.type === "reasoning") {
          progress.reasoningSteps += 1;
          progress.lastActivity = `Reasoning step #${progress.reasoningSteps}`;
        } else if (item?.type === "command_execution") {
          progress.commandsRun += 1;
          progress.lastActivity = `Command #${progress.commandsRun} exited (${item.exit_code ?? "?"})`;
        } else if (item?.type === "file_change") {
          progress.filesChanged += Array.isArray(item.changes) ? item.changes.length : 1;
          progress.lastActivity = `Updated ${progress.filesChanged} file(s)`;
        }
        emitProgress();
      } else if (event.type === "turn.completed") {
        usage = event.usage || null;
        progress.stage = "completed";
        progress.lastActivity = "Turn completed";
        emitProgress();
      } else if (event.type === "turn.failed") {
        turnFailure = event.error?.message || "Codex turn failed";
        break;
      } else if (event.type === "error") {
        turnFailure = event.message || "Codex stream error";
        break;
      }
    }

    if (externallyAborted) {
      throw createAbortError("Job cancelled");
    }
    if (timedOut) {
      throw new Error(
        `Codex timed out after ${timeoutMs}ms${isAsync ? "" : " (use async: true for long-running reasoning tasks)"}`
      );
    }
    if (turnFailure) {
      throw new Error(turnFailure);
    }

    const fileChanges = [];
    const commands = [];
    const errors = [];

    for (const item of items) {
      if (item.type === "file_change") {
        fileChanges.push({ status: item.status, changes: item.changes });
      } else if (item.type === "command_execution") {
        commands.push({
          command: item.command,
          status: item.status,
          exitCode: item.exit_code ?? null,
        });
      } else if (item.type === "error") {
        errors.push(item.message);
      }
    }

    const spilled = spillLargeOutput(finalResponse, {
      jobsDir: JOBS_DIR,
      prefix: "codex-run",
      inlineLimit: args.maxResponseChars || DEFAULT_INLINE_LIMIT,
    });

    const payload = {
      backend: "codex-sdk",
      threadId: thread.id || progress.threadId,
      cwd,
      sandboxMode,
      model: args.model ? String(args.model) : undefined,
      verdictMode: verdictPrep.active || undefined,
      finalResponse: spilled.text,
      ...(spilled.truncated
        ? {
            outputTruncated: true,
            outputTotalChars: spilled.totalChars,
            outputFile: spilled.outputFile,
          }
        : {}),
      fileChanges,
      commands,
      errors,
      usage,
    };

    if (verdictPrep.active) {
      const parsed = parseVerdictResponse(finalResponse);
      if (parsed.ok) {
        payload.parsedVerdict = parsed.verdict;
      } else {
        payload.verdictParseWarning = parsed.warning;
      }
    }

    if (beforeSnapshot) {
      payload.scopeAudit = auditScopeAfterRun(cwd, beforeSnapshot, scopeConfig);
    }

    return payload;
  } catch (err) {
    if (externallyAborted) throw createAbortError("Job cancelled");
    if (timedOut) {
      throw new Error(
        `Codex timed out after ${timeoutMs}ms${isAsync ? "" : " (use async: true for long-running reasoning tasks)"}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

function runProcess(
  bin,
  procArgs,
  { cwd, stdinText, timeoutMs = DEFAULT_SYNC_TIMEOUT_MS, signal, onProgress } = {}
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError("Job cancelled"));
      return;
    }

    const child = spawn(bin, procArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let lastEmit = 0;

    const killChild = () => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, 3000);
    };

    const onAbort = () => {
      cancelled = true;
      killChild();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    const maybeEmit = () => {
      if (!onProgress) return;
      const now = Date.now();
      if (now - lastEmit < 1000) return;
      lastEmit = now;
      const lines = (stdout || stderr).trim().split("\n");
      onProgress({
        stage: "running",
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        lastLine: truncate(lines[lines.length - 1] || "", 160),
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      maybeEmit();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      maybeEmit();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (cancelled) {
        reject(createAbortError("Job cancelled"));
        return;
      }
      resolve({ code, signal: sig, timedOut, stdout, stderr });
    });

    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

async function runCodexReview(args, { signal, onProgress, isAsync = false } = {}) {
  const cwd = resolveCwd(args?.cwd);
  const timeoutMs = resolveTimeoutMs(args, isAsync);

  const cliArgs = ["review"];
  if (args?.model) {
    cliArgs.push("-c", `model=${JSON.stringify(String(args.model))}`);
  }
  if (args?.reasoningEffort) {
    cliArgs.push("-c", `model_reasoning_effort=${JSON.stringify(String(args.reasoningEffort))}`);
  }
  if (args?.base) {
    cliArgs.push("--base", String(args.base));
  } else if (args?.commit) {
    cliArgs.push("--commit", String(args.commit));
  } else if (args?.uncommitted !== false) {
    cliArgs.push("--uncommitted");
  }

  if (args?.title) {
    cliArgs.push("--title", String(args.title));
  }

  let stdinText;
  if (args?.prompt && typeof args.prompt === "string" && args.prompt.trim()) {
    cliArgs.push("-");
    stdinText = args.prompt;
  }

  if (onProgress) {
    onProgress({ stage: "starting", args: cliArgs, lastActivity: "Starting codex review" });
  }

  const res = await runProcess(CODEX_BIN, cliArgs, {
    cwd,
    stdinText,
    timeoutMs,
    signal,
    onProgress,
  });
  if (res.timedOut) {
    throw new Error(
      `codex review timed out after ${timeoutMs}ms${isAsync ? "" : " (use async: true for long reviews)"}`
    );
  }

  const combined = (res.stdout || "").trim() || (res.stderr || "").trim();
  if (res.code !== 0) {
    throw new Error(
      `codex review exited with code ${res.code}: ${truncate(res.stderr || res.stdout || "", 8000)}`
    );
  }

  const spilled = spillLargeOutput(combined, {
    jobsDir: JOBS_DIR,
    prefix: "codex-review",
    inlineLimit: args?.maxResponseChars || DEFAULT_INLINE_LIMIT,
  });

  return {
    backend: "codex-review",
    cwd,
    model: args?.model ? String(args.model) : undefined,
    args: cliArgs,
    review: spilled.text,
    ...(spilled.truncated
      ? {
          outputTruncated: true,
          outputTotalChars: spilled.totalChars,
          outputFile: spilled.outputFile,
        }
      : {}),
    stderr: res.stderr && res.stdout ? truncate(res.stderr, 4000) : undefined,
  };
}

// ---------------------------------------------------------------------------
// 2. DeepSeek Harness ACP Pool (`dsh --profile acp`)
// ---------------------------------------------------------------------------

const dshPool = new DshAcpPool({
  dshBin: DSH_BIN,
  maxConcurrency: DSH_MAX_CONCURRENCY,
  defaultSyncTimeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
  resolveCwd,
  resolveTimeoutMs,
  truncate,
  log,
});

function validateDshArgs(args) {
  if (!args?.prompt || typeof args.prompt !== "string") {
    throw new Error("`prompt` (string) is required.");
  }
  resolveCwd(args.cwd);
  return prepareVerdictArgs("dsh", args);
}

async function runDsh(args, hooks = {}) {
  const verdictPrep = validateDshArgs(args);
  const cwd = resolveCwd(args.cwd);
  const permissionPolicy = verdictPrep.active
    ? verdictPrep.permissionPolicy
    : args.permissionPolicy === "allow_all"
      ? "allow_all"
      : "read_only";
  const scopeConfig = resolveScopeConfig(args);
  const shouldAuditScope = permissionPolicy === "allow_all" || scopeConfig.hasExplicitScope;
  const beforeSnapshot = shouldAuditScope ? captureGitSnapshot(cwd) : null;

  const effectiveArgs = {
    ...args,
    cwd,
    prompt: verdictPrep.prompt,
    permissionPolicy,
  };

  const payload = await dshPool.runPrompt(effectiveArgs, {
    ...hooks,
    scopeConfig,
  });

  const rawResponse = payload.response;
  if (verdictPrep.active) {
    payload.verdictMode = true;
    const parsed = parseVerdictResponse(rawResponse);
    if (parsed.ok) {
      payload.parsedVerdict = parsed.verdict;
    } else {
      payload.verdictParseWarning = parsed.warning;
    }
  }

  const spilled = spillLargeOutput(rawResponse, {
    jobsDir: JOBS_DIR,
    prefix: "dsh-run",
    inlineLimit: args.maxResponseChars || DEFAULT_INLINE_LIMIT,
  });
  payload.response = spilled.text;
  if (spilled.truncated) {
    payload.outputTruncated = true;
    payload.outputTotalChars = spilled.totalChars;
    payload.outputFile = spilled.outputFile;
  }

  if (beforeSnapshot) {
    payload.scopeAudit = auditScopeAfterRun(cwd, beforeSnapshot, scopeConfig);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// 3. Async Job Manager (Immune to 3-minute MCP call ceiling, durable on disk)
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

class JobManager {
  constructor(jobsDir) {
    this.jobsDir = jobsDir;
    this.jobs = new Map(); // jobId -> runtime record
    this.dirReady = false;
  }

  ensureDir() {
    if (this.dirReady) return true;
    try {
      fs.mkdirSync(this.jobsDir, { recursive: true });
      this.dirReady = true;
      return true;
    } catch (err) {
      log(`Could not create jobs dir (${this.jobsDir}): ${err.message}`);
      return false;
    }
  }

  jobPath(jobId) {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  serializeJob(job) {
    return {
      jobId: job.jobId,
      tool: job.tool,
      pid: process.pid,
      status: job.status,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      timeoutMs: job.timeoutMs,
      meta: job.meta,
      progress: job.progress,
      result: job.result,
      error: job.error,
      errorInfo: job.errorInfo || null,
    };
  }

  persist(job) {
    if (!this.ensureDir()) return;
    const target = this.jobPath(job.jobId);
    const tmp = `${target}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.serializeJob(job), null, 2), "utf8");
      fs.renameSync(tmp, target);
    } catch (err) {
      log(`Failed to persist job ${job.jobId}: ${err.message}`);
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }

  pruneOldJobs() {
    if (this.jobs.size > MAX_PERSISTED_JOBS) {
      const sorted = Array.from(this.jobs.values())
        .filter((j) => TERMINAL_STATES.has(j.status))
        .sort((a, b) => (a.finishedAt || a.startedAt) - (b.finishedAt || b.startedAt));
      while (this.jobs.size > MAX_PERSISTED_JOBS && sorted.length > 0) {
        const old = sorted.shift();
        this.jobs.delete(old.jobId);
      }
    }

    if (!this.ensureDir()) return;
    try {
      const files = fs
        .readdirSync(this.jobsDir)
        .filter((f) => f.startsWith("job-") && f.endsWith(".json"))
        .map((f) => {
          const full = path.join(this.jobsDir, f);
          const stat = fs.statSync(full);
          return { full, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const stale of files.slice(MAX_PERSISTED_JOBS)) {
        try {
          fs.unlinkSync(stale.full);
        } catch {}
      }
    } catch {}
  }

  loadFromDisk(jobId) {
    if (!/^job-[a-z0-9-]+$/i.test(jobId)) return null;
    const target = this.jobPath(jobId);
    if (!fs.existsSync(target)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(target, "utf8"));
      if (data.status === "running" && data.pid !== process.pid) {
        data.status = "failed";
        data.finishedAt = data.finishedAt || Date.now();
        data.error = "MCP server restarted before this background job completed.";
      }
      return data;
    } catch {
      return null;
    }
  }

  notifyWaiters(job) {
    if (!job.waiters || job.waiters.length === 0) return;
    const waiters = job.waiters.splice(0, job.waiters.length);
    for (const resolve of waiters) {
      try {
        resolve();
      } catch {}
    }
  }

  broadcastProgress(job, snapshot) {
    if (!job.progressSubscribers || job.progressSubscribers.size === 0) return;
    for (const listener of job.progressSubscribers) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  start(tool, args, runnerFn) {
    const jobId = `job-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
    const timeoutMs = resolveTimeoutMs(args, true);
    const controller = new AbortController();
    const now = Date.now();

    const job = {
      jobId,
      tool,
      status: "running",
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      timeoutMs,
      meta: {
        cwd: args?.cwd || process.cwd(),
        model: args?.model || null,
        provider: args?.provider || null,
        reasoningEffort: args?.reasoningEffort || null,
        verdictMode: Boolean(args?.verdictMode),
        promptPreview: typeof args?.prompt === "string" ? truncate(args.prompt, 160) : null,
      },
      progress: { stage: "starting" },
      result: null,
      error: null,
      errorInfo: null,
      controller,
      waiters: [],
      progressSubscribers: new Set(),
      lastPersistMs: 0,
    };

    this.jobs.set(jobId, job);
    this.persist(job);

    const onProgress = (snapshot) => {
      if (TERMINAL_STATES.has(job.status)) return;
      job.progress = snapshot;
      job.updatedAt = Date.now();
      this.broadcastProgress(job, snapshot);
      if (job.updatedAt - job.lastPersistMs >= 5000) {
        job.lastPersistMs = job.updatedAt;
        this.persist(job);
      }
    };

    Promise.resolve()
      .then(() => runnerFn({ signal: controller.signal, onProgress, isAsync: true }))
      .then((res) => {
        if (job.status === "cancelled") return;
        job.status = "completed";
        job.result = res;
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
        job.progress = { ...(job.progress || {}), stage: "completed" };
        telemetry.recordCall({
          tool,
          args,
          ok: true,
          durationMs: job.finishedAt - job.startedAt,
          usage: res?.usage || null,
          result: res,
        });
        this.broadcastProgress(job, job.progress);
        this.persist(job);
        this.notifyWaiters(job);
        this.pruneOldJobs();
      })
      .catch((err) => {
        if (job.status === "cancelled" || err?.name === "AbortError") {
          job.status = "cancelled";
          job.error = job.error || "Job cancelled";
          job.errorInfo = classifyBackendError(err, tool);
        } else {
          job.status = "failed";
          job.error = err?.message || String(err);
          job.errorInfo = classifyBackendError(err, tool);
          telemetry.recordCall({
            tool,
            args,
            ok: false,
            durationMs: Date.now() - job.startedAt,
            errorInfo: job.errorInfo,
          });
        }
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
        this.broadcastProgress(job, { ...(job.progress || {}), stage: job.status });
        this.persist(job);
        this.notifyWaiters(job);
        this.pruneOldJobs();
      });

    return {
      jobId,
      tool,
      status: "running",
      startedAt: new Date(now).toISOString(),
      timeoutMs,
      waitCommand: `node ${JSON.stringify(WAIT_JOB_SCRIPT)} ${jobId}`,
      hint: "For zero-token reactive wakeup, launch `waitCommand` via background run_command (WaitMsBeforeAsync: 500, NotificationTimeoutSeconds: 600); or poll with job_status(jobId, waitSeconds). Cancel anytime with job_cancel(jobId).",
    };
  }

  formatView(data, includeResult = true) {
    const end = data.finishedAt || Date.now();
    const out = {
      jobId: data.jobId,
      tool: data.tool,
      status: data.status,
      elapsedMs: Math.max(0, end - data.startedAt),
      startedAt: new Date(data.startedAt).toISOString(),
      updatedAt: new Date(data.updatedAt || data.startedAt).toISOString(),
      finishedAt: data.finishedAt ? new Date(data.finishedAt).toISOString() : null,
      meta: data.meta,
      progress: data.progress,
    };
    if (includeResult) {
      if (data.status === "completed") out.result = data.result;
      if (data.error) out.error = data.error;
      if (data.errorInfo) out.errorInfo = data.errorInfo;
    } else if (data.error) {
      out.error = truncate(data.error, 300);
      if (data.errorInfo?.errorKind) out.errorKind = data.errorInfo.errorKind;
    }
    return out;
  }

  async getStatus(jobId, waitSeconds = 0, { onProgress = null } = {}) {
    if (!jobId || typeof jobId !== "string") {
      throw new Error("`jobId` (string) is required.");
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      const disk = this.loadFromDisk(jobId);
      if (!disk) {
        throw new Error(`Unknown jobId: ${jobId}`);
      }
      return this.formatView(disk, true);
    }

    const clampedWait = Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS);
    if (!TERMINAL_STATES.has(job.status) && clampedWait > 0) {
      if (onProgress && job.progress) {
        onProgress(job.progress);
      }
      if (onProgress) {
        job.progressSubscribers.add(onProgress);
      }
      try {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            const idx = job.waiters.indexOf(onDone);
            if (idx !== -1) job.waiters.splice(idx, 1);
            resolve();
          }, clampedWait * 1000);
          const onDone = () => {
            clearTimeout(timer);
            resolve();
          };
          job.waiters.push(onDone);
        });
      } finally {
        if (onProgress) {
          job.progressSubscribers.delete(onProgress);
        }
      }
    }

    return this.formatView(job, true);
  }

  cancel(jobId) {
    if (!jobId || typeof jobId !== "string") {
      throw new Error("`jobId` (string) is required.");
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      const disk = this.loadFromDisk(jobId);
      if (!disk) throw new Error(`Unknown jobId: ${jobId}`);
      return {
        jobId,
        cancelled: false,
        status: disk.status,
        reason: "Job is already finished or from a previous session.",
      };
    }
    if (TERMINAL_STATES.has(job.status)) {
      return {
        jobId,
        cancelled: false,
        status: job.status,
        reason: `Job is already ${job.status}.`,
      };
    }
    job.status = "cancelled";
    job.error = "Cancelled by orchestrator";
    job.finishedAt = Date.now();
    job.updatedAt = job.finishedAt;
    try {
      job.controller.abort(createAbortError("Cancelled by orchestrator"));
    } catch {}
    this.persist(job);
    this.notifyWaiters(job);
    return { jobId, cancelled: true, status: "cancelled" };
  }

  list({ status, limit = 20 } = {}) {
    const merged = new Map();
    if (this.ensureDir()) {
      try {
        for (const f of fs.readdirSync(this.jobsDir)) {
          if (!f.startsWith("job-") || !f.endsWith(".json")) continue;
          const id = f.slice(0, -5);
          const disk = this.loadFromDisk(id);
          if (disk) merged.set(id, disk);
        }
      } catch {}
    }
    for (const [id, job] of this.jobs.entries()) {
      merged.set(id, job);
    }

    let items = Array.from(merged.values());
    if (status && typeof status === "string") {
      items = items.filter((j) => j.status === status);
    }
    items.sort((a, b) => {
      const aRun = a.status === "running" ? 1 : 0;
      const bRun = b.status === "running" ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    const max = Math.min(Math.max(Number(limit) || 20, 1), 50);
    return {
      jobs: items.slice(0, max).map((j) => this.formatView(j, false)),
      total: items.length,
    };
  }

  cancelAll() {
    for (const job of this.jobs.values()) {
      if (!TERMINAL_STATES.has(job.status)) {
        try {
          job.controller.abort(createAbortError("Server shutting down"));
        } catch {}
      }
    }
  }
}

const jobManager = new JobManager(JOBS_DIR);

async function checkStatus() {
  const result = {
    version: SERVER_VERSION,
    codex: {
      bin: CODEX_BIN,
      exists: fs.existsSync(CODEX_BIN),
      version: null,
      sdkLoaded: typeof Codex === "function",
    },
    dsh: {
      bin: DSH_BIN,
      exists: fs.existsSync(DSH_BIN),
      acpHandshake: null,
      pool: dshPool.getPoolStats(),
    },
    jobs: {
      dir: JOBS_DIR,
      waitScript: WAIT_JOB_SCRIPT,
      running: Array.from(jobManager.jobs.values()).filter((j) => j.status === "running").length,
      syncDefaultTimeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
      asyncDefaultTimeoutMs: DEFAULT_ASYNC_TIMEOUT_MS,
      defaultInlineOutputLimit: DEFAULT_INLINE_LIMIT,
    },
    telemetry: telemetry.getSummary(),
  };

  if (result.codex.exists) {
    try {
      const ver = await runProcess(CODEX_BIN, ["--version"], { timeoutMs: 10_000 });
      result.codex.version = (ver.stdout || ver.stderr).trim();
    } catch (err) {
      result.codex.error = err.message;
    }
  }

  if (result.dsh.exists) {
    try {
      const init = await dshPool.ensurePrimaryHandshake();
      result.dsh.acpHandshake = {
        ok: true,
        protocolVersion: init?.protocolVersion ?? null,
        agentInfo: init?.agentInfo ?? null,
        sessionCapabilities: init?.agentCapabilities?.sessionCapabilities ?? null,
      };
      result.dsh.pool = dshPool.getPoolStats();
    } catch (err) {
      result.dsh.acpHandshake = { ok: false, error: err.message };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 4. MCP Tool Definitions & JSON-RPC 2.0 Stdio Server (with Progress Notices)
// ---------------------------------------------------------------------------

const SCOPE_PROPERTIES = {
  allowedPaths: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional repo/cwd-relative allowed path prefixes or globs (e.g. ['src/api/', 'tests/']). Violations are audited via git diff and blocked in DSH ACP.",
  },
  forbiddenPaths: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional forbidden path prefixes or globs (e.g. ['lib/billing/']). Sensitive files (.env*, .git/) are protected by default.",
  },
  allowSensitiveFiles: {
    type: "boolean",
    description:
      "If true, disables the default .env*/.git/ protection in scopeAudit (default false).",
  },
};

const TOOLS = [
  {
    name: "orchestrator_status",
    description:
      "Check health and connectivity of local Codex CLI, DeepSeek Harness ACP pool, and background async job stats.",
    inputSchema: {
      type: "object",
      properties: {
        includePoolDetails: {
          type: "boolean",
          description: "Include detailed DSH ACP pool stats (default true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "codex_run",
    description:
      "Run a task or follow-up turn on local Codex CLI via @openai/codex-sdk. Defaults to read-only sandbox; set sandboxMode='workspace-write' only when delegating code edits. Set verdictMode=true for strict fresh-context read-only verification with structured JSON Verdict output. Supports allowedPaths/forbiddenPaths scope auditing and async=true (30+ min background jobs).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Clear task or review instructions for Codex." },
        cwd: { type: "string", description: "Absolute working directory path (defaults to current workspace)." },
        threadId: { type: "string", description: "Optional Codex threadId from a previous call to continue the same conversation (forbidden when verdictMode=true)." },
        sandboxMode: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Sandbox policy. Default: 'read-only'.",
        },
        model: { type: "string", description: "Optional model slug override (e.g. 'gpt-6.2-sol', 'gpt-6.2-astra')." },
        reasoningEffort: {
          type: "string",
          enum: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Optional reasoning effort level.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional local image file paths (absolute or cwd-relative) to attach for visual inspection or ChatGPT built-in image_gen editing/reference.",
        },
        verdictMode: {
          type: "boolean",
          description:
            "If true, enforces read-only sandbox + fresh thread (no threadId) + structured Verdict JSON outputSchema with path/line/command evidence.",
        },
        outputSchema: {
          type: "object",
          description: "Optional JSON Schema to constrain Codex's finalResponse into structured JSON.",
        },
        ...SCOPE_PROPERTIES,
        async: {
          type: "boolean",
          description: "If true, launch in background and immediately return a jobId (default 30 min timeout). Poll via job_status.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default 150000 for sync, 1800000 for async).",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "codex_review",
    description:
      "Run OpenAI Codex's native non-interactive read-only code review (`codex review`) on uncommitted changes, a base branch diff, or a specific commit. Set async=true for deep/large reviews.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Absolute git repository working directory." },
        uncommitted: {
          type: "boolean",
          description: "Review staged, unstaged, and untracked changes (default true if base and commit are omitted).",
        },
        base: { type: "string", description: "Review changes against this base branch (e.g. 'main')." },
        commit: { type: "string", description: "Review changes introduced by a specific commit SHA." },
        title: { type: "string", description: "Optional title for the review summary." },
        model: { type: "string", description: "Optional Codex model slug override (e.g. 'gpt-6.2-sol', 'gpt-6.2-astra')." },
        reasoningEffort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
          description: "Optional reasoning effort level for the review.",
        },
        prompt: { type: "string", description: "Optional custom review focus / instructions." },
        async: {
          type: "boolean",
          description: "If true, launch in background and immediately return a jobId (default 30 min timeout). Poll via job_status.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default 150000 for sync, 1800000 for async).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_run",
    description:
      "Send a prompt to local DeepSeek Harness via a pooled ACP server (`dsh --profile acp`, up to 3 concurrent workers with sessionId affinity). Defaults to permissionPolicy='read_only'; set 'allow_all' only when delegating edits. Supports verdictMode=true (fresh read-only JSON verdict), allowedPaths/forbiddenPaths scope enforcement, and async=true.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task or review prompt for DeepSeek Harness." },
        cwd: { type: "string", description: "Absolute working directory path." },
        sessionId: { type: "string", description: "Optional ACP sessionId to continue an existing conversation (forbidden when verdictMode=true)." },
        permissionPolicy: {
          type: "string",
          enum: ["read_only", "allow_all"],
          description: "Tool permission policy during this turn. Default: 'read_only'.",
        },
        provider: {
          type: "string",
          description: "Optional DSH model provider override (e.g. 'magpie', 'magpie-responses', 'deepseek-official').",
        },
        model: {
          type: "string",
          description: "Optional DSH model id override (e.g. 'auto/deepseek-v4.1-flash').",
        },
        reasoningEffort: {
          type: "string",
          enum: ["off", "low", "high", "max"],
          description: "Optional DeepSeek reasoning_effort ACP config option.",
        },
        verdictMode: {
          type: "boolean",
          description:
            "If true, enforces read_only permission + fresh session (no sessionId) + structured Verdict JSON response parsing.",
        },
        ...SCOPE_PROPERTIES,
        async: {
          type: "boolean",
          description: "If true, launch in background and immediately return a jobId (default 30 min timeout). Poll via job_status.",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds (default 150000 for sync, 1800000 for async).",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_close",
    description: "Close an existing DeepSeek Harness ACP session when done.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "ACP sessionId to close." },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "worktree_create",
    description:
      "Create an isolated git worktree and branch for parallel multi-agent edits. Optionally copies local environment files and symlinks dependency directories.",
    inputSchema: {
      type: "object",
      properties: {
        repoCwd: { type: "string", description: "Absolute path inside the main git repository." },
        name: { type: "string", description: "Short descriptive track name, for example api-validation or ui-refactor." },
        baseRef: { type: "string", description: "Git ref to branch from (default HEAD)." },
        copyEnv: { type: "boolean", description: "Copy non-template environment files from main repo root (default true)." },
        symlinkDirs: {
          type: "array",
          items: { type: "string" },
          description: "Optional repo-relative directory names to symlink into the worktree.",
        },
      },
      required: ["repoCwd", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "worktree_list",
    description:
      "List all git worktrees for a repository along with branch names, plugin management status, and dirty file counts.",
    inputSchema: {
      type: "object",
      properties: {
        repoCwd: { type: "string", description: "Absolute path inside the git repository." },
      },
      required: ["repoCwd"],
      additionalProperties: false,
    },
  },
  {
    name: "worktree_cleanup",
    description:
      "Safely remove a git worktree created for isolated edits. Refuses the main repository and dirty worktrees unless force is true, and can optionally delete the orchestrator branch.",
    inputSchema: {
      type: "object",
      properties: {
        repoCwd: { type: "string", description: "Absolute path inside the main git repository." },
        worktreePath: { type: "string", description: "Absolute path of the worktree to remove." },
        deleteBranch: { type: "boolean", description: "Also delete the worktree orchestrator branch (default false)." },
        force: { type: "boolean", description: "Force removal even if the worktree has uncommitted changes (default false)." },
      },
      required: ["repoCwd", "worktreePath"],
      additionalProperties: false,
    },
  },
  {
    name: "job_status",
    description:
      "Check live progress or retrieve the final result of a background async job started with codex_run/codex_review/dsh_run (async=true). Optionally long-poll up to 120 seconds via waitSeconds (wakes up immediately on completion and forwards MCP progress notifications).",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID returned by an async tool call." },
        waitSeconds: {
          type: "number",
          description: "Optional seconds to wait for completion before returning current progress (0 to 120, default 0).",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "job_cancel",
    description: "Cancel a running or queued background job cleanly (aborts Codex CLI or sends ACP session/cancel to DSH).",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID to cancel." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "job_list",
    description: "List running and recent background async jobs (summary without full output payloads).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "cancelled"],
          description: "Optional status filter.",
        },
        limit: {
          type: "number",
          description: "Maximum number of jobs to return (1 to 50, default 20).",
        },
      },
      additionalProperties: false,
    },
  },
];

function writeMcpMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  writeMcpMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMcpMessage({ jsonrpc: "2.0", id, error });
}

function formatProgressMessage(toolName, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return `[${toolName}] working`;
  const parts = [`[${toolName}]`, snapshot.stage || "running"];
  if (snapshot.workerId) parts.push(`(${snapshot.workerId})`);
  if (snapshot.lastActivity) parts.push(snapshot.lastActivity);
  else if (snapshot.latestTool) parts.push(`tool: ${snapshot.latestTool}`);
  else if (snapshot.lastLine) parts.push(snapshot.lastLine);
  if (typeof snapshot.reasoningSteps === "number" && snapshot.reasoningSteps > 0) {
    parts.push(`reasoning=${snapshot.reasoningSteps}`);
  }
  if (typeof snapshot.commandsRun === "number" && snapshot.commandsRun > 0) {
    parts.push(`cmds=${snapshot.commandsRun}`);
  }
  if (typeof snapshot.filesChanged === "number" && snapshot.filesChanged > 0) {
    parts.push(`files=${snapshot.filesChanged}`);
  }
  if (typeof snapshot.responseChars === "number" && snapshot.responseChars > 0) {
    parts.push(`chars=${snapshot.responseChars}`);
  }
  return parts.join(" | ").slice(0, 240);
}

function createMcpProgressForwarder(toolName, progressToken) {
  if (progressToken === undefined || progressToken === null) return null;
  let seq = 0;
  let lastSentAt = 0;
  let lastStage = null;

  return (snapshot) => {
    const now = Date.now();
    const stage = snapshot?.stage || null;
    const stageChanged = stage !== lastStage;
    if (!stageChanged && now - lastSentAt < 1000) return;
    lastSentAt = now;
    lastStage = stage;
    seq += 1;
    try {
      writeMcpMessage({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken,
          progress: seq,
          message: formatProgressMessage(toolName, snapshot),
        },
      });
    } catch {}
  };
}

async function handleMcpRequest(msg) {
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "codex-dsh-orchestrator",
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const name = params?.name;
      const toolArgs = params?.arguments || {};
      const progressToken = params?._meta?.progressToken;
      const onProgress = createMcpProgressForwarder(name || "tool", progressToken);
      let payload;

      if (name === "orchestrator_status") {
        payload = await checkStatus();
      } else if (name === "codex_run") {
        validateCodexArgs(toolArgs);
        if (toolArgs.async === true) {
          payload = jobManager.start("codex_run", toolArgs, (hooks) => runCodex(toolArgs, hooks));
        } else {
          const t0 = Date.now();
          try {
            payload = await runCodex(toolArgs, { onProgress });
            telemetry.recordCall({
              tool: name,
              args: toolArgs,
              ok: true,
              durationMs: Date.now() - t0,
              usage: payload?.usage || null,
              result: payload,
            });
          } catch (err) {
            telemetry.recordCall({
              tool: name,
              args: toolArgs,
              ok: false,
              durationMs: Date.now() - t0,
              errorInfo: classifyBackendError(err, name),
            });
            throw err;
          }
        }
      } else if (name === "codex_review") {
        resolveCwd(toolArgs?.cwd);
        if (toolArgs.async === true) {
          payload = jobManager.start("codex_review", toolArgs, (hooks) =>
            runCodexReview(toolArgs, hooks)
          );
        } else {
          const t0 = Date.now();
          try {
            payload = await runCodexReview(toolArgs, { onProgress });
            telemetry.recordCall({
              tool: name,
              args: toolArgs,
              ok: true,
              durationMs: Date.now() - t0,
              result: payload,
            });
          } catch (err) {
            telemetry.recordCall({
              tool: name,
              args: toolArgs,
              ok: false,
              durationMs: Date.now() - t0,
              errorInfo: classifyBackendError(err, name),
            });
            throw err;
          }
        }
      } else if (name === "dsh_run") {
        validateDshArgs(toolArgs);
        if (toolArgs.async === true) {
          payload = jobManager.start("dsh_run", toolArgs, (hooks) => runDsh(toolArgs, hooks));
        } else {
          const t0 = Date.now();
          try {
            payload = await runDsh(toolArgs, { onProgress });
            telemetry.recordCall({
              tool: name,
              args: toolArgs,
              ok: true,
              durationMs: Date.now() - t0,
              result: payload,
            });
          } catch (err) {
            telemetry.recordCall({
              tool: name,
              args: toolArgs,
              ok: false,
              durationMs: Date.now() - t0,
              errorInfo: classifyBackendError(err, name),
            });
            throw err;
          }
        }
      } else if (name === "dsh_close") {
        payload = await dshPool.closeSession(toolArgs.sessionId);
      } else if (name === "worktree_create") {
        payload = worktreeCreate(toolArgs);
      } else if (name === "worktree_list") {
        payload = worktreeList(toolArgs);
      } else if (name === "worktree_cleanup") {
        payload = worktreeCleanup(toolArgs);
      } else if (name === "job_status") {
        payload = await jobManager.getStatus(toolArgs.jobId, toolArgs.waitSeconds, { onProgress });
      } else if (name === "job_cancel") {
        payload = jobManager.cancel(toolArgs.jobId);
      } else if (name === "job_list") {
        payload = jobManager.list(toolArgs);
      } else {
        sendError(id, -32601, `Unknown tool: ${name}`);
        return;
      }

      sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      });
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (method === "tools/call") {
      const errInfo = classifyBackendError(err, params?.name || "");
      sendResult(id, {
        content: [
          {
            type: "text",
            text: formatMcpErrorText(errInfo),
          },
        ],
        isError: true,
      });
    } else {
      sendError(id, -32603, err?.message || String(err));
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    log(`Invalid JSON on stdin: ${err.message}`);
    return;
  }
  void handleMcpRequest(msg);
});

function cleanup() {
  jobManager.cancelAll();
  dshPool.dispose();
  process.exit(0);
}

rl.on("close", cleanup);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
