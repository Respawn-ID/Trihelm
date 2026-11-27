import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DshAcpPool, isReadOnlyToolCall } from "../lib/dsh-pool.mjs";
import { classifyBackendError, formatMcpErrorText } from "../lib/errors.mjs";
import {
  auditScopeAfterRun,
  captureGitSnapshot,
  extractPathsFromToolCall,
  resolveScopeConfig,
} from "../lib/scope.mjs";
import {
  VERDICT_OUTPUT_SCHEMA,
  parseVerdictResponse,
  prepareVerdictArgs,
} from "../lib/verdict.mjs";
import { worktreeCleanup, worktreeCreate, worktreeList } from "../lib/worktree.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "../index.mjs");
const EXPECTED_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")
).version;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initTempGitRepo(prefix = "orch-test-repo-") {
  const root = makeTempDir(prefix);
  const repoDir = path.join(root, "demo-repo");
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.mkdirSync(path.join(repoDir, "src", "api"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "lib", "billing"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "api", "orders.js"), "export const v = 1;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "lib", "billing", "pay.js"), "export const p = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  return { root, repoDir };
}

test("verdict.mjs enforces fresh read-only context and parses structured verdicts", () => {
  const codexPrep = prepareVerdictArgs("codex", { prompt: "Verify orders.js", verdictMode: true });
  assert.equal(codexPrep.active, true);
  assert.equal(codexPrep.sandboxMode, "read-only");
  assert.deepEqual(codexPrep.outputSchema, VERDICT_OUTPUT_SCHEMA);
  assert.match(codexPrep.prompt, /VERIFIER PROTOCOL/);

  assert.throws(
    () => prepareVerdictArgs("codex", { prompt: "x", verdictMode: true, threadId: "th-1" }),
    /fresh verifier context/
  );
  assert.throws(
    () =>
      prepareVerdictArgs("codex", {
        prompt: "x",
        verdictMode: true,
        sandboxMode: "workspace-write",
      }),
    /read-only verification/
  );
  assert.throws(
    () => prepareVerdictArgs("dsh", { prompt: "x", verdictMode: true, sessionId: "s-1" }),
    /fresh verifier context/
  );
  assert.throws(
    () =>
      prepareVerdictArgs("dsh", {
        prompt: "x",
        verdictMode: true,
        permissionPolicy: "allow_all",
      }),
    /read-only verification/
  );

  const sample = {
    verdict: "REJECTED",
    summary: "Found 1 bug",
    commands_run: [{ command: "npm test", exit_code: 1, output_tail: "FAIL" }],
    findings: [
      {
        severity: "high",
        file: "src/api/orders.js",
        line_start: 1,
        line_end: 1,
        evidence: "Missing validation",
        fix: "Validate amount > 0",
      },
    ],
    unverified: ["not measured: load test"],
  };

  const fenced = `Here is the verdict:\n\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``;
  const parsed = parseVerdictResponse(fenced);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict.verdict, "REJECTED");
  assert.equal(parsed.verdict.findings[0].file, "src/api/orders.js");

  const bad = parseVerdictResponse("looks good to me!");
  assert.equal(bad.ok, false);
  assert.match(bad.warning, /Failed to parse/);
});

test("scope.mjs audits git diffs accurately without flagging pre-existing dirty files", () => {
  const { root, repoDir } = initTempGitRepo();
  try {
    // Pre-existing dirty file outside allowedPaths must NOT be flagged if untouched during run
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Dirty before run\n", "utf8");

    const scopeConfig = resolveScopeConfig({
      allowedPaths: ["src/api/"],
      forbiddenPaths: ["lib/billing/"],
    });
    const before = captureGitSnapshot(repoDir);

    // Allowed edit
    fs.writeFileSync(path.join(repoDir, "src", "api", "orders.js"), "export const v = 2;\n", "utf8");
    const okAudit = auditScopeAfterRun(repoDir, before, scopeConfig);
    assert.equal(okAudit.enforced, true);
    assert.deepEqual(okAudit.changedFiles, ["src/api/orders.js"]);
    assert.equal(okAudit.violations.length, 0);

    // Out-of-scope + sensitive edits
    fs.writeFileSync(path.join(repoDir, "lib", "billing", "pay.js"), "export const p = 99;\n", "utf8");
    fs.writeFileSync(path.join(repoDir, ".env.local"), "SECRET=123\n", "utf8");
    const badAudit = auditScopeAfterRun(repoDir, before, scopeConfig);
    assert.equal(badAudit.violations.length, 2);
    const byPath = Object.fromEntries(badAudit.violations.map((v) => [v.path, v]));
    assert.equal(byPath["lib/billing/pay.js"].reason, "forbidden_path");
    assert.equal(byPath[".env.local"].reason, "forbidden_path");

    // Extract paths helper
    const extracted = extractPathsFromToolCall(
      {
        locations: [{ path: path.join(repoDir, "lib/billing/pay.js") }],
        rawInput: { file_path: ".env.local" },
      },
      repoDir
    );
    assert.deepEqual(extracted.sort(), [".env.local", "lib/billing/pay.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("worktree.mjs handles create, copyEnv, symlinkDirs, list, dirty guard, and cleanup", () => {
  const { root, repoDir } = initTempGitRepo();
  try {
    fs.writeFileSync(path.join(repoDir, ".env.local"), "TOKEN=abc\n", "utf8");
    fs.mkdirSync(path.join(repoDir, "node_modules", "fake-pkg"), { recursive: true });

    const created = worktreeCreate({
      repoCwd: repoDir,
      name: "API Validation",
      copyEnv: true,
      symlinkDirs: ["node_modules"],
    });

    assert.match(created.branch, /^orch\/api-validation-[0-9a-f]{4}$/);
    assert.deepEqual(created.copiedEnvFiles, [".env.local"]);
    assert.deepEqual(created.symlinkedDirs, ["node_modules"]);
    assert.equal(fs.readFileSync(path.join(created.worktreePath, ".env.local"), "utf8"), "TOKEN=abc\n");
    assert.equal(fs.lstatSync(path.join(created.worktreePath, "node_modules")).isSymbolicLink(), true);

    const listed = worktreeList({ repoCwd: repoDir });
    const managed = listed.worktrees.find((w) => w.path === created.worktreePath);
    assert.ok(managed);
    assert.equal(managed.managedByPlugin, true);
    assert.equal(managed.branch, created.branch);

    // Dirty worktree refuses non-forced cleanup
    fs.writeFileSync(path.join(created.worktreePath, "src", "api", "new.js"), "export const n = 1;\n", "utf8");
    assert.throws(
      () => worktreeCleanup({ repoCwd: repoDir, worktreePath: created.worktreePath }),
      /uncommitted\/untracked/
    );

    // Refuses removing main repo
    assert.throws(
      () => worktreeCleanup({ repoCwd: repoDir, worktreePath: repoDir, force: true }),
      /Refusing to remove the main repository/
    );

    // Forced cleanup removes directory and orch/* branch
    const cleaned = worktreeCleanup({
      repoCwd: repoDir,
      worktreePath: created.worktreePath,
      deleteBranch: true,
      force: true,
    });
    assert.equal(cleaned.removed, true);
    assert.equal(cleaned.branchDeleted, true);
    assert.equal(fs.existsSync(created.worktreePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dsh-pool.mjs runs concurrent workers in parallel, preserves session affinity, and blocks forbidden paths", async () => {
  const tmpDir = makeTempDir("orch-mock-acp-");
  const mockAcpScript = path.join(tmpDir, "mock-acp.mjs");

  fs.writeFileSync(
    mockAcpScript,
    `import readline from "node:readline";
const pid = process.pid;
let seq = 1;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pendingPerm = new Map();
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const fn = pendingPerm.get(msg.id);
    if (fn) { pendingPerm.delete(msg.id); fn(msg.result); }
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "mock-dsh", pid } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-" + pid + "-" + (seq++), configOptions: [] } });
  } else if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
  } else if (msg.method === "session/prompt") {
    const text = msg.params.prompt[0].text;
    const sessionId = msg.params.sessionId;
    if (text.includes("TRY_FORBIDDEN_WRITE")) {
      const permId = 9000 + seq++;
      pendingPerm.set(permId, (permResult) => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "perm=" + JSON.stringify(permResult) } } }
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      });
      send({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { kind: "edit", title: "edit .env.local", rawInput: { file_path: ".env.local" } },
          options: [{ optionId: "allow-1", kind: "allow_once" }, { optionId: "deny-1", kind: "reject_once" }]
        }
      });
      return;
    }
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pid=" + pid + " echo=" + text } } }
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }, 250);
  }
});
`,
    "utf8"
  );

  const pool = new DshAcpPool({
    dshBin: process.execPath,
    dshArgs: [mockAcpScript],
    maxConcurrency: 2,
    resolveCwd: (c) => c || tmpDir,
    resolveTimeoutMs: () => 10_000,
    truncate: (s) => s,
  });

  try {
    // 1. Two concurrent calls should run in parallel on two separate workers
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      pool.runPrompt({ prompt: "job-A", cwd: tmpDir }),
      pool.runPrompt({ prompt: "job-B", cwd: tmpDir }),
    ]);
    const elapsed = Date.now() - t0;
    assert.notEqual(r1.workerId, r2.workerId);
    assert.ok(elapsed < 480, `Expected parallel execution (<480ms), took ${elapsed}ms`);

    // 2. Follow-up turn with sessionId routes back to the owning worker
    const follow = await pool.runPrompt({ prompt: "followup", cwd: tmpDir, sessionId: r1.sessionId });
    assert.equal(follow.workerId, r1.workerId);
    assert.equal(follow.sessionId, r1.sessionId);

    // 3. Even under allow_all, scopeConfig blocks forbidden .env.local edit
    const scopeConfig = resolveScopeConfig({ allowedPaths: ["src/"] });
    const blocked = await pool.runPrompt(
      { prompt: "TRY_FORBIDDEN_WRITE", cwd: tmpDir, permissionPolicy: "allow_all" },
      { scopeConfig }
    );
    assert.equal(blocked.deniedActions.length, 1);
    assert.match(blocked.deniedActions[0].reason, /Blocked by scope policy/);
    assert.match(blocked.response, /deny-1/);

    // 4. Close session unbinds from pool stats
    const closed = await pool.closeSession(r1.sessionId);
    assert.equal(closed.closed, true);
    assert.equal(pool.getPoolStats().activeWorkers, 2);

    // Sanity check helper
    assert.equal(isReadOnlyToolCall({ kind: "read", title: "view_file" }), true);
    assert.equal(isReadOnlyToolCall({ kind: "edit", title: "edit_file" }), false);
  } finally {
    pool.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MCP stdio server exposes v1.2.0 tools, validates verdictMode, and forwards notifications/progress", async () => {
  const { root, repoDir } = initTempGitRepo("orch-mcp-e2e-");
  const mockDshBin = path.join(root, "mock-dsh.sh");
  const jobsDir = path.join(root, "jobs");

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
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "mock" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-progress", configOptions: [] } });
  else if (m.method === "session/prompt") {
    const sid = m.params.sessionId;
    const text = (m.params.prompt && m.params.prompt[0] && m.params.prompt[0].text) || "";
    if (text.includes("SIMULATE_QUOTA_EXHAUSTED")) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "HTTP 429: insufficient_quota - You exceeded your current quota" } });
      return;
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "grep_search", kind: "search", status: "running" } } });
    setTimeout(() => {
      const verdict = JSON.stringify({ verdict: "ACCEPTED", summary: "All good", commands_run: [], findings: [], unverified: [] });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: verdict } } } });
      send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    }, 120);
  }
});
'
`,
    { mode: 0o755 }
  );

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DSH_BIN: mockDshBin, JOBS_DIR: jobsDir },
  });

  const pending = new Map();
  const notifications = [];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      notifications.push(msg);
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
    const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
    assert.equal(init.result.serverInfo.version, EXPECTED_VERSION);

    const listed = await rpc("tools/list", {});
    const toolNames = listed.result.tools.map((t) => t.name);
    assert.equal(toolNames.length, 11);
    for (const expected of ["worktree_create", "worktree_list", "worktree_cleanup", "codex_run", "dsh_run"]) {
      assert.ok(toolNames.includes(expected), `Missing tool ${expected}`);
    }

    // Reject verdictMode with sessionId
    const badVerdict = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "check", cwd: repoDir, verdictMode: true, sessionId: "old-sess" },
    });
    assert.equal(badVerdict.result.isError, true);
    assert.match(badVerdict.result.content[0].text, /fresh verifier context/);

    // Progress notification + parsedVerdict via sync dsh_run
    const okVerdict = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "verify repo", cwd: repoDir, verdictMode: true },
      _meta: { progressToken: "tok-42" },
    });
    assert.notEqual(okVerdict.result.isError, true);
    const body = JSON.parse(okVerdict.result.content[0].text);
    assert.equal(body.verdictMode, true);
    assert.equal(body.parsedVerdict.verdict, "ACCEPTED");

    const progNotices = notifications.filter(
      (n) => n.method === "notifications/progress" && n.params?.progressToken === "tok-42"
    );
    assert.ok(progNotices.length >= 1, "Expected at least one notifications/progress message");
    assert.equal(progNotices[0].params.progress, 1);

    // Async jobId high entropy check (16 hex chars)
    const asyncStart = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "async verify", cwd: repoDir, verdictMode: true, async: true },
    });
    const asyncBody = JSON.parse(asyncStart.result.content[0].text);
    assert.match(asyncBody.jobId, /^job-[a-z0-9]+-[0-9a-f]{16}$/);

    const polled = await rpc("tools/call", {
      name: "job_status",
      arguments: { jobId: asyncBody.jobId, waitSeconds: 5 },
      _meta: { progressToken: "tok-poll" },
    });
    const polledBody = JSON.parse(polled.result.content[0].text);
    assert.equal(polledBody.status, "completed");
    assert.equal(polledBody.result.parsedVerdict.verdict, "ACCEPTED");

    // Quota exhaustion detection: sync isError includes structured reportBeforeFallback hint
    const syncQuota = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "SIMULATE_QUOTA_EXHAUSTED", cwd: repoDir },
    });
    assert.equal(syncQuota.result.isError, true);
    assert.match(syncQuota.result.content[0].text, /"errorKind": "quota_exhausted"/);
    assert.match(syncQuota.result.content[0].text, /"reportBeforeFallback": true/);

    // Quota exhaustion detection: async job_status exposes structured errorInfo
    const asyncQuotaStart = await rpc("tools/call", {
      name: "dsh_run",
      arguments: { prompt: "SIMULATE_QUOTA_EXHAUSTED", cwd: repoDir, async: true, ignoreCooldown: true },
    });
    const asyncQuotaId = JSON.parse(asyncQuotaStart.result.content[0].text).jobId;
    const asyncQuotaPolled = await rpc("tools/call", {
      name: "job_status",
      arguments: { jobId: asyncQuotaId, waitSeconds: 5 },
    });
    const asyncQuotaBody = JSON.parse(asyncQuotaPolled.result.content[0].text);
    assert.equal(asyncQuotaBody.status, "failed");
    assert.equal(asyncQuotaBody.errorInfo.errorKind, "quota_exhausted");
    assert.equal(asyncQuotaBody.errorInfo.retryable, false);
    assert.equal(asyncQuotaBody.errorInfo.reportBeforeFallback, true);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("errors.mjs classifies quota, rate-limit, auth, timeout, and generic errors accurately", () => {
  const q1 = classifyBackendError("You exceeded your current quota, please check billing", "codex_run");
  assert.equal(q1.errorKind, "quota_exhausted");
  assert.equal(q1.backend, "codex");
  assert.equal(q1.retryable, false);
  assert.equal(q1.reportBeforeFallback, true);
  assert.match(formatMcpErrorText(q1), /reportBeforeFallback/);

  const q2 = classifyBackendError("HTTP 429 Too Many Requests: rate limit exceeded", "dsh_run");
  assert.equal(q2.errorKind, "rate_limited");
  assert.equal(q2.backend, "dsh");
  assert.equal(q2.reportBeforeFallback, true);

  const auth = classifyBackendError("401 Unauthorized: invalid api key", "codex_review");
  assert.equal(auth.errorKind, "auth_error");
  assert.equal(auth.reportBeforeFallback, true);

  const normal = classifyBackendError("SyntaxError: unexpected token", "dsh_run");
  assert.equal(normal.errorKind, "backend_error");
  assert.equal(normal.retryable, true);
  assert.equal(normal.reportBeforeFallback, false);
  assert.equal(formatMcpErrorText(normal), "Error: SyntaxError: unexpected token");
});
