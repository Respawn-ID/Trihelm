export const VERDICT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["verdict", "summary", "commands_run", "findings", "unverified"],
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["ACCEPTED", "REJECTED"],
      description: "Final binary verdict. Use ACCEPTED only when all cited paths, line numbers, and verification commands hold.",
    },
    summary: {
      type: "string",
      description: "Concise, factual summary (max 15 lines, no fluff or 'looks good').",
    },
    commands_run: {
      type: "array",
      items: {
        type: "object",
        required: ["command", "exit_code", "output_tail"],
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          exit_code: { type: "integer" },
          output_tail: { type: "string" },
        },
      },
      description: "Commands actually executed during verification with exit code and last 10-20 lines of output.",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "line_start", "line_end", "evidence", "fix"],
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          file: { type: "string", description: "Repository-relative file path." },
          line_start: { type: "integer", description: "1-based starting line number." },
          line_end: { type: "integer", description: "1-based ending line number." },
          evidence: { type: "string", description: "Concrete observed code or command output backing this finding." },
          fix: { type: "string", description: "Actionable remediation directive." },
        },
      },
    },
    unverified: {
      type: "array",
      items: { type: "string" },
      description: "Anything that could not be executed or measured, explicitly marked 'not measured'.",
    },
  },
};

const VERDICT_RULES_CORE = [
  "--- VERIFIER PROTOCOL (STRICT READ-ONLY) ---",
  "1. You review only; never modify files.",
  "2. Verify BOTH requirement/acceptance coverage (every requested behavior and acceptance criterion is satisfied without missing cases or unintended scope drift) AND code quality (bugs, edge cases, regressions, security) in this single pass.",
  "3. Open every cited or modified file before making claims. Anchor every finding to a repo-relative file path and 1-based line_start/line_end.",
  "4. Re-run relevant verification commands (tests/typecheck/lint) when allowed in read-only mode and include exact exit_code + last 10-20 lines of output in commands_run.",
  "5. Never invent metrics or claims. Anything not directly executed or inspected must be listed in unverified as 'not measured'.",
  "6. Return verdict='ACCEPTED' only when no blocking (critical/high) issues exist and all acceptance criteria and evidence hold; otherwise return verdict='REJECTED' with concrete fixes. Never write vague praise like 'looks good'.",
].join("\n");

const VERDICT_DSH_JSON_SUFFIX = [
  VERDICT_RULES_CORE,
  "7. Your FINAL response MUST be a single valid JSON object (no surrounding prose) matching this exact shape:",
  JSON.stringify(
    {
      verdict: "ACCEPTED | REJECTED",
      summary: "string",
      commands_run: [{ command: "string", exit_code: 0, output_tail: "string" }],
      findings: [
        {
          severity: "critical | high | medium | low",
          file: "relative/path.ext",
          line_start: 1,
          line_end: 1,
          evidence: "string",
          fix: "string",
        },
      ],
      unverified: ["not measured: ..."],
    },
    null,
    2
  ),
].join("\n");

export function prepareVerdictArgs(backend, args) {
  if (!args?.verdictMode) {
    return {
      active: false,
      prompt: args?.prompt,
      outputSchema: args?.outputSchema,
      sandboxMode: args?.sandboxMode,
      permissionPolicy: args?.permissionPolicy,
    };
  }

  if (backend === "codex") {
    if (args.threadId) {
      throw new Error(
        "verdictMode requires a fresh verifier context: do not pass `threadId` when `verdictMode: true`."
      );
    }
    if (args.sandboxMode && args.sandboxMode !== "read-only") {
      throw new Error(
        `verdictMode enforces read-only verification: sandboxMode='${args.sandboxMode}' is not allowed.`
      );
    }
    return {
      active: true,
      sandboxMode: "read-only",
      prompt: `${args.prompt}\n\n${VERDICT_RULES_CORE}`,
      outputSchema:
        args.outputSchema && typeof args.outputSchema === "object"
          ? args.outputSchema
          : VERDICT_OUTPUT_SCHEMA,
    };
  }

  if (backend === "dsh") {
    if (args.sessionId) {
      throw new Error(
        "verdictMode requires a fresh verifier context: do not pass `sessionId` when `verdictMode: true`."
      );
    }
    if (args.permissionPolicy && args.permissionPolicy !== "read_only") {
      throw new Error(
        `verdictMode enforces read-only verification: permissionPolicy='${args.permissionPolicy}' is not allowed.`
      );
    }
    return {
      active: true,
      permissionPolicy: "read_only",
      prompt: `${args.prompt}\n\n${VERDICT_DSH_JSON_SUFFIX}`,
    };
  }

  throw new Error(`Unsupported verdict backend: ${backend}`);
}

export function validateVerdictObject(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, warning: "Verdict payload is not a JSON object." };
  }
  if (obj.verdict !== "ACCEPTED" && obj.verdict !== "REJECTED") {
    return { ok: false, warning: `Invalid verdict value: ${JSON.stringify(obj.verdict)}` };
  }
  if (typeof obj.summary !== "string") {
    return { ok: false, warning: "Missing string field `summary`." };
  }
  if (!Array.isArray(obj.commands_run) || !Array.isArray(obj.findings) || !Array.isArray(obj.unverified)) {
    return { ok: false, warning: "Fields `commands_run`, `findings`, and `unverified` must be arrays." };
  }
  const blockingCount = obj.findings.filter(
    (f) => f && typeof f === "object" && /^(critical|high)$/i.test(String(f.severity || "").trim())
  ).length;
  if (obj.verdict === "ACCEPTED" && blockingCount > 0) {
    return {
      ok: true,
      verdict: {
        ...obj,
        verdict: "REJECTED",
        originalVerdict: "ACCEPTED",
      },
      consistencyWarning: `Verifier returned ACCEPTED despite ${blockingCount} blocking (critical/high) finding(s); downgraded to REJECTED.`,
    };
  }
  return { ok: true, verdict: obj };
}

export function parseVerdictResponse(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, warning: "Empty response text." };
  }

  const trimmed = text.trim();
  const candidates = [trimmed];

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastErr = "No JSON object found in response.";
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      const checked = validateVerdictObject(parsed);
      if (checked.ok) return checked;
      lastErr = checked.warning;
    } catch (err) {
      lastErr = err.message;
    }
  }

  return { ok: false, warning: `Failed to parse structured verdict JSON: ${lastErr}` };
}
