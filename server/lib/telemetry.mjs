import fs from "node:fs";
import path from "node:path";

const MAX_DAYS_RETAINED = 30;
const MAX_TASKS_RETAINED = 100;
const MAX_LOOPS_RETAINED = 100;
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const LOOP_TTL_MS = 2 * 60 * 60 * 1000;

export const COOLDOWN_POLICY = {
  rate_limited: { ttlMs: 3 * 60 * 1000, blocksDispatch: true },
  quota_exhausted: { ttlMs: 30 * 60 * 1000, blocksDispatch: true },
  auth_error: { ttlMs: 15 * 60 * 1000, blocksDispatch: false },
};

const NON_LOOP_ERROR_KINDS = new Set([
  "quota_exhausted",
  "rate_limited",
  "auth_error",
  "cancelled",
]);

function toNullProtoDict(obj) {
  const dict = Object.create(null);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (k === "__proto__" || k === "prototype") continue;
      dict[k] = v;
    }
  }
  return dict;
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function localDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveModelKey(tool, args = {}, result = null) {
  const backend = tool?.startsWith("codex_")
    ? "codex"
    : tool?.startsWith("dsh_")
      ? "dsh"
      : "orchestrator";
  const rawModel =
    args?.model ||
    result?.model ||
    (backend === "dsh" ? process.env.DSH_DEFAULT_MODEL || "" : "");
  const model =
    rawModel ||
    (backend === "dsh" ? "default-dsh" : backend === "codex" ? "default-codex" : "default");

  if (backend === "dsh") {
    const provider = String(
      args?.provider || result?.provider || process.env.DSH_DEFAULT_PROVIDER || ""
    ).trim();
    if (provider) {
      return `dsh:${provider}/${String(model)}`;
    }
  }

  return `${backend}:${String(model)}`;
}

export function normalizeErrorFingerprint(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function resolveCooldownExpiryMs(entry) {
  if (entry?.expiresAt) {
    const parsed = Date.parse(entry.expiresAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const recordedMs = entry?.recordedAt ? Date.parse(entry.recordedAt) : 0;
  if (!recordedMs) return 0;
  const fallbackTtl =
    COOLDOWN_POLICY[entry?.errorKind]?.ttlMs ?? COOLDOWN_POLICY.quota_exhausted.ttlMs;
  return recordedMs + fallbackTtl;
}

function resolveLoopScopeKey(args = {}) {
  if (args?.taskId && typeof args.taskId === "string" && args.taskId.trim()) {
    return `task:${args.taskId.trim()}`;
  }
  const cwd = args?.cwd ? path.resolve(String(args.cwd)) : process.cwd();
  return `cwd:${cwd}`;
}

export class TelemetryStore {
  constructor(metricsPath) {
    this.metricsPath = metricsPath;
  }

  readState() {
    const empty = {
      version: 2,
      daily: Object.create(null),
      cooldowns: Object.create(null),
      tasks: Object.create(null),
      loops: Object.create(null),
    };
    if (!this.metricsPath || !fs.existsSync(this.metricsPath)) return empty;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metricsPath, "utf8"));
      const daily = toNullProtoDict(parsed?.daily);
      for (const dayKey of Object.keys(daily)) {
        daily[dayKey] = toNullProtoDict(daily[dayKey]);
      }
      return {
        version: 2,
        daily,
        cooldowns: toNullProtoDict(parsed?.cooldowns),
        tasks: toNullProtoDict(parsed?.tasks),
        loops: toNullProtoDict(parsed?.loops),
      };
    } catch {
      return empty;
    }
  }

  writeState(state) {
    if (!this.metricsPath) return;
    try {
      fs.mkdirSync(path.dirname(this.metricsPath), { recursive: true });
      const tmp = `${this.metricsPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmp, this.metricsPath);
    } catch {}
  }

  prune(state, now = Date.now()) {
    const days = Object.keys(state.daily).sort();
    while (days.length > MAX_DAYS_RETAINED) {
      const oldest = days.shift();
      delete state.daily[oldest];
    }

    for (const [k, entry] of Object.entries(state.cooldowns)) {
      const expiresMs = resolveCooldownExpiryMs(entry);
      if (!expiresMs || now >= expiresMs) {
        delete state.cooldowns[k];
      }
    }

    for (const [k, entry] of Object.entries(state.tasks)) {
      const updatedMs = entry?.updatedAt ? Date.parse(entry.updatedAt) : 0;
      if (!updatedMs || now - updatedMs > TASK_TTL_MS) {
        delete state.tasks[k];
      }
    }
    const remainingTasks = Object.entries(state.tasks).sort(
      (a, b) => Date.parse(b[1]?.updatedAt || 0) - Date.parse(a[1]?.updatedAt || 0)
    );
    for (const [staleKey] of remainingTasks.slice(MAX_TASKS_RETAINED)) {
      delete state.tasks[staleKey];
    }

    for (const [k, entry] of Object.entries(state.loops)) {
      const updatedMs = entry?.updatedAt ? Date.parse(entry.updatedAt) : 0;
      if (!updatedMs || now - updatedMs > LOOP_TTL_MS) {
        delete state.loops[k];
      }
    }
    const remainingLoops = Object.entries(state.loops).sort(
      (a, b) => Date.parse(b[1]?.updatedAt || 0) - Date.parse(a[1]?.updatedAt || 0)
    );
    for (const [staleKey] of remainingLoops.slice(MAX_LOOPS_RETAINED)) {
      delete state.loops[staleKey];
    }
  }

  checkCooldown(tool, args = {}, now = Date.now()) {
    const key = resolveModelKey(tool, args);
    const state = this.readState();
    this.prune(state, now);
    const entry = hasOwn(state.cooldowns, key) ? state.cooldowns[key] : null;
    if (!entry) {
      return { blocked: false, advisory: false, key, entry: null, remainingMs: 0 };
    }
    const expiresMs = resolveCooldownExpiryMs(entry);
    const remainingMs = Math.max(0, expiresMs - now);
    if (remainingMs <= 0) {
      return { blocked: false, advisory: false, key, entry: null, remainingMs: 0 };
    }
    const policy = COOLDOWN_POLICY[entry.errorKind] || { blocksDispatch: true };
    const blocksDispatch =
      typeof entry.blocksDispatch === "boolean" ? entry.blocksDispatch : policy.blocksDispatch;
    return {
      blocked: blocksDispatch,
      advisory: !blocksDispatch,
      key,
      entry,
      remainingMs,
    };
  }

  recordCall({
    tool,
    args = {},
    ok = true,
    durationMs = 0,
    usage = null,
    errorInfo = null,
    result = null,
    now = Date.now(),
  }) {
    const day = localDateKey(now);
    const key = resolveModelKey(tool, args, result);
    const state = this.readState();
    this.prune(state, now);

    if (!hasOwn(state.daily, day)) state.daily[day] = Object.create(null);
    const bucket = hasOwn(state.daily[day], key)
      ? state.daily[day][key]
      : {
          calls: 0,
          succeeded: 0,
          failed: 0,
          reworkCalls: 0,
          verdictRejections: 0,
          quotaErrors: 0,
          rateLimitErrors: 0,
          authErrors: 0,
          totalDurationMs: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          lastUsedAt: null,
        };
    if (typeof bucket.reworkCalls !== "number") bucket.reworkCalls = 0;
    if (typeof bucket.verdictRejections !== "number") bucket.verdictRejections = 0;

    const dur = Math.max(0, Math.round(Number(durationMs) || 0));
    bucket.calls += 1;
    bucket.totalDurationMs += dur;
    bucket.lastUsedAt = new Date(now).toISOString();

    const inTok = Number(usage?.input_tokens ?? usage?.inputTokens ?? 0);
    const cachedTok = Number(usage?.cached_input_tokens ?? usage?.cachedInputTokens ?? 0);
    const outTok = Number(usage?.output_tokens ?? usage?.outputTokens ?? 0);
    if (Number.isFinite(inTok) && inTok > 0) bucket.inputTokens += inTok;
    if (Number.isFinite(cachedTok) && cachedTok > 0) bucket.cachedInputTokens += cachedTok;
    if (Number.isFinite(outTok) && outTok > 0) bucket.outputTokens += outTok;

    const verdictValue = result?.parsedVerdict?.verdict || null;
    const isVerdictRejected = ok && verdictValue === "REJECTED";
    const isVerdictAccepted = ok && verdictValue === "ACCEPTED";
    if (isVerdictRejected) {
      bucket.verdictRejections += 1;
    }

    if (ok) {
      bucket.succeeded += 1;
      if (hasOwn(state.cooldowns, key)) {
        delete state.cooldowns[key];
      }
    } else {
      bucket.failed += 1;
      const kind = errorInfo?.errorKind || "backend_error";
      if (kind === "quota_exhausted") bucket.quotaErrors += 1;
      else if (kind === "rate_limited") bucket.rateLimitErrors += 1;
      else if (kind === "auth_error") bucket.authErrors += 1;

      if (errorInfo?.reportBeforeFallback) {
        const policy = COOLDOWN_POLICY[kind] || COOLDOWN_POLICY.quota_exhausted;
        const existing = hasOwn(state.cooldowns, key) ? state.cooldowns[key] : null;
        const existingExpiresMs = existing ? resolveCooldownExpiryMs(existing) : 0;
        const existingBlocking =
          Boolean(existing) && existing.blocksDispatch !== false && existingExpiresMs > now;

        if (!policy.blocksDispatch && existingBlocking) {
          // Preserve an active blocking quota/rate-limit cooldown; attach advisory note only
          existing.lastAdvisoryError = {
            errorKind: kind,
            message: String(errorInfo.message || "").slice(0, 300),
            recordedAt: new Date(now).toISOString(),
          };
        } else {
          state.cooldowns[key] = {
            errorKind: kind,
            backend: errorInfo.backend || key.split(":")[0],
            tool,
            blocksDispatch: policy.blocksDispatch,
            message: String(errorInfo.message || "").slice(0, 300),
            recordedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + policy.ttlMs).toISOString(),
          };
        }
      }
    }

    // Task attempt & rework tracking (when taskId is provided)
    let taskSummary = null;
    const rawTaskId =
      typeof args?.taskId === "string" && args.taskId.trim() ? args.taskId.trim() : null;
    if (rawTaskId && rawTaskId !== "__proto__" && rawTaskId !== "prototype") {
      const task = hasOwn(state.tasks, rawTaskId)
        ? state.tasks[rawTaskId]
        : {
            taskId: rawTaskId,
            attempts: 0,
            reworkAttempts: 0,
            verdictRejections: 0,
            totalDurationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            modelsUsed: [],
            acceptance: null,
            lastTool: null,
            lastStatus: null,
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
          };
      task.attempts += 1;
      if (task.attempts > 1 && !args?.verdictMode) {
        task.reworkAttempts += 1;
        bucket.reworkCalls += 1;
      }
      if (isVerdictRejected) {
        task.verdictRejections += 1;
      }
      task.totalDurationMs += dur;
      if (Number.isFinite(inTok) && inTok > 0) task.inputTokens += inTok;
      if (Number.isFinite(outTok) && outTok > 0) task.outputTokens += outTok;
      if (!Array.isArray(task.modelsUsed)) task.modelsUsed = [];
      if (!task.modelsUsed.includes(key)) {
        task.modelsUsed.push(key);
      }
      if (typeof args?.acceptance === "string" && args.acceptance.trim()) {
        task.acceptance = args.acceptance.trim().slice(0, 300);
      }
      task.lastTool = tool;
      task.lastStatus = !ok
        ? errorInfo?.errorKind || "failed"
        : verdictValue
          ? `verdict_${verdictValue.toLowerCase()}`
          : "completed";
      task.updatedAt = new Date(now).toISOString();
      state.tasks[rawTaskId] = task;

      taskSummary = {
        taskId: task.taskId,
        attempt: task.attempts,
        reworkAttempts: task.reworkAttempts,
        verdictRejections: task.verdictRejections,
        lastStatus: task.lastStatus,
      };
    }

    // Programmatic loop detection (tracks execution error streaks and verdict rejection streaks
    // independently so successful rework turns do NOT erase a verdict REJECTED streak;
    // strictly excludes quota/rate-limit/auth/cancel errors).
    let loopStatus = null;
    const scopeKey = resolveLoopScopeKey(args);
    const errorLoopKey = `err|${scopeKey}`;
    const verdictLoopKey = `verdict|${scopeKey}`;

    if (!ok) {
      const kind = errorInfo?.errorKind || "backend_error";
      if (!NON_LOOP_ERROR_KINDS.has(kind)) {
        const fingerprint = `err:${normalizeErrorFingerprint(errorInfo?.message || kind)}`;
        const prev = hasOwn(state.loops, errorLoopKey) ? state.loops[errorLoopKey] : null;
        const consecutiveFailures =
          prev && prev.reason === "repeated_error" && prev.fingerprint === fingerprint
            ? prev.consecutiveFailures + 1
            : 1;
        state.loops[errorLoopKey] = {
          scopeKey,
          reason: "repeated_error",
          fingerprint,
          consecutiveFailures,
          lastTool: tool,
          lastModel: key,
          updatedAt: new Date(now).toISOString(),
        };
        if (consecutiveFailures >= 2) {
          loopStatus = {
            loopDetected: true,
            reason: "repeated_error",
            consecutiveFailures,
            scopeKey,
            hint: "Same blocker failed >= 2 consecutive times. Stop retrying blindly; report to the user in one line and escalate or pause.",
          };
        }
      }
    } else if (isVerdictRejected) {
      if (hasOwn(state.loops, errorLoopKey)) {
        delete state.loops[errorLoopKey];
      }
      const prev = hasOwn(state.loops, verdictLoopKey) ? state.loops[verdictLoopKey] : null;
      const consecutiveFailures =
        prev && prev.reason === "verdict_rejected" ? prev.consecutiveFailures + 1 : 1;
      state.loops[verdictLoopKey] = {
        scopeKey,
        reason: "verdict_rejected",
        fingerprint: "verdict_rejected",
        consecutiveFailures,
        lastTool: tool,
        lastModel: key,
        updatedAt: new Date(now).toISOString(),
      };
      if (consecutiveFailures >= 2) {
        loopStatus = {
          loopDetected: true,
          reason: "verdict_rejected",
          consecutiveFailures,
          scopeKey,
          hint: "Independent review rejected this task >= 2 consecutive times. Stop the rework loop; report to the user in one line and escalate or pause.",
        };
      }
    } else {
      // Successful run clears execution error streak; only ACCEPTED verdict clears verdict rejection streak
      if (hasOwn(state.loops, errorLoopKey)) {
        delete state.loops[errorLoopKey];
      }
      if (isVerdictAccepted && hasOwn(state.loops, verdictLoopKey)) {
        delete state.loops[verdictLoopKey];
      }
    }

    state.daily[day][key] = bucket;
    this.prune(state, now);
    this.writeState(state);

    return { key, taskSummary, loopStatus };
  }

  getSummary(now = Date.now()) {
    const day = localDateKey(now);
    const state = this.readState();
    this.prune(state, now);

    const todayBuckets = hasOwn(state.daily, day) ? state.daily[day] : {};
    let totalCallsToday = 0;
    let reworkCallsToday = 0;
    let verdictRejectionsToday = 0;
    const todayByModel = {};
    for (const [k, b] of Object.entries(todayBuckets)) {
      totalCallsToday += b.calls || 0;
      reworkCallsToday += b.reworkCalls || 0;
      verdictRejectionsToday += b.verdictRejections || 0;
      todayByModel[k] = {
        ...b,
        avgDurationMs: b.calls > 0 ? Math.round((b.totalDurationMs || 0) / b.calls) : 0,
      };
    }

    const activeLoops = Object.values(state.loops)
      .filter((entry) => entry && entry.consecutiveFailures >= 2)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));

    const recentTasks = Object.values(state.tasks)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, 10);

    return {
      metricsFile: this.metricsPath,
      date: day,
      totalCallsToday,
      reworkCallsToday,
      verdictRejectionsToday,
      todayByModel,
      activeCooldowns: { ...state.cooldowns },
      ...(activeLoops.length > 0 ? { activeLoops } : {}),
      ...(recentTasks.length > 0 ? { recentTasks } : {}),
    };
  }
}
