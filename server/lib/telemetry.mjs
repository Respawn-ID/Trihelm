import fs from "node:fs";
import path from "node:path";

const MAX_DAYS_RETAINED = 30;
const COOLDOWN_TTL_MS = 6 * 60 * 60 * 1000; // 6h visibility window

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
  const model =
    args?.model ||
    result?.model ||
    (backend === "dsh" ? "default-dsh" : backend === "codex" ? "default-codex" : "default");
  return `${backend}:${String(model)}`;
}

export class TelemetryStore {
  constructor(metricsPath) {
    this.metricsPath = metricsPath;
  }

  readState() {
    const empty = { version: 1, daily: {}, cooldowns: {} };
    if (!this.metricsPath || !fs.existsSync(this.metricsPath)) return empty;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metricsPath, "utf8"));
      return {
        version: 1,
        daily: parsed && typeof parsed.daily === "object" && parsed.daily ? parsed.daily : {},
        cooldowns:
          parsed && typeof parsed.cooldowns === "object" && parsed.cooldowns
            ? parsed.cooldowns
            : {},
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
      const recordedMs = entry?.recordedAt ? Date.parse(entry.recordedAt) : 0;
      if (!recordedMs || now - recordedMs > COOLDOWN_TTL_MS) {
        delete state.cooldowns[k];
      }
    }
  }

  recordCall({
    tool,
    args = {},
    ok = true,
    durationMs = 0,
    usage = null,
    errorInfo = null,
    result = null,
  }) {
    const now = Date.now();
    const day = localDateKey(now);
    const key = resolveModelKey(tool, args, result);
    const state = this.readState();

    if (!state.daily[day]) state.daily[day] = {};
    const bucket = state.daily[day][key] || {
      calls: 0,
      succeeded: 0,
      failed: 0,
      quotaErrors: 0,
      rateLimitErrors: 0,
      authErrors: 0,
      totalDurationMs: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      lastUsedAt: null,
    };

    bucket.calls += 1;
    bucket.totalDurationMs += Math.max(0, Math.round(Number(durationMs) || 0));
    bucket.lastUsedAt = new Date(now).toISOString();

    if (ok) {
      bucket.succeeded += 1;
      if (state.cooldowns[key]) {
        delete state.cooldowns[key];
      }
    } else {
      bucket.failed += 1;
      const kind = errorInfo?.errorKind || "backend_error";
      if (kind === "quota_exhausted") bucket.quotaErrors += 1;
      else if (kind === "rate_limited") bucket.rateLimitErrors += 1;
      else if (kind === "auth_error") bucket.authErrors += 1;

      if (errorInfo?.reportBeforeFallback) {
        state.cooldowns[key] = {
          errorKind: kind,
          backend: errorInfo.backend || key.split(":")[0],
          tool,
          message: String(errorInfo.message || "").slice(0, 300),
          recordedAt: new Date(now).toISOString(),
        };
      }
    }

    if (usage && typeof usage === "object") {
      const inTok = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
      const cachedTok = Number(usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0);
      const outTok = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
      if (Number.isFinite(inTok) && inTok > 0) bucket.inputTokens += inTok;
      if (Number.isFinite(cachedTok) && cachedTok > 0) bucket.cachedInputTokens += cachedTok;
      if (Number.isFinite(outTok) && outTok > 0) bucket.outputTokens += outTok;
    }

    state.daily[day][key] = bucket;
    this.prune(state, now);
    this.writeState(state);
  }

  getSummary() {
    const now = Date.now();
    const day = localDateKey(now);
    const state = this.readState();
    this.prune(state, now);

    const todayBuckets = state.daily[day] || {};
    let totalCallsToday = 0;
    const todayByModel = {};
    for (const [k, b] of Object.entries(todayBuckets)) {
      totalCallsToday += b.calls || 0;
      todayByModel[k] = {
        ...b,
        avgDurationMs: b.calls > 0 ? Math.round((b.totalDurationMs || 0) / b.calls) : 0,
      };
    }

    return {
      metricsFile: this.metricsPath,
      date: day,
      totalCallsToday,
      todayByModel,
      activeCooldowns: state.cooldowns,
    };
  }
}
