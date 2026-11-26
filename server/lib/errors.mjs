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

export function classifyBackendError(errOrMessage, toolName = "") {
  const isAbort = errOrMessage && typeof errOrMessage === "object" && errOrMessage.name === "AbortError";
  const message =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage?.message || String(errOrMessage || "Unknown error");
  const backend = inferBackendFromTool(toolName);

  if (isAbort || /\bcancelled\b/i.test(message)) {
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
  if (!errInfo.reportBeforeFallback) {
    return base;
  }
  const meta = {
    errorKind: errInfo.errorKind,
    backend: errInfo.backend,
    retryable: errInfo.retryable,
    reportBeforeFallback: errInfo.reportBeforeFallback,
    hint: errInfo.hint,
  };
  return `${base}\n\n${JSON.stringify(meta, null, 2)}`;
}
