#!/usr/bin/env node
/**
 * Event-driven zero-token waiter for async codex-dsh-orchestrator jobs.
 *
 * Watches `<JOBS_DIR>/<jobId>.json` via fs.watch (plus a low-frequency fallback
 * check and MCP server PID liveness guard) and exits immediately once the
 * target job(s) enter a terminal state (`completed` | `failed` | `cancelled`).
 *
 * Run via Antigravity `run_command` in background mode so Antigravity receives
 * an instant Reactive Wakeup notification upon job completion—no schedule timers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_JOBS_DIR =
  process.env.JOBS_DIR ||
  path.join(
    os.homedir(),
    ".gemini",
    "antigravity",
    "plugin_data",
    "codex-dsh-orchestrator",
    "jobs"
  );

function parseCliArgs(argv) {
  let mode = "all";
  let timeoutMs = 1_860_000; // 31 min safety ceiling (slightly above 30 min async default)
  let jobsDir = DEFAULT_JOBS_DIR;
  const jobIds = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--any") {
      mode = "any";
    } else if (a === "--all") {
      mode = "all";
    } else if (a === "--timeout-ms" && argv[i + 1]) {
      timeoutMs = Math.max(500, Number(argv[i + 1]) || timeoutMs);
      i += 1;
    } else if (a === "--jobs-dir" && argv[i + 1]) {
      jobsDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: node wait-job.mjs [--all|--any] [--timeout-ms <ms>] [--jobs-dir <dir>] <jobId...>\n"
      );
      process.exit(0);
    } else if (!a.startsWith("-")) {
      jobIds.push(a);
    }
  }

  return { mode, timeoutMs, jobsDir, jobIds };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readJobRecord(jobsDir, jobId) {
  if (!/^job-[a-z0-9-]+$/i.test(jobId)) {
    return {
      jobId,
      status: "failed",
      error: `Invalid jobId format: ${jobId}`,
      errorInfo: { errorKind: "invalid_job_id", retryable: false, reportBeforeFallback: false },
    };
  }
  const filePath = path.join(jobsDir, `${jobId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (data.status === "running" && data.pid && !isPidAlive(data.pid)) {
      return {
        ...data,
        status: "failed",
        error: `MCP orchestrator process (pid=${data.pid}) exited before job completed.`,
        errorInfo: {
          errorKind: "mcp_server_exited",
          backend: "orchestrator",
          retryable: false,
          reportBeforeFallback: true,
        },
      };
    }
    return data;
  } catch {
    return null;
  }
}

function summarizeJob(data) {
  const end = data.finishedAt || Date.now();
  const res = data.result || null;
  const summary = {
    jobId: data.jobId,
    tool: data.tool || null,
    status: data.status,
    elapsedMs: data.startedAt ? Math.max(0, end - data.startedAt) : null,
    taskId: data.meta?.taskId || undefined,
    model: data.meta?.model || res?.model || null,
    verdict: res?.parsedVerdict?.verdict || null,
    verdictConsistencyWarning: res?.verdictConsistencyWarning || undefined,
    changedFiles: Array.isArray(res?.scopeAudit?.changedFiles)
      ? res.scopeAudit.changedFiles.length
      : undefined,
    scopeViolations: Array.isArray(res?.scopeAudit?.violations)
      ? res.scopeAudit.violations.length
      : undefined,
    outputFile: res?.outputFile || undefined,
    taskSummary: res?.taskSummary || undefined,
    loopWarning: res?.loopWarning || data.errorInfo?.loopWarning || undefined,
    error: data.error || undefined,
    errorInfo: data.errorInfo || undefined,
  };
  return summary;
}

const { mode, timeoutMs, jobsDir, jobIds } = parseCliArgs(process.argv.slice(2));

if (jobIds.length === 0) {
  process.stderr.write("Error: at least one <jobId> is required.\n");
  process.exit(2);
}

fs.mkdirSync(jobsDir, { recursive: true });

let finished = false;
let watcher = null;
let pollTimer = null;
let deadlineTimer = null;
const startedAt = Date.now();

function done(payload, code = 0) {
  if (finished) return;
  finished = true;
  try {
    if (watcher) watcher.close();
  } catch {}
  if (pollTimer) clearInterval(pollTimer);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function evaluate() {
  if (finished) return;
  const records = new Map();
  let terminalCount = 0;
  let missingCount = 0;

  for (const id of jobIds) {
    const rec = readJobRecord(jobsDir, id);
    if (!rec) {
      missingCount += 1;
      continue;
    }
    records.set(id, rec);
    if (TERMINAL_STATES.has(rec.status)) {
      terminalCount += 1;
    }
  }

  // If jobs never appeared on disk after 10s, bail out instead of hanging forever
  if (missingCount === jobIds.length && Date.now() - startedAt > 10_000) {
    done(
      {
        event: "missing",
        mode,
        waitedMs: Date.now() - startedAt,
        missingJobIds: jobIds,
        hint: "Job file(s) not found in JOBS_DIR; verify jobId with job_list.",
      },
      1
    );
    return;
  }

  const ready = mode === "any" ? terminalCount >= 1 : terminalCount === jobIds.length;
  if (ready) {
    const jobs = jobIds.map((id) => {
      const rec = records.get(id);
      return rec ? summarizeJob(rec) : { jobId: id, status: "running" };
    });
    done({
      event: "completed",
      mode,
      waitedMs: Date.now() - startedAt,
      jobs,
      hint: "Fetch full output via job_status(jobId, waitSeconds: 0) or inspect outputFile via read_file.",
    });
  }
}

try {
  watcher = fs.watch(jobsDir, (_eventType, fileName) => {
    if (!fileName) {
      evaluate();
      return;
    }
    const base = String(fileName);
    if (jobIds.some((id) => base === `${id}.json` || base.startsWith(`${id}.json`))) {
      evaluate();
    }
  });
  watcher.on("error", () => {});
} catch {}

// Low-frequency fallback check (also catches MCP PID exit when no file event fires)
pollTimer = setInterval(evaluate, 1500);
deadlineTimer = setTimeout(() => {
  const jobs = jobIds.map((id) => {
    const rec = readJobRecord(jobsDir, id);
    return rec ? summarizeJob(rec) : { jobId: id, status: "unknown" };
  });
  done(
    {
      event: "wait_timeout",
      mode,
      waitedMs: Date.now() - startedAt,
      jobs,
      hint: "Wait ceiling reached while job(s) still running. Check job_status or cancel via job_cancel.",
    },
    0
  );
}, timeoutMs);

process.on("SIGINT", () => done({ event: "interrupted", waitedMs: Date.now() - startedAt }, 130));
process.on("SIGTERM", () => done({ event: "terminated", waitedMs: Date.now() - startedAt }, 143));

// Immediate check in case job already completed before watcher started
evaluate();
