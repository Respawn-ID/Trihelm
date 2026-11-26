import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_INLINE_LIMIT =
  Math.max(2000, Number(process.env.MAX_INLINE_RESPONSE_CHARS) || 16_000);
const MAX_STORED_OUTPUTS = 80;

function pruneOutputsDir(outputsDir) {
  try {
    const files = fs
      .readdirSync(outputsDir)
      .filter((f) => f.endsWith(".txt"))
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

/**
 * Keeps orchestrator context lean: if a worker response exceeds `inlineLimit`,
 * persists the full verbatim text under `<jobsDir>/outputs/` and returns a
 * head+tail preview plus `outputFile` path for on-demand `read_file`.
 */
export function spillLargeOutput(
  text,
  { jobsDir, prefix = "output", inlineLimit = DEFAULT_INLINE_LIMIT } = {}
) {
  if (typeof text !== "string") {
    return { text: "", truncated: false, outputFile: null, totalChars: 0 };
  }

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
    };
  }

  let outputFile = null;
  if (jobsDir) {
    try {
      const outputsDir = path.join(jobsDir, "outputs");
      fs.mkdirSync(outputsDir, { recursive: true });
      const safePrefix = String(prefix || "output")
        .replace(/[^a-z0-9_-]+/gi, "-")
        .slice(0, 32);
      const fileName = `${safePrefix}-${Date.now().toString(36)}-${crypto
        .randomBytes(4)
        .toString("hex")}.txt`;
      outputFile = path.join(outputsDir, fileName);
      fs.writeFileSync(outputFile, text, "utf8");
      pruneOutputsDir(outputsDir);
    } catch {
      outputFile = null;
    }
  }

  const headChars = Math.floor(limit * 0.68);
  const tailChars = Math.max(400, limit - headChars);
  const omitted = Math.max(0, text.length - headChars - tailChars);
  const notice = outputFile
    ? `\n\n... [omitted ${omitted} chars of ${text.length} total; full output saved to ${outputFile} — use read_file if needed] ...\n\n`
    : `\n\n... [omitted ${omitted} chars of ${text.length} total] ...\n\n`;

  return {
    text: `${text.slice(0, headChars)}${notice}${text.slice(text.length - tailChars)}`,
    truncated: true,
    outputFile,
    totalChars: text.length,
  };
}
