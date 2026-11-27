import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DshAcpPool } from "../lib/dsh-pool.mjs";
import { classifyBackendError, formatMcpErrorText } from "../lib/errors.mjs";
import { compactDshToolCalls } from "../lib/output.mjs";
import { auditScopeAfterRun, captureGitSnapshot, resolveScopeConfig } from "../lib/scope.mjs";
import { parseVerdictResponse, prepareVerdictArgs } from "../lib/verdict.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "../index.mjs");
const WAIT_JOB_ENTRY = path.resolve(__dirname, "../wait-job.mjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(prefix = "trihelm-v141-repo-") {
  const root = makeTempDir(prefix);
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export const v = 1;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "secret.config.js"), "export const secret = true;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return { root, repoDir };
}

test("output.mjs compactDshToolCalls retains all failed calls, compacts verbose turns, and spills full log", () => {
  const jobsDir = makeTempDir("trihelm-v141-dsh-tc-");
  try {
    const small = Array.from({ length: 6 }, (_, i) => ({
      id: `tc-${i}`,
      title: `read file ${i}`,
      kind: "read",
      status: "completed",
    }));
    const uncompacted = compactDshToolCalls(small, { jobsDir });
    assert.equal(uncompacted.toolCalls.length, 6);
    assert.equal(uncompacted.toolCallsSummary, undefined);

    const verbose = [];
    for (let i = 0; i < 18; i += 1) {
      verbose.push({
        id: `tc-${i}`,
        title: `step ${i}`,
        kind: i === 5 ? "execute" : "read",
        status: i === 5 ? "failed" : i === 9 ? "denied" : i === 12 ? "in_progress" : "completed",
      });
    }

    const res = compactDshToolCalls(verbose, { jobsDir });
    assert.equal(res.toolCallsSummary.total, 18);
    assert.equal(res.toolCallsSummary.failed, 2);
    assert.equal(res.toolCallsSummary.completed, 15);
    assert.equal(res.toolCallsSummary.other, 1);
    assert.equal(res.toolCalls.length, 6); // 2 failed + last 4 non-failed
    assert.ok(res.toolCalls.some((c) => c.id === "tc-5" && c.status === "failed"));
    assert.ok(res.toolCalls.some((c) => c.id === "tc-9" && c.status === "denied"));
    assert.ok(res.toolCalls.some((c) => c.id === "tc-17"));
    assert.ok(res.toolCallsLogFile && fs.existsSync(res.toolCallsLogFile));
    const full = JSON.parse(fs.readFileSync(res.toolCallsLogFile, "utf8"));
    assert.equal(full.length, 18);

    // Regression: when spill cannot be written (no jobsDir), keep all calls inline and emit warning
    const noSpill = compactDshToolCalls(verbose, {});
    assert.equal(noSpill.toolCalls.length, 18);
    assert.equal(noSpill.toolCallsSummary, undefined);
    assert.equal(noSpill.toolCallsLogFile, undefined);
    assert.match(noSpill.toolCallsSpillWarning, /kept all toolCalls inline/i);
  } finally {
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("scope.mjs auditScopeAfterRun catches files committed during a worker turn (including forbidden files)", () => {
  const { root, repoDir } = initTempGitRepo();
  try {
    const scopeConfig = resolveScopeConfig({
      allowedPaths: ["src/"],
      forbiddenPaths: ["secret.config.js"],
    });
    const before = captureGitSnapshot(repoDir);
    assert.ok(before.headSha, "before snapshot should capture HEAD sha");

    // Worker edits an allowed file AND a forbidden file, then commits everything so working tree is clean
    fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export const v = 2;\nexport const w = 3;\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "secret.config.js"), "export const secret = false;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "worker commit"], { cwd: repoDir });

    const audit = auditScopeAfterRun(repoDir, before, scopeConfig);
    assert.equal(audit.enforced, true);
    assert.deepEqual(audit.changedFiles, ["secret.config.js", "src/app.js"]);
    assert.equal(audit.violations.length, 1);
    assert.equal(audit.violations[0].path, "secret.config.js");
    assert.equal(audit.violations[0].reason, "forbidden_path");
    assert.ok(audit.diffStat.totalAdded >= 3, "diffStat should count committed additions against pre-run HEAD");
    assert.ok(audit.diffStat.totalDeleted >= 2, "diffStat should count committed deletions against pre-run HEAD");

    // Regression: clean committed rename from forbidden source into allowed dir must still flag forbidden source
    const beforeRename = captureGitSnapshot(repoDir);
    execFileSync("git", ["mv", "secret.config.js", "src/moved-secret.js"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "rename forbidden into allowed"], { cwd: repoDir });
    const renameAudit = auditScopeAfterRun(repoDir, beforeRename, scopeConfig);
    assert.ok(renameAudit.changedFiles.includes("secret.config.js"));
    assert.ok(renameAudit.changedFiles.includes("src/moved-secret.js"));
    assert.ok(
      renameAudit.violations.some((v) => v.path === "secret.config.js" && v.reason === "forbidden_path"),
      "committed rename must still catch forbidden source path"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scope.mjs auditScopeAfterRun catches initial + multi-commit unborn HEAD and accurate diffStat with dirty edits", () => {
  const root = makeTempDir("trihelm-v141-unborn-");
  try {
    const repoDir = path.join(root, "fresh");
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

    const scopeConfig = resolveScopeConfig({ allowedPaths: ["src/"] });
    const before = captureGitSnapshot(repoDir);
    assert.equal(before.headSha, null);

    // Commit 1 introduces a forbidden file and an allowed file
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "ok.js"), "line1\nline2\nline3\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "outside.txt"), "nope\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "commit 1"], { cwd: repoDir });

    // Commit 2 touches only an allowed file (so HEAD~1..HEAD alone would miss outside.txt!)
    fs.writeFileSync(path.join(repoDir, "src", "second.js"), "a\nb\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "commit 2"], { cwd: repoDir });

    // Unstaged follow-up edit to commit 1's file to verify empty-tree numstat counts all 4 lines, not just +1
    fs.writeFileSync(path.join(repoDir, "src", "ok.js"), "line1\nline2\nline3\nline4\n", "utf8");

    const audit = auditScopeAfterRun(repoDir, before, scopeConfig);
    assert.deepEqual(audit.changedFiles, ["outside.txt", "src/ok.js", "src/second.js"]);
    assert.equal(audit.violations.length, 1);
    assert.equal(audit.violations[0].path, "outside.txt");
    const okStat = audit.diffStat.files.find((f) => f.path === "src/ok.js");
    assert.equal(okStat.added, 4);
    assert.equal(okStat.deleted, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verdict.mjs checks acceptance coverage in single pass and downgrades contradictory ACCEPTED with blocking findings", () => {
  const prep = prepareVerdictArgs("codex", {
    prompt: "Review diff",
    verdictMode: true,
  });
  assert.match(prep.prompt, /acceptance coverage/i);

  const contradictory = JSON.stringify({
    verdict: "ACCEPTED",
    summary: "Found a high-severity SQL injection bug.",
    commands_run: [{ command: "npm test", exit_code: 0, output_tail: "ok" }],
    findings: [
      {
        severity: "high",
        file: "src/db.js",
        line_start: 10,
        line_end: 14,
        evidence: "Unsanitized user input interpolated into SQL query",
        fix: "Use parameterized queries",
      },
    ],
    unverified: [],
  });
  const parsed = parseVerdictResponse(contradictory);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict.verdict, "REJECTED");
  assert.equal(parsed.verdict.originalVerdict, "ACCEPTED");
  assert.match(parsed.consistencyWarning, /downgraded to REJECTED/i);

  // Medium/low findings with ACCEPTED remain ACCEPTED without warning
  const acceptable = JSON.stringify({
    verdict: "ACCEPTED",
    summary: "Minor style nit only.",
    commands_run: [],
    findings: [
      {
        severity: "low",
        file: "src/app.js",
        line_start: 1,
        line_end: 1,
        evidence: "Unused comment",
        fix: "Optional cleanup",
      },
    ],
    unverified: [],
  });
  const parsedOk = parseVerdictResponse(acceptable);
  assert.equal(parsedOk.ok, true);
  assert.equal(parsedOk.verdict.verdict, "ACCEPTED");
  assert.equal(parsedOk.consistencyWarning, undefined);
});

test("errors.mjs preserves resumable threadId/sessionId in classifyBackendError and formatMcpErrorText", () => {
  const err = new Error("Codex timed out after 150000ms");
  err.threadId = "thr-resume-123";
  const info = classifyBackendError(err, "codex_run");
  assert.equal(info.errorKind, "timeout");
  assert.equal(info.threadId, "thr-resume-123");
  const text = formatMcpErrorText(info);
  assert.match(text, /thr-resume-123/);

  const dshErr = new Error("dsh ACP request 'session/prompt' timed out after 150000ms");
  dshErr.sessionId = "sess-resume-456";
  dshErr.workerId = "dsh-1";
  const dshInfo = classifyBackendError(dshErr, "dsh_run");
  assert.equal(dshInfo.sessionId, "sess-resume-456");
  assert.equal(dshInfo.workerId, "dsh-1");
  const dshText = formatMcpErrorText(dshInfo);
  assert.match(dshText, /sess-resume-456/);
});

test("wait-job.mjs surfaces taskId, taskSummary, verdictConsistencyWarning, and loopWarning", () => {
  const jobsDir = makeTempDir("trihelm-v141-wait-");
  try {
    const jobId = "job-v141-summary";
    fs.writeFileSync(
      path.join(jobsDir, `${jobId}.json`),
      JSON.stringify({
        jobId,
        tool: "codex_run",
        status: "completed",
        startedAt: Date.now() - 2500,
        finishedAt: Date.now(),
        meta: { taskId: "task-auth-fix", model: "gpt-6.2-sol" },
        result: {
          parsedVerdict: { verdict: "REJECTED" },
          verdictConsistencyWarning: "Verifier returned ACCEPTED despite 1 blocking finding(s); downgraded to REJECTED.",
          taskSummary: { taskId: "task-auth-fix", attempt: 3, reworkAttempts: 1, verdictRejections: 2 },
          loopWarning: { loopDetected: true, reason: "verdict_rejected", consecutiveFailures: 2 },
        },
      }),
      "utf8"
    );

    const out = execFileSync(
      process.execPath,
      [WAIT_JOB_ENTRY, "--jobs-dir", jobsDir, jobId],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.event, "completed");
    assert.equal(parsed.jobs[0].taskId, "task-auth-fix");
    assert.equal(parsed.jobs[0].verdict, "REJECTED");
    assert.equal(parsed.jobs[0].taskSummary.verdictRejections, 2);
    assert.equal(parsed.jobs[0].loopWarning.loopDetected, true);
    assert.match(parsed.jobs[0].verdictConsistencyWarning, /downgraded to REJECTED/);
  } finally {
    fs.rmSync(jobsDir, { recursive: true, force: true });
  }
});

test("DshAcpPool binds sessionId before prompt failure, returns resumable sessionId, and reaps stale bound workers", async () => {
  const tmpDir = makeTempDir("trihelm-v141-pool-");
  const mockDsh = path.join(tmpDir, "mock-dsh.mjs");
  fs.writeFileSync(
    mockDsh,
    `#!/usr/bin/env node
import readline from "node:readline";
let seq = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "mock-dsh" } } }) + "\\n");
  } else if (msg.method === "session/new") {
    seq += 1;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-" + seq, configOptions: [] } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    const text = msg.params?.prompt?.[0]?.text || "";
    if (text.includes("FAIL_TURN")) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "simulated prompt failure" } }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "RESUMED:" + msg.params.sessionId } } }
    }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
  }
});
`,
    "utf8"
  );
  fs.chmodSync(mockDsh, 0o755);

  const pool = new DshAcpPool({
    dshBin: mockDsh,
    dshArgs: [],
    maxConcurrency: 2,
    idleTimeoutMs: 10_000,
    boundSessionIdleTimeoutMs: 20_000,
    resolveCwd: (c) => c || tmpDir,
    resolveTimeoutMs: () => 10_000,
    truncate: (s) => s,
  });

  try {
    let capturedSessionId = null;
    await assert.rejects(
      async () => {
        await pool.runPrompt({ prompt: "FAIL_TURN", cwd: tmpDir });
      },
      (err) => {
        assert.match(err.message, /simulated prompt failure/);
        assert.equal(err.sessionId, "sess-1");
        assert.equal(err.workerId, "dsh-1");
        capturedSessionId = err.sessionId;
        return true;
      }
    );

    assert.equal(pool.getPoolStats().boundSessions, 1, "session should remain bound after prompt error");

    // Resume on the same sessionId and verify it routes to the same live worker
    const resumed = await pool.runPrompt({
      prompt: "CONTINUE",
      cwd: tmpDir,
      sessionId: capturedSessionId,
    });
    assert.equal(resumed.workerId, "dsh-1");
    assert.equal(resumed.response, "RESUMED:sess-1");

    // Simulate long idle past boundSessionIdleTimeoutMs -> stale bound session should be reaped
    const futureNow = Date.now() + 25_000;
    pool.reapIdleWorkers(futureNow);
    assert.equal(pool.getPoolStats().boundSessions, 0, "stale bound session should be cleared after idle TTL");
    assert.equal(pool.getPoolStats().runningWorkers, 0, "stale worker process should be disposed");

    // Regression: unconfirmed expired sessionId rejected by worker must NOT be bound or reported resumable
    const slot = pool.slots.values().next().value || pool.createSlot();
    await slot.client.ensureStarted();
    const origReq = slot.client.request.bind(slot.client);
    slot.client.request = async (method, params, timeoutMs, signal) => {
      if (method === "session/prompt" && params?.sessionId === "expired-999") {
        throw new Error("dsh ACP error (-32001): unknown session 'expired-999'");
      }
      return origReq(method, params, timeoutMs, signal);
    };
    await assert.rejects(
      async () => {
        await pool.runPrompt({ prompt: "CONTINUE", cwd: tmpDir, sessionId: "expired-999" });
      },
      (err) => {
        assert.match(err.message, /unknown session/i);
        assert.equal(err.sessionId, undefined, "expired unknown session must not be advertised as resumable");
        return true;
      }
    );
    assert.equal(pool.getPoolStats().boundSessions, 0, "expired session must not stay bound");
    slot.client.request = origReq;

    // Regression: dispose() must immediately reject and clear pending RPCs
    const pendingRpc = slot.client.request("session/close", { sessionId: "s-hang" }, 5000);
    assert.equal(slot.client.pending.size, 1);
    slot.client.dispose();
    assert.equal(slot.client.pending.size, 0, "dispose() must clear pending RPCs immediately");
    await assert.rejects(pendingRpc, /disposed/i);
  } finally {
    pool.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MCP end-to-end: dsh_run compacts large toolCalls, spills full >120k response without pre-truncation, and downgrades contradictory verdict", async () => {
  const tmpDir = makeTempDir("trihelm-v141-e2e-");
  const jobsDir = path.join(tmpDir, "jobs");
  const metricsFile = path.join(tmpDir, "metrics.json");
  const mockDsh = path.join(tmpDir, "mock-dsh-e2e.mjs");

  fs.writeFileSync(
    mockDsh,
    `#!/usr/bin/env node
import readline from "node:readline";
let seq = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "mock-dsh-e2e" } } }) + "\\n");
  } else if (msg.method === "session/new") {
    seq += 1;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "e2e-" + seq, configOptions: [] } }) + "\\n");
  } else if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    const text = msg.params?.prompt?.[0]?.text || "";
    if (text.includes("HUGE_TOOLS")) {
      for (let i = 0; i < 16; i += 1) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "t-" + i,
              title: "tool " + i,
              kind: "read",
              status: i === 3 ? "failed" : "completed"
            }
          }
        }) + "\\n");
      }
      const huge = "A".repeat(130000) + "\\nTAIL_SENTINEL_130K";
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: huge } } }
      }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
      return;
    }
    if (text.includes("BAD_VERDICT")) {
      const verdictJson = JSON.stringify({
        verdict: "ACCEPTED",
        summary: "Contradictory verdict",
        commands_run: [],
        findings: [{ severity: "critical", file: "a.js", line_start: 1, line_end: 2, evidence: "bug", fix: "fix" }],
        unverified: []
      });
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: verdictJson } } }
      }) + "\\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }) + "\\n");
      return;
    }
  }
});
`,
    "utf8"
  );
  fs.chmodSync(mockDsh, 0o755);

  const server = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DSH_BIN: mockDsh,
      JOBS_DIR: jobsDir,
      METRICS_FILE: metricsFile,
    },
  });

  const rl = readline.createInterface({ input: server.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await call("initialize", { protocolVersion: "2025-03-26" });

    const r1 = await call("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "HUGE_TOOLS", cwd: tmpDir },
    });
    assert.equal(r1.result.isError, undefined);
    const p1 = JSON.parse(r1.result.content[0].text);
    assert.equal(p1.toolCallsSummary.total, 16);
    assert.equal(p1.toolCallsSummary.failed, 1);
    assert.equal(p1.toolCalls.length, 5); // 1 failed + 4 recent non-failed
    assert.ok(p1.toolCallsLogFile && fs.existsSync(p1.toolCallsLogFile));
    assert.equal(p1.outputTruncated, true);
    assert.ok(p1.outputTotalChars > 130_000, "full >120k output should reach spillLargeOutput intact");
    assert.ok(fs.readFileSync(p1.outputFile, "utf8").includes("TAIL_SENTINEL_130K"));

    const r2 = await call("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "BAD_VERDICT", cwd: tmpDir, verdictMode: true, taskId: "t-contradict" },
    });
    const p2 = JSON.parse(r2.result.content[0].text);
    assert.equal(p2.parsedVerdict.verdict, "REJECTED");
    assert.equal(p2.parsedVerdict.originalVerdict, "ACCEPTED");
    assert.match(p2.verdictConsistencyWarning, /downgraded to REJECTED/);
    assert.equal(p2.taskSummary.verdictRejections, 1);
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
