import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_INLINE_LIMIT =
  Math.max(2000, Number(process.env.MAX_INLINE_RESPONSE_CHARS) || 16_000);
const MAX_STORED_OUTPUTS = 80;
const MAX_INLINE_COMMANDS = 8;
const MAX_INLINE_FILE_CHANGES = 12;
const MAX_INLINE_DSH_TOOL_CALLS = 12;

const ERROR_LINE_RE =
  /\b(error|failed|failure|exception|traceback|assertionerror|typeerror|referenceerror|syntaxerror|fatal|panic|enoent|eaddrinuse|econnrefused)\b|^\s*(?:FAIL\b|[✖✗×](?:\s|$))/i;

function pruneOutputsDir(outputsDir) {
  try {
    const files = fs
      .readdirSync(outputsDir)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".json"))
      .map((f) => {
        const full = path.join(outputsDir, f);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of files.slice(MAX_STORED_OUTPUTS)) {
      try {
        fs.unlinkSync(stale.full);
      } catch {}
    }
  } catch {}
}

function writeSpillFile(jobsDir, prefix, content, ext = "txt") {
  if (!jobsDir) return null;
  try {
    const outputsDir = path.join(jobsDir, "outputs");
    fs.mkdirSync(outputsDir, { recursive: true });
    const safePrefix = String(prefix || "output")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .slice(0, 32);
    const fileName = `${safePrefix}-${Date.now().toString(36)}-${crypto
      .randomBytes(4)
      .toString("hex")}.${ext}`;
    const fullPath = path.join(outputsDir, fileName);
    fs.writeFileSync(fullPath, content, "utf8");
    pruneOutputsDir(outputsDir);
    return fullPath;
  } catch {
    return null;
  }
}

export function countLines(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function extractMiddleErrorLines(text, headChars, tailStart, maxBudgetChars) {
  if (tailStart <= headChars || maxBudgetChars < 120) return [];
  const prefixLines = countLines(text.slice(0, headChars));
  const middle = text.slice(headChars, tailStart);
  const lines = middle.split("\n");
  const seen = new Set();
  const extracted = [];
  let usedChars = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.length < 4) continue;
    if (!ERROR_LINE_RE.test(trimmed)) continue;
    const dedupKey = trimmed.slice(0, 140);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const lineNo = prefixLines + i;
    const formatted = `L${lineNo}: ${trimmed.slice(0, 220)}`;
    if (usedChars + formatted.length + 1 > maxBudgetChars) break;
    extracted.push(formatted);
    usedChars += formatted.length + 1;
    if (extracted.length >= 8) break;
  }

  return extracted;
}

/**
 * Keeps orchestrator context lean: if a worker response exceeds `inlineLimit`,
 * persists the full verbatim text under `<jobsDir>/outputs/` and returns a
 * head + extracted error highlights + tail preview plus `outputFile` & `totalLines`
 * for on-demand `read_file`.
 */
export function spillLargeOutput(
  text,
  { jobsDir, prefix = "output", inlineLimit = DEFAULT_INLINE_LIMIT } = {}
) {
  if (typeof text !== "string") {
    return {
      text: "",
      truncated: false,
      outputFile: null,
      totalChars: 0,
      totalLines: 0,
      extractedErrorLines: 0,
    };
  }

  const totalLines = countLines(text);
  const limit =
    Number.isFinite(Number(inlineLimit)) && Number(inlineLimit) >= 1000
      ? Number(inlineLimit)
      : DEFAULT_INLINE_LIMIT;

  if (text.length <= limit) {
    return {
      text,
      truncated: false,
      outputFile: null,
      totalChars: text.length,
      totalLines,
      extractedErrorLines: 0,
    };
  }

  const outputFile = writeSpillFile(jobsDir, prefix, text, "txt");

  const errorBudget = Math.min(2000, Math.floor(limit * 0.2));
  const headChars = Math.floor(limit * 0.62);
  const tailChars = Math.max(400, limit - headChars - errorBudget);
  const tailStart = Math.max(headChars, text.length - tailChars);
  const extracted = extractMiddleErrorLines(text, headChars, tailStart, errorBudget);
  const omitted = Math.max(0, tailStart - headChars);

  const errorBlock =
    extracted.length > 0
      ? `\n--- [key error lines in omitted middle] ---\n${extracted.join("\n")}\n--- [end extracted error lines] ---\n`
      : "";

  const notice = outputFile
    ? `\n\n... [omitted ${omitted} chars of ${text.length} total (${totalLines} lines); full output saved to ${outputFile} — use read_file(StartLine, EndLine) if needed] ...${errorBlock}\n`
    : `\n\n... [omitted ${omitted} chars of ${text.length} total (${totalLines} lines)] ...${errorBlock}\n`;

  return {
    text: `${text.slice(0, headChars)}${notice}${text.slice(tailStart)}`,
    truncated: true,
    outputFile,
    totalChars: text.length,
    totalLines,
    extractedErrorLines: extracted.length,
  };
}

function isFailedCommand(c) {
  if (!c || typeof c !== "object") return false;
  if (c.status === "failed") return true;
  return typeof c.exitCode === "number" && c.exitCode !== 0;
}

function isConfirmedPassedCommand(c) {
  if (!c || typeof c !== "object") return false;
  return c.status !== "failed" && c.exitCode === 0;
}

/**
 * Compacts verbose Codex execution traces (`commands` and `fileChanges`) while
 * preserving ALL failed/non-passing commands and ALL failed patch events verbatim,
 * and spilling full logs when large. Never touches `scopeAudit`, `parsedVerdict`, or `errors`.
 */
export function compactCodexItems(fileChanges = [], commands = [], { jobsDir } = {}) {
  const safeCommands = Array.isArray(commands) ? commands : [];
  const safeFileChanges = Array.isArray(fileChanges) ? fileChanges : [];

  let outCommands = safeCommands;
  let commandsSummary;
  let commandsLogFile;

  if (safeCommands.length > MAX_INLINE_COMMANDS) {
    const failed = safeCommands.filter(isFailedCommand);
    const passed = safeCommands.filter(isConfirmedPassedCommand);
    const other = safeCommands.filter((c) => !isFailedCommand(c) && !isConfirmedPassedCommand(c));
    const recentPassed = passed.slice(-3);
    outCommands = [...failed, ...other, ...recentPassed];
    commandsSummary = {
      total: safeCommands.length,
      succeeded: passed.length,
      failed: failed.length,
      ...(other.length > 0 ? { unknown: other.length } : {}),
      omittedPassed: Math.max(0, passed.length - recentPassed.length),
    };
    const spilledPath = writeSpillFile(
      jobsDir,
      "codex-commands",
      JSON.stringify(safeCommands, null, 2),
      "json"
    );
    if (spilledPath) {
      commandsLogFile = spilledPath;
    }
  }

  let outFileChanges = safeFileChanges;
  let fileChangesSummary;
  let fileChangesLogFile;

  if (safeFileChanges.length > MAX_INLINE_FILE_CHANGES) {
    const failedChanges = safeFileChanges.filter((fc) => fc?.status === "failed");
    const nonFailedChanges = safeFileChanges.filter((fc) => fc?.status !== "failed");
    const keepNonFailedCount = Math.max(0, MAX_INLINE_FILE_CHANGES - failedChanges.length);
    const keptNonFailed = nonFailedChanges.slice(0, keepNonFailedCount);
    outFileChanges = [...failedChanges, ...keptNonFailed];
    const spilledChangesPath = writeSpillFile(
      jobsDir,
      "codex-file-changes",
      JSON.stringify(safeFileChanges, null, 2),
      "json"
    );
    if (spilledChangesPath) {
      fileChangesLogFile = spilledChangesPath;
    }
    fileChangesSummary = {
      totalEvents: safeFileChanges.length,
      failedEvents: failedChanges.length,
      omittedEvents: Math.max(0, safeFileChanges.length - outFileChanges.length),
    };
  }

  return {
    fileChanges: outFileChanges,
    ...(fileChangesSummary ? { fileChangesSummary } : {}),
    ...(fileChangesLogFile ? { fileChangesLogFile } : {}),
    commands: outCommands,
    ...(commandsSummary ? { commandsSummary } : {}),
    ...(commandsLogFile ? { commandsLogFile } : {}),
  };
}

const FAILED_TOOL_STATUS_RE = /^(failed|error|denied|rejected|cancelled|canceled|timed?_?out)$/i;
const COMPLETED_TOOL_STATUS_RE = /^(completed|succeeded|success|done|ok)$/i;

function isFailedToolCall(tc) {
  if (!tc || typeof tc !== "object") return false;
  if (tc.error) return true;
  return FAILED_TOOL_STATUS_RE.test(String(tc.status || "").trim());
}

function isCompletedToolCall(tc) {
  if (!tc || typeof tc !== "object") return false;
  return COMPLETED_TOOL_STATUS_RE.test(String(tc.status || "").trim());
}

/**
 * Compacts verbose DSH ACP `toolCalls` lists when large while retaining ALL
 * failed/denied/error calls and the most recent non-failed calls inline, and
 * spilling the full list to disk. Never touches `deniedActions`, `scopeAudit`,
 * or `parsedVerdict`.
 */
export function compactDshToolCalls(toolCalls = [], { jobsDir } = {}) {
  const safeCalls = Array.isArray(toolCalls) ? toolCalls : [];
  if (safeCalls.length <= MAX_INLINE_DSH_TOOL_CALLS) {
    return { toolCalls: safeCalls };
  }

  const failed = [];
  const nonFailed = [];
  let completedCount = 0;
  let otherCount = 0;

  for (const tc of safeCalls) {
    if (isFailedToolCall(tc)) {
      failed.push(tc);
    } else {
      nonFailed.push(tc);
      if (isCompletedToolCall(tc)) {
        completedCount += 1;
      } else {
        otherCount += 1;
      }
    }
  }

  const spilledPath = writeSpillFile(
    jobsDir,
    "dsh-tool-calls",
    JSON.stringify(safeCalls, null, 2),
    "json"
  );

  if (!spilledPath) {
    return {
      toolCalls: safeCalls,
      toolCallsSpillWarning:
        "Could not write full DSH toolCalls log to disk; kept all toolCalls inline to avoid losing trace entries.",
    };
  }

  const recentNonFailed = nonFailed.slice(-4);
  const outCalls = [...failed, ...recentNonFailed];
  const toolCallsSummary = {
    total: safeCalls.length,
    completed: completedCount,
    failed: failed.length,
    ...(otherCount > 0 ? { other: otherCount } : {}),
    omitted: Math.max(0, safeCalls.length - outCalls.length),
  };

  return {
    toolCalls: outCalls,
    toolCallsSummary,
    toolCallsLogFile: spilledPath,
  };
}
