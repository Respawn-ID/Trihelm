import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spillLargeOutput } from "../lib/output.mjs";
import { auditScopeAfterRun, captureGitSnapshot, resolveScopeConfig } from "../lib/scope.mjs";
import { TelemetryStore } from "../lib/telemetry.mjs";
import { worktreeCleanup, worktreeCreate, worktreeList } from "../lib/worktree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "../index.mjs");
const WAIT_JOB_ENTRY = path.resolve(__dirname, "../wait-job.mjs");
const EXPECTED_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
).version;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(prefix = "orch-v13-repo-") {
  const root = makeTempDir(prefix);
  const repoDir = path.join(root, "demo-repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "shared.js"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "a.js"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "b.js"), "export const b = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return { root, repoDir };
}

test("output.mjs spills oversized responses to disk while preserving head and tail", () => {
  const tmpDir = makeTempDir("orch-output-");
  try {
    const shortRes = spillLargeOutput("hello world", { jobsDir: tmpDir, inlineLimit: 2000 });
    assert.equal(shortRes.truncated, false);
    assert.equal(shortRes.outputFile, null);
    assert.equal(shortRes.text, "hello world");

    const huge = `HEAD_MARKER_${"A".repeat(4000)}_MID_${"B".repeat(4000)}_TAIL_MARKER`;
    const bigRes = spillLargeOutput(huge, {
      jobsDir: tmpDir,
      prefix: "dsh-test",
      inlineLimit: 1500,
    });
    assert.equal(bigRes.truncated, true);
    assert.equal(bigRes.totalChars, huge.length);
    assert.ok(bigRes.outputFile && fs.existsSync(bigRes.outputFile));
    assert.equal(fs.readFileSync(bigRes.outputFile, "utf8"), huge);
    assert.match(bigRes.text, /^HEAD_MARKER_/);
    assert.match(bigRes.text, /_TAIL_MARKER$/);
    assert.match(bigRes.text, /full output saved to/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("telemetry.mjs tracks per-model daily stats, token usage, and clears cooldown upon recovery", () => {
  const tmpDir = makeTempDir("orch-telemetry-");
  try {
    const store = new TelemetryStore(path.join(tmpDir, "metrics.json"));
    store.recordCall({
      tool: "codex_run",
      args: { model: "gpt-6.2-sol" },
      ok: true,
      durationMs: 1200,
      usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 250 },
    });
    store.recordCall({
      tool: "dsh_run",
      args: { model: "auto/deepseek-v4.1-flash" },
      ok: false,
      durationMs: 400,
      errorInfo: {
        errorKind: "quota_exhausted",
        backend: "dsh",
        reportBeforeFallback: true,
        message: "HTTP 429 quota exceeded",
      },
    });

    const mid = store.getSummary();
    assert.equal(mid.totalCallsToday, 2);
    assert.equal(mid.todayByModel["codex:gpt-6.2-sol"].inputTokens, 500);
    assert.equal(mid.todayByModel["codex:gpt-6.2-sol"].outputTokens, 250);
    assert.equal(mid.todayByModel["dsh:auto/deepseek-v4.1-flash"].quotaErrors, 1);
    assert.ok(mid.activeCooldowns["dsh:auto/deepseek-v4.1-flash"]);

    // Subsequent successful call clears active cooldown
    store.recordCall({
      tool: "dsh_run",
      args: { model: "auto/deepseek-v4.1-flash" },
      ok: true,
      durationMs: 800,
    });
    const after = store.getSummary();
    assert.equal(after.totalCallsToday, 3);
    assert.equal(after.activeCooldowns["dsh:auto/deepseek-v4.1-flash"], undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("scope.mjs diffStat reports added/deleted lines for tracked and untracked files", () => {
  const { root, repoDir } = initTempGitRepo();
  try {
    const scopeConfig = resolveScopeConfig({ allowedPaths: ["src/"] });
    const before = captureGitSnapshot(repoDir);

    fs.writeFileSync(path.join(repoDir, "src", "a.js"), "export const a = 2;\nexport const a2 = 3;\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "src", "new.js"), "line1\nline2\nline3\n", "utf8");

    const audit = auditScopeAfterRun(repoDir, before, scopeConfig);
    assert.equal(audit.violations.length, 0);
    assert.equal(audit.diffStat.totalAdded, 5);
    assert.equal(audit.diffStat.totalDeleted, 1);
    const byFile = Object.fromEntries(audit.diffStat.files.map((f) => [f.path, f]));
    assert.equal(byFile["src/a.js"].added, 2);
    assert.equal(byFile["src/a.js"].deleted, 1);
    assert.equal(byFile["src/new.js"].added, 3);
    assert.equal(byFile["src/new.js"].deleted, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree.mjs detects overlapping changed files across parallel worktrees", () => {
  const { root, repoDir } = initTempGitRepo();
  try {
    const wt1 = worktreeCreate({ repoCwd: repoDir, name: "track-a" });
    const wt2 = worktreeCreate({ repoCwd: repoDir, name: "track-b" });

    // Non-overlapping edits first -> no conflicts
    fs.writeFileSync(path.join(wt1.worktreePath, "src", "a.js"), "export const a = 10;\n", "utf8");
    fs.writeFileSync(path.join(wt2.worktreePath, "src", "b.js"), "export const b = 20;\n", "utf8");
    const cleanList = worktreeList({ repoCwd: repoDir });
    assert.equal(cleanList.potentialConflicts.length, 0);

    // Overlapping edit on src/shared.js (one committed, one uncommitted) -> flagged
    fs.writeFileSync(path.join(wt1.worktreePath, "src", "shared.js"), "export const x = 100;\n", "utf8");
    execFileSync("git", ["add", "src/shared.js"], { cwd: wt1.worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "edit shared"], { cwd: wt1.worktreePath });
    fs.writeFileSync(path.join(wt2.worktreePath, "src", "shared.js"), "export const x = 200;\n", "utf8");

    const conflictList = worktreeList({ repoCwd: repoDir });
    assert.equal(conflictList.potentialConflicts.length, 1);
    assert.equal(conflictList.potentialConflicts[0].file, "src/shared.js");
    assert.equal(conflictList.potentialConflicts[0].worktrees.length, 2);

    worktreeCleanup({ repoCwd: repoDir, worktreePath: wt1.worktreePath, deleteBranch: true, force: true });
    worktreeCleanup({ repoCwd: repoDir, worktreePath: wt2.worktreePath, deleteBranch: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wait-job.mjs wakes immediately on async MCP job completion, supports --any/--all, and MCP exposes telemetry & spilled output", async () => {
  const { root, repoDir } = initTempGitRepo("orch-v13-e2e-");
  const mockDshBin = path.join(root, "mock-dsh.sh");
  const jobsDir = path.join(root, "jobs");
  const metricsFile = path.join(root, "metrics.json");

  fs.writeFileSync(
    mockDshBin,
    `#!/bin/sh
exec "${process.execPath}" -e '
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "mock-v13" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-" + Date.now() + "-" + Math.random(), configOptions: [] } });
  else if (m.method === "session/set_config_option") send({ jsonrpc: "2.0", id: m.id, result: { configOptions: [{ id: m.params.configId, currentValue: m.params.value }] } });
  else if (m.method === "session/prompt") {
    const sid = m.params.sessionId;
    const text = (m.params.prompt && m.params.prompt[0] && m.params.prompt[0].text) || "";
    const delay = text.includes("SLOW") ? 600 : 180;
    const reply = text.includes("HUGE") ? ("START_" + "X".repeat(5000) + "_END") : ("OK:" + text);
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
      send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    }, delay);
  }
});
'
`,
    { mode: 0o755 }
  );

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DSH_BIN: mockDshBin,
      JOBS_DIR: jobsDir,
      METRICS_FILE: metricsFile,
      MAX_INLINE_RESPONSE_CHARS: "2000",
    },
  });

  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  let reqId = 1;
  function rpc(method, params) {
    const id = reqId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function runWaitJob(cliArgs) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [WAIT_JOB_ENTRY, ...cliArgs], {
        env: { ...process.env, JOBS_DIR: jobsDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d.toString()));
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
    assert.equal(init.result.serverInfo.version, EXPECTED_VERSION);

    // Start two concurrent async jobs: fast HUGE + slow normal
    const j1Res = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "HUGE_PAYLOAD", cwd: repoDir, async: true, model: "auto/deepseek-v4.1-flash" },
    });
    const j1 = JSON.parse(j1Res.result.content[0].text);
    assert.ok(j1.waitCommand && j1.waitCommand.includes("wait-job.mjs"));

    const j2Res = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "SLOW_TASK", cwd: repoDir, async: true, model: "auto/deepseek-v4.1-flash" },
    });
    const j2 = JSON.parse(j2Res.result.content[0].text);

    // --any wakes as soon as j1 finishes
    const anyWait = await runWaitJob(["--any", j1.jobId, j2.jobId]);
    assert.equal(anyWait.code, 0, anyWait.stderr);
    const anyOut = JSON.parse(anyWait.stdout);
    assert.equal(anyOut.event, "completed");
    assert.equal(anyOut.jobs.some((j) => j.status === "completed"), true);

    // --all waits for both to finish
    const allWait = await runWaitJob(["--all", j1.jobId, j2.jobId]);
    assert.equal(allWait.code, 0, allWait.stderr);
    const allOut = JSON.parse(allWait.stdout);
    assert.equal(allOut.event, "completed");
    assert.equal(allOut.jobs.every((j) => j.status === "completed"), true);

    // Verify spilled output file on j1
    const j1StatusRes = await rpc("tools/call", {
      name: "job_status",
      arguments: { jobId: j1.jobId, waitSeconds: 0 },
    });
    const j1Status = JSON.parse(j1StatusRes.result.content[0].text);
    assert.equal(j1Status.result.outputTruncated, true);
    assert.ok(j1Status.result.outputFile && fs.existsSync(j1Status.result.outputFile));
    assert.match(fs.readFileSync(j1Status.result.outputFile, "utf8"), /^START_X+_END$/);

    // Verify orchestrator_status exposes telemetry counts
    const statusRes = await rpc("tools/call", {
      name: "orchestrator_status",
      arguments: {},
    });
    const status = JSON.parse(statusRes.result.content[0].text);
    assert.equal(status.version, EXPECTED_VERSION);
    assert.equal(status.telemetry.totalCallsToday, 2);
    assert.equal(status.telemetry.todayByModel["dsh:auto/deepseek-v4.1-flash"].succeeded, 2);

    // Verify codex_run validates missing input image paths before dispatching
    const badImg = await rpc("tools/call", {
      name: "codex_run",
      arguments: { prompt: "edit image", cwd: repoDir, images: ["nonexistent-ref.png"] },
    });
    assert.equal(badImg.result.isError, true);
    assert.match(badImg.result.content[0].text, /Input image file does not exist/);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
