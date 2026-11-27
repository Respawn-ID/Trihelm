const QUOTA_PATTERNS = [
  /insufficient[_\s-]*quota/i,
  /quota[_\s-]*(exceeded|exhausted|limit|depleted|reached)/i,
  /exceeded\s+(your\s+)?(current\s+)?quota/i,
  /usage[_\s-]*limit/i,
  /credit[s]?\s*(exhausted|depleted|insufficient|limit|balance\s*(is\s*)?(too\s*low|zero|0))/i,
  /out\s+of\s+(credits|quota|usage)/i,
  /billing\s*(hard\s*)?limit/i,
  /plan\s*limit/i,
  /spending\s*limit/i,
  /额度(已用尽|不足|耗尽|用完|受限)/,
  /配额(已用尽|不足|耗尽|用完|受限)/,
  /余额不足/,
];

const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[_\s-]*limit/i,
  /too\s+many\s+requests/i,
  /server[_\s-]*is[_\s-]*overloaded/i,
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /temporarily\s+unavailable/i,
  /限流/,
];

const AUTH_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /invalid[_\s-]*api[_\s-]*key/i,
  /authentication\s*(failed|required|error)/i,
  /not\s+logged\s+in/i,
  /login\s+required/i,
  /token\s*(expired|invalid)/i,
];

const TIMEOUT_PATTERNS = [/timed?\s*out/i, /\betimedout\b/i];

export function inferBackendFromTool(toolName) {
  if (!toolName || typeof toolName !== "string") return "unknown";
  if (toolName.startsWith("codex_")) return "codex";
  if (toolName.startsWith("dsh_")) return "dsh";
  return "orchestrator";
}

export function createCooldownBlockedError(check) {
  const remainingSeconds = Math.max(1, Math.ceil((check?.remainingMs || 0) / 1000));
  const kind = check?.entry?.errorKind || "quota_exhausted";
  const backend = check?.entry?.backend || String(check?.key || "unknown").split(":")[0];
  const message = `Model '${check.key}' is in active ${kind} cooldown (${remainingSeconds}s remaining; last error: ${check?.entry?.message || kind}). Pass ignoreCooldown: true to force a retry.`;
  const err = new Error(message);
  err.cooldownBlocked = true;
  err.errorInfo = {
    errorKind: kind,
    backend,
    retryable: false,
    reportBeforeFallback: true,
    cooldownBlocked: true,
    cooldownKey: check.key,
    remainingSeconds,
    expiresAt: check?.entry?.expiresAt || null,
    message,
    hint: "Model is in active cooldown from a recent quota/rate-limit error. Do NOT silently switch models; report to the user in one line and ask whether to switch to a fallback or retry with ignoreCooldown: true.",
  };
  return err;
}

export function classifyBackendError(errOrMessage, toolName = "") {
  if (errOrMessage && typeof errOrMessage === "object" && errOrMessage.errorInfo) {
    return { ...errOrMessage.errorInfo };
  }

  const isAbort =
    errOrMessage &&
    typeof errOrMessage === "object" &&
    (errOrMessage.name === "AbortError" || errOrMessage.code === "ABORT_ERR");
  const message =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage?.message || String(errOrMessage || "Unknown error");
  const backend = inferBackendFromTool(toolName);

  if (isAbort || /\bcancell?ed\b/i.test(message)) {
    return {
      errorKind: "cancelled",
      backend,
      retryable: false,
      reportBeforeFallback: false,
      message,
    };
  }

  if (QUOTA_PATTERNS.some((re) => re.test(message))) {
    return {
      errorKind: "quota_exhausted",
      backend,
      retryable: false,
      reportBeforeFallback: true,
      message,
      hint: "Backend quota exhausted. Notify the user in one line immediately; do NOT retry this backend and do NOT silently switch models—propose fallback options (avoid defaulting routine fallbacks to tighter-quota built-in Opus 5.5) and wait for confirmation.",
    };
  }

  if (RATE_LIMIT_PATTERNS.some((re) => re.test(message))) {
    return {
      errorKind: "rate_limited",
      backend,
      retryable: false,
      reportBeforeFallback: true,
      message,
      hint: "Backend rate-limited or at capacity. Do NOT loop retries and do NOT silently switch models; report to the user and ask whether to wait or switch to a recommended fallback backend.",
    };
  }

  if (AUTH_PATTERNS.some((re) => re.test(message))) {
    return {
      errorKind: "auth_error",
      backend,
      retryable: false,
      reportBeforeFallback: true,
      message,
      hint: "Backend authentication failed. Stop immediately and report to the user to re-authenticate or approve a fallback backend.",
    };
  }

  if (TIMEOUT_PATTERNS.some((re) => re.test(message))) {
    return {
      errorKind: "timeout",
      backend,
      retryable: true,
      reportBeforeFallback: false,
      message,
    };
  }

  return {
    errorKind: "backend_error",
    backend,
    retryable: true,
    reportBeforeFallback: false,
    message,
  };
}

export function formatMcpErrorText(errInfo) {
  const base = `Error: ${errInfo.message}`;
  const includeMeta = Boolean(errInfo.reportBeforeFallback || errInfo.loopWarning || errInfo.cooldownBlocked);
  if (!includeMeta) {
    return base;
  }
  const meta = {
    errorKind: errInfo.errorKind,
    backend: errInfo.backend,
    retryable: errInfo.retryable,
    reportBeforeFallback: Boolean(errInfo.reportBeforeFallback),
    ...(errInfo.cooldownBlocked
      ? {
          cooldownBlocked: true,
          cooldownKey: errInfo.cooldownKey,
          remainingSeconds: errInfo.remainingSeconds,
          expiresAt: errInfo.expiresAt,
        }
      : {}),
    ...(errInfo.hint ? { hint: errInfo.hint } : {}),
    ...(errInfo.loopWarning ? { loopWarning: errInfo.loopWarning } : {}),
  };
  return `${base}\n\n${JSON.stringify(meta, null, 2)}`;
}
