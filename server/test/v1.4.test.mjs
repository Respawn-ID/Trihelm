import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyBackendError } from "../lib/errors.mjs";
import { compactCodexItems, spillLargeOutput } from "../lib/output.mjs";
import { COOLDOWN_POLICY, TelemetryStore } from "../lib/telemetry.mjs";
import {
  supportsGitMergeTree,
  worktreeCleanup,
  worktreeCreate,
  worktreeList,
} from "../lib/worktree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "../index.mjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(prefix = "trihelm-v14-repo-") {
  const root = makeTempDir(prefix);
  const repoDir = path.join(root, "demo-repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "src", "multi.js"),
    [
      "export function top() {",
      "  return 1;",
      "}",
      "",
      "// spacer 1",
      "// spacer 2",
      "// spacer 3",
      "// spacer 4",
      "// spacer 5",
      "",
      "export function bottom() {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return { root, repoDir };
}

test("telemetry.mjs enforces per-kind cooldown TTLs, advisory auth errors, task rework, and loop detection", () => {
  const tmpDir = makeTempDir("trihelm-v14-telemetry-");
  try {
    const store = new TelemetryStore(path.join(tmpDir, "metrics.json"));
    const t0 = Date.UTC(2026, 10, 27, 8, 0, 0);

    // 1. rate_limited blocks for 3 min, expires after 3m+1s
    store.recordCall({
      tool: "codex_run",
      args: { model: "gpt-6.2-sol" },
      ok: false,
      now: t0,
      errorInfo: {
        errorKind: "rate_limited",
        backend: "codex",
        reportBeforeFallback: true,
        message: "HTTP 429 too many requests",
      },
    });
    assert.equal(store.checkCooldown("codex_run", { model: "gpt-6.2-sol" }, t0 + 60_000).blocked, true);
    assert.equal(
      store.checkCooldown(
        "codex_run",
        { model: "gpt-6.2-sol" },
        t0 + COOLDOWN_POLICY.rate_limited.ttlMs + 1000
      ).blocked,
      false
    );

    // 2. auth_error is advisory only (never hard-blocks dispatch after re-login)
    store.recordCall({
      tool: "codex_run",
      args: { model: "gpt-6.2-astra" },
      ok: false,
      now: t0,
      errorInfo: {
        errorKind: "auth_error",
        backend: "codex",
        reportBeforeFallback: true,
        message: "401 unauthorized",
      },
    });
    const authCheck = store.checkCooldown("codex_run", { model: "gpt-6.2-astra" }, t0 + 5_000);
    assert.equal(authCheck.blocked, false);
    assert.equal(authCheck.advisory, true);

    // 3. quota_exhausted does NOT increment loop counter even if repeated
    const q1 = store.recordCall({
      tool: "dsh_run",
      args: { taskId: "task-q", model: "deepseek-flash" },
      ok: false,
      now: t0,
      errorInfo: {
        errorKind: "quota_exhausted",
        backend: "dsh",
        reportBeforeFallback: true,
        message: "quota exceeded",
      },
    });
    const q2 = store.recordCall({
      tool: "dsh_run",
      args: { taskId: "task-q", model: "deepseek-flash" },
      ok: false,
      now: t0 + 1000,
      errorInfo: {
        errorKind: "quota_exhausted",
        backend: "dsh",
        reportBeforeFallback: true,
        message: "quota exceeded",
      },
    });
    assert.equal(q1.loopStatus, null);
    assert.equal(q2.loopStatus, null);

    // 4. Same runtime error >= 2 times on a task triggers loopDetected + tracks reworkAttempts
    const e1 = store.recordCall({
      tool: "dsh_run",
      args: { taskId: "task-build", acceptance: "npm test passes" },
      ok: false,
      now: t0 + 2000,
      errorInfo: {
        errorKind: "backend_error",
        backend: "dsh",
        reportBeforeFallback: false,
        message: "Build failed at line 42: Cannot find module foo",
      },
    });
    assert.equal(e1.loopStatus, null);
    assert.equal(e1.taskSummary.attempt, 1);
    assert.equal(e1.taskSummary.reworkAttempts, 0);

    const e2 = store.recordCall({
      tool: "dsh_run",
      args: { taskId: "task-build", acceptance: "npm test passes" },
      ok: false,
      now: t0 + 3000,
      errorInfo: {
        errorKind: "backend_error",
        backend: "dsh",
        reportBeforeFallback: false,
        message: "Build failed at line 99: Cannot find module foo",
      },
    });
    assert.equal(e2.loopStatus?.loopDetected, true);
    assert.equal(e2.loopStatus?.consecutiveFailures, 2);
    assert.equal(e2.taskSummary.attempt, 2);
    assert.equal(e2.taskSummary.reworkAttempts, 1);

    // 5. Success clears active error loop
    const okRec = store.recordCall({
      tool: "dsh_run",
      args: { taskId: "task-build" },
      ok: true,
      now: t0 + 4000,
    });
    assert.equal(okRec.loopStatus, null);
    const summary = store.getSummary(t0 + 5000);
    assert.equal(summary.activeLoops, undefined);
    assert.equal(summary.reworkCallsToday >= 2, true);

    // 6. REJECTED -> successful rework -> REJECTED preserves rejection streak and fires loopDetected; ACCEPTED clears it
    const r1 = store.recordCall({
      tool: "codex_run",
      args: { taskId: "task-review-rework", verdictMode: true, model: "gpt-6.2-sol" },
      ok: true,
      now: t0 + 6000,
      result: { parsedVerdict: { verdict: "REJECTED" } },
    });
    assert.equal(r1.loopStatus, null);
    store.recordCall({
      tool: "dsh_run",
      args: { taskId: "task-review-rework" },
      ok: true,
      now: t0 + 7000,
    });
    const r2 = store.recordCall({
      tool: "codex_run",
      args: { taskId: "task-review-rework", verdictMode: true, model: "gpt-6.2-sol" },
      ok: true,
      now: t0 + 8000,
      result: { parsedVerdict: { verdict: "REJECTED" } },
    });
    assert.equal(r2.loopStatus?.loopDetected, true);
    assert.equal(r2.loopStatus?.reason, "verdict_rejected");
    store.recordCall({
      tool: "codex_run",
      args: { taskId: "task-review-rework", verdictMode: true, model: "gpt-6.2-sol" },
      ok: true,
      now: t0 + 9000,
      result: { parsedVerdict: { verdict: "ACCEPTED" } },
    });
    assert.equal(store.getSummary(t0 + 9500).activeLoops, undefined);

    // 7. DSH provider-aware cooldown isolation + advisory auth_error does NOT erase active quota block
    store.recordCall({
      tool: "dsh_run",
      args: { provider: "prov-a", model: "flash" },
      ok: false,
      now: t0 + 10_000,
      errorInfo: { errorKind: "quota_exhausted", backend: "dsh", reportBeforeFallback: true, message: "quota" },
    });
    assert.equal(store.checkCooldown("dsh_run", { provider: "prov-a", model: "flash" }, t0 + 11_000).blocked, true);
    assert.equal(store.checkCooldown("dsh_run", { provider: "prov-b", model: "flash" }, t0 + 11_000).blocked, false);
    store.recordCall({
      tool: "dsh_run",
      args: { provider: "prov-a", model: "flash" },
      ok: false,
      now: t0 + 12_000,
      errorInfo: { errorKind: "auth_error", backend: "dsh", reportBeforeFallback: true, message: "401" },
    });
    assert.equal(store.checkCooldown("dsh_run", { provider: "prov-a", model: "flash" }, t0 + 13_000).blocked, true);

    // 8. US spelling "canceled" classified as cancelled and never triggers loop; prototype taskIds safe
    const canceledInfo = classifyBackendError("request canceled by client", "dsh_run");
    assert.equal(canceledInfo.errorKind, "cancelled");
    store.recordCall({ tool: "dsh_run", args: { taskId: "task-cancel" }, ok: false, now: t0 + 14_000, errorInfo: canceledInfo });
    const c2 = store.recordCall({ tool: "dsh_run", args: { taskId: "task-cancel" }, ok: false, now: t0 + 15_000, errorInfo: canceledInfo });
    assert.equal(c2.loopStatus, null);

    const protoRec = store.recordCall({ tool: "dsh_run", args: { taskId: "constructor" }, ok: true, now: t0 + 16_000 });
    assert.equal(protoRec.taskSummary.taskId, "constructor");
    const protoRec2 = store.recordCall({ tool: "dsh_run", args: { taskId: "__proto__" }, ok: true, now: t0 + 17_000 });
    assert.equal(protoRec2.taskSummary, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("output.mjs extracts key error lines from omitted middle and compacts verbose Codex command traces", () => {
  const tmpDir = makeTempDir("trihelm-v14-output-");
  try {
    const fillerLines = Array.from({ length: 120 }, (_, i) => `info log line ${i + 1}: ${"x".repeat(40)}`);
    fillerLines[55] = "TypeError: Cannot read properties of undefined (reading 'token')";
    fillerLines[58] = "✖ suite name failed";
    fillerLines[60] = "FAIL src/auth.test.mjs (2 failed)";
    const bigLog = fillerLines.join("\n");

    const spilled = spillLargeOutput(bigLog, {
      jobsDir: tmpDir,
      prefix: "test-err",
      inlineLimit: 1800,
    });
    assert.equal(spilled.truncated, true);
    assert.equal(spilled.totalLines, 120);
    assert.ok(spilled.extractedErrorLines >= 3);
    assert.match(spilled.text, /key error lines in omitted middle/);
    assert.match(spilled.text, /TypeError: Cannot read properties of undefined/);
    assert.match(spilled.text, /✖ suite name failed/);
    assert.match(spilled.text, /120 lines/);

    const commands = [
      ...Array.from({ length: 10 }, (_, i) => ({
        command: `echo ok-${i}`,
        status: "completed",
        exitCode: 0,
      })),
      { command: "npm test", status: "failed", exitCode: 1 },
      { command: "spawn failed", status: "failed", exitCode: null },
    ];
    const fileChanges = [
      ...Array.from({ length: 14 }, (_, i) => ({
        status: "completed",
        changes: [{ path: `src/f${i}.js`, kind: "update" }],
      })),
      { status: "failed", changes: [{ path: "src/broken.js", kind: "update" }] },
    ];

    const compacted = compactCodexItems(fileChanges, commands, { jobsDir: tmpDir });
    assert.equal(compacted.commandsSummary.total, 12);
    assert.equal(compacted.commandsSummary.failed, 2);
    assert.equal(compacted.commandsSummary.succeeded, 10);
    assert.equal(compacted.commandsSummary.omittedPassed, 7);
    assert.equal(compacted.commands.some((c) => c.command === "npm test" && c.exitCode === 1), true);
    assert.equal(compacted.commands.some((c) => c.command === "spawn failed" && c.status === "failed"), true);
    assert.ok(compacted.commandsLogFile && fs.existsSync(compacted.commandsLogFile));
    assert.equal(compacted.fileChanges.length, 12);
    assert.equal(compacted.fileChanges.some((fc) => fc.status === "failed"), true);
    assert.equal(compacted.fileChangesSummary.failedEvents, 1);
    assert.equal(compacted.fileChangesSummary.omittedEvents, 3);
    assert.ok(compacted.fileChangesLogFile && fs.existsSync(compacted.fileChangesLogFile));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("worktree.mjs uses mutually exclusive git merge-tree (clean committed) vs file-overlap (dirty)", () => {
  const { root, repoDir } = initTempGitRepo();
  try {
    const wt1 = worktreeCreate({ repoCwd: repoDir, name: "top-fn" });
    const wt2 = worktreeCreate({ repoCwd: repoDir, name: "bottom-fn" });

    // Edit non-overlapping regions of the SAME file in two clean committed branches
    const orig = fs.readFileSync(path.join(repoDir, "src", "multi.js"), "utf8");
    fs.writeFileSync(
      path.join(wt1.worktreePath, "src", "multi.js"),
      orig.replace("return 1;", "return 100;"),
      "utf8"
    );
    execFileSync("git", ["add", "src/multi.js"], { cwd: wt1.worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "update top"], { cwd: wt1.worktreePath });

    fs.writeFileSync(
      path.join(wt2.worktreePath, "src", "multi.js"),
      orig.replace("return 2;", "return 200;"),
      "utf8"
    );
    execFileSync("git", ["add", "src/multi.js"], { cwd: wt2.worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "update bottom"], { cwd: wt2.worktreePath });

    const nonConflicting = worktreeList({ repoCwd: repoDir });
    if (supportsGitMergeTree(repoDir)) {
      // Clean 3-way merge -> ZERO false-positive overlap noise
      assert.equal(nonConflicting.potentialConflicts.length, 0);
      const wt1Entry = nonConflicting.worktrees.find((w) => w.path === wt1.worktreePath);
      assert.equal(wt1Entry.mergeWithMain.method, "git-merge-tree");
      assert.equal(wt1Entry.mergeWithMain.clean, true);

      // Now introduce a REAL conflicting commit on the same line in wt2
      fs.writeFileSync(
        path.join(wt2.worktreePath, "src", "multi.js"),
        orig.replace("return 1;", "return 999;").replace("return 2;", "return 200;"),
        "utf8"
      );
      execFileSync("git", ["add", "src/multi.js"], { cwd: wt2.worktreePath });
      execFileSync("git", ["commit", "-q", "-m", "conflict top"], { cwd: wt2.worktreePath });

      const realConflict = worktreeList({ repoCwd: repoDir });
      assert.equal(realConflict.potentialConflicts.length, 1);
      assert.equal(realConflict.potentialConflicts[0].file, "src/multi.js");
      assert.equal(realConflict.potentialConflicts[0].method, "git-merge-tree");

      // Advance main with a conflicting edit on top() -> wt1 mergeWithMain flags conflict
      fs.writeFileSync(
        path.join(repoDir, "src", "multi.js"),
        orig.replace("return 1;", "return 777;"),
        "utf8"
      );
      execFileSync("git", ["add", "src/multi.js"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "main edit top"], { cwd: repoDir });

      const mainConflict = worktreeList({ repoCwd: repoDir });
      const wt1AfterMain = mainConflict.worktrees.find((w) => w.path === wt1.worktreePath);
      assert.equal(wt1AfterMain.mergeWithMain.clean, false);
      assert.deepEqual(wt1AfterMain.mergeWithMain.conflictFiles, ["src/multi.js"]);
    }

    // Dirty worktree skips merge-tree and falls back to file-overlap; mixed 3rd dirty worktree stays separated from clean merge-tree conflict
    const wt3 = worktreeCreate({ repoCwd: repoDir, name: "dirty-third" });
    fs.writeFileSync(path.join(wt3.worktreePath, "src", "multi.js"), "// dirty\n", "utf8");
    const mixedRes = worktreeList({ repoCwd: repoDir });
    const wt3Dirty = mixedRes.worktrees.find((w) => w.path === wt3.worktreePath);
    assert.equal(wt3Dirty.mergeWithMain.method, "skipped");
    assert.equal(wt3Dirty.mergeWithMain.reason, "worktree_dirty");
    if (supportsGitMergeTree(repoDir)) {
      const mergeEntry = mixedRes.potentialConflicts.find((c) => c.method === "git-merge-tree");
      const overlapEntry = mixedRes.potentialConflicts.find((c) => c.method === "file-overlap");
      assert.ok(mergeEntry, "Expected confirmed git-merge-tree conflict between wt1 and wt2");
      assert.equal(mergeEntry.worktrees.length, 2);
      assert.ok(overlapEntry, "Expected separate file-overlap entry for dirty wt3");
      assert.equal(overlapEntry.reason, "uncommitted_changes");
    }

    worktreeCleanup({ repoCwd: repoDir, worktreePath: wt1.worktreePath, deleteBranch: true, force: true });
    worktreeCleanup({ repoCwd: repoDir, worktreePath: wt2.worktreePath, deleteBranch: true, force: true });
    worktreeCleanup({ repoCwd: repoDir, worktreePath: wt3.worktreePath, deleteBranch: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("E2E MCP v1.4 enforces cooldown pre-check with ignoreCooldown escape hatch, acceptance prompt, and verdict loop warning", async () => {
  const { root, repoDir } = initTempGitRepo("trihelm-v14-e2e-");
  const mockDshBin = path.join(root, "mock-dsh-v14.sh");
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
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "mock-v14" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-" + Date.now() + "-" + Math.random(), configOptions: [] } });
  else if (m.method === "session/set_config_option") send({ jsonrpc: "2.0", id: m.id, result: { configOptions: [{ id: m.params.configId, currentValue: m.params.value }] } });
  else if (m.method === "session/prompt") {
    const sid = m.params.sessionId;
    const text = (m.params.prompt && m.params.prompt[0] && m.params.prompt[0].text) || "";
    if (text.includes("TRIGGER_QUOTA")) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "HTTP 429 quota exceeded" } });
      return;
    }
    let reply = "ECHO:" + text;
    if (text.includes("REJECT_ME")) {
      reply = JSON.stringify({
        verdict: "REJECTED",
        summary: "Still failing acceptance check",
        commands_run: [],
        findings: [{ severity: "high", file: "src/multi.js", line_start: 1, line_end: 3, evidence: "bug", fix: "fix it" }],
        unverified: []
      });
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
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

  try {
    await rpc("initialize", { protocolVersion: "2025-03-26" });

    // 1. Quota error puts model into cooldown
    const quotaErr = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "TRIGGER_QUOTA", cwd: repoDir, model: "deepseek-flash" },
    });
    assert.equal(quotaErr.result.isError, true);
    assert.match(quotaErr.result.content[0].text, /quota_exhausted/);

    // 2. Immediate follow-up on same model is blocked pre-dispatch without hitting backend
    const blocked = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "NORMAL_CALL", cwd: repoDir, model: "deepseek-flash" },
    });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /"cooldownBlocked": true/);

    // 3. Passing ignoreCooldown: true bypasses cooldown, succeeds, and clears cooldown
    const bypassed = await rpc("tools/call", {
      name: "dsh_run",
      arguments: {
        prompt: "CHECK_ACCEPTANCE",
        cwd: repoDir,
        model: "deepseek-flash",
        taskId: "demo-task-1",
        acceptance: "All unit tests pass",
        ignoreCooldown: true,
      },
    });
    assert.notEqual(bypassed.result.isError, true);
    const bypassedPayload = JSON.parse(bypassed.result.content[0].text);
    assert.match(bypassedPayload.response, /Acceptance criteria: All unit tests pass/);
    assert.equal(bypassedPayload.taskSummary.taskId, "demo-task-1");
    assert.equal(bypassedPayload.taskSummary.attempt, 1);

    // 4. Two consecutive verdictMode REJECTED responses on same taskId trigger loopWarning
    const v1 = await rpc("tools/call", {
      name: "dsh_run",
      arguments: {
        prompt: "REJECT_ME round 1",
        cwd: repoDir,
        model: "deepseek-flash",
        verdictMode: true,
        taskId: "review-loop-task",
      },
    });
    const v1Payload = JSON.parse(v1.result.content[0].text);
    assert.equal(v1Payload.parsedVerdict.verdict, "REJECTED");
    assert.equal(v1Payload.loopWarning, undefined);

    const v2 = await rpc("tools/call", {
      name: "dsh_run",
      arguments: {
        prompt: "REJECT_ME round 2",
        cwd: repoDir,
        model: "deepseek-flash",
        verdictMode: true,
        taskId: "review-loop-task",
      },
    });
    const v2Payload = JSON.parse(v2.result.content[0].text);
    assert.equal(v2Payload.parsedVerdict.verdict, "REJECTED");
    assert.equal(v2Payload.loopWarning?.loopDetected, true);
    assert.equal(v2Payload.loopWarning?.reason, "verdict_rejected");
    assert.equal(v2Payload.loopWarning?.consecutiveFailures, 2);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
