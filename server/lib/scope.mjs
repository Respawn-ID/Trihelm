import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FORBIDDEN_PATHS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".git",
  ".git/**",
  "**/.git/**",
];

const HASH_SIZE_LIMIT_BYTES = 512 * 1024;

export function toPosixPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function normalizeRelPath(rawPath, cwd) {
  if (!rawPath || typeof rawPath !== "string") return null;
  let cleaned = rawPath.trim();
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned) && cwd) {
    const rel = path.relative(safeRealpath(cwd), safeRealpath(cleaned));
    cleaned = rel;
  }
  const posix = toPosixPath(cleaned);
  return posix || ".";
}

function escapeRegex(str) {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function compilePathPattern(pattern) {
  const raw = String(pattern || "").trim();
  if (!raw) return null;
  const trailingSlash = raw.endsWith("/");
  const norm = toPosixPath(raw);
  if (!norm) return null;

  const hasGlob = /[*?]/.test(norm);
  if (!hasGlob) {
    const escaped = escapeRegex(norm);
    // Match exact file/dir or any descendant under dir boundary
    return new RegExp(`^${escaped}(?:\\/.*)?$`);
  }

  let re = "^";
  for (let i = 0; i < norm.length; i += 1) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          re += "(?:.+\\/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegex(ch);
    }
  }
  re += trailingSlash ? "(?:\\/.*)?$" : "$";
  return new RegExp(re);
}

export function resolveScopeConfig(args) {
  const allowedPaths = Array.isArray(args?.allowedPaths)
    ? args.allowedPaths.map((p) => String(p).trim()).filter(Boolean)
    : [];
  const userForbidden = Array.isArray(args?.forbiddenPaths)
    ? args.forbiddenPaths.map((p) => String(p).trim()).filter(Boolean)
    : [];
  const allowSensitiveFiles = args?.allowSensitiveFiles === true;

  const forbiddenPaths = allowSensitiveFiles
    ? [...new Set(userForbidden)]
    : [...new Set([...DEFAULT_FORBIDDEN_PATHS, ...userForbidden])];

  const allowedMatchers = allowedPaths
    .map((rule) => ({ rule, regex: compilePathPattern(rule) }))
    .filter((entry) => entry.regex);

  const forbiddenMatchers = forbiddenPaths
    .map((rule) => ({ rule, regex: compilePathPattern(rule) }))
    .filter((entry) => entry.regex);

  const hasExplicitScope = allowedPaths.length > 0 || userForbidden.length > 0;

  function checkPath(rawPath, cwd = null) {
    const rel = normalizeRelPath(rawPath, cwd);
    if (!rel) return { allowed: true, path: rel };

    if (rel === ".." || rel.startsWith("../")) {
      return {
        allowed: false,
        path: rel,
        reason: "outside_workspace",
        matchedRule: "workspace_boundary",
      };
    }

    for (const { rule, regex } of forbiddenMatchers) {
      if (regex.test(rel)) {
        return {
          allowed: false,
          path: rel,
          reason: "forbidden_path",
          matchedRule: rule,
        };
      }
    }

    if (allowedMatchers.length > 0) {
      const matched = allowedMatchers.some(({ regex }) => regex.test(rel));
      if (!matched) {
        return {
          allowed: false,
          path: rel,
          reason: "outside_allowed_paths",
          matchedRule: allowedPaths.join(", "),
        };
      }
    }

    return { allowed: true, path: rel };
  }

  return {
    enforced: hasExplicitScope || !allowSensitiveFiles,
    hasExplicitScope,
    allowSensitiveFiles,
    allowedPaths,
    forbiddenPaths,
    checkPath,
  };
}

function fingerprintFile(absPath) {
  try {
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      return `symlink:${fs.readlinkSync(absPath)}`;
    }
    if (!stat.isFile()) {
      return `nonfile:${stat.mode}`;
    }
    if (stat.size <= HASH_SIZE_LIMIT_BYTES) {
      const buf = fs.readFileSync(absPath);
      const sha1 = crypto.createHash("sha1").update(buf).digest("hex");
      return `file:${stat.size}:${sha1}`;
    }
    return `large:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

export function captureGitSnapshot(cwd) {
  try {
    const realCwd = safeRealpath(cwd);
    const repoRoot = safeRealpath(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: realCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    );

    const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    const files = new Map();
    const entries = raw.split("\0");
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const repoRel = entry.slice(3);
      const absPath = path.join(repoRoot, repoRel);
      const relToCwd = toPosixPath(path.relative(realCwd, absPath));
      files.set(relToCwd, {
        status,
        repoRel,
        fingerprint: fingerprintFile(absPath),
      });

      // Rename/copy entries carry an extra NUL-terminated original path
      if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
        const origRepoRel = entries[i + 1];
        if (origRepoRel) {
          const origAbs = path.join(repoRoot, origRepoRel);
          const origRelToCwd = toPosixPath(path.relative(realCwd, origAbs));
          files.set(origRelToCwd, {
            status: `${status}:orig`,
            repoRel: origRepoRel,
            fingerprint: fingerprintFile(origAbs),
          });
        }
        i += 1;
      }
    }

    return {
      isGitRepo: true,
      repoRoot,
      cwd: realCwd,
      files,
    };
  } catch (err) {
    return {
      isGitRepo: false,
      cwd,
      reason: err?.message?.split("\n")[0] || "Not a git repository",
      files: new Map(),
    };
  }
}

export function diffGitSnapshots(before, after) {
  if (!before?.isGitRepo || !after?.isGitRepo) return [];
  const changed = new Set();

  for (const [relPath, afterMeta] of after.files.entries()) {
    const beforeMeta = before.files.get(relPath);
    if (!beforeMeta) {
      changed.add(relPath);
    } else if (
      beforeMeta.status !== afterMeta.status ||
      beforeMeta.fingerprint !== afterMeta.fingerprint
    ) {
      changed.add(relPath);
    }
  }

  for (const [relPath, beforeMeta] of before.files.entries()) {
    if (!after.files.has(relPath)) {
      // File was reverted/deleted/staged away during the turn
      const absPath = path.resolve(after.cwd, relPath);
      const currentFp = fingerprintFile(absPath);
      if (currentFp !== beforeMeta.fingerprint) {
        changed.add(relPath);
      }
    }
  }

  return Array.from(changed).sort();
}

function computeDiffStat(cwd, repoRoot, changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { totalAdded: 0, totalDeleted: 0, files: [] };
  }

  const byRel = new Map();
  const realCwd = safeRealpath(cwd);
  const realRoot = safeRealpath(repoRoot);

  try {
    const numstat = execFileSync("git", ["diff", "HEAD", "--numstat", "-z"], {
      cwd: realRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    const parts = numstat.split("\0");
    for (let i = 0; i < parts.length; i += 1) {
      const entry = parts[i];
      if (!entry) continue;
      const tabParts = entry.split("\t");
      if (tabParts.length < 3) continue;
      const [addStr, delStr, repoRel] = tabParts;
      let targetRepoRel = repoRel;
      if (!targetRepoRel && parts[i + 1] && parts[i + 2]) {
        targetRepoRel = parts[i + 2];
        i += 2;
      }
      if (!targetRepoRel) continue;
      const relToCwd = toPosixPath(path.relative(realCwd, path.join(realRoot, targetRepoRel)));
      const binary = addStr === "-" || delStr === "-";
      byRel.set(relToCwd, {
        path: relToCwd,
        added: binary ? 0 : Number(addStr) || 0,
        deleted: binary ? 0 : Number(delStr) || 0,
        ...(binary ? { binary: true } : {}),
      });
    }
  } catch {}

  const files = [];
  let totalAdded = 0;
  let totalDeleted = 0;

  for (const relPath of changedFiles) {
    let entry = byRel.get(relPath);
    if (!entry) {
      const absPath = path.resolve(realCwd, relPath);
      let added = 0;
      let binary = false;
      try {
        const stat = fs.lstatSync(absPath);
        if (stat.isFile()) {
          if (stat.size <= HASH_SIZE_LIMIT_BYTES) {
            const buf = fs.readFileSync(absPath);
            if (buf.includes(0)) {
              binary = true;
            } else {
              const text = buf.toString("utf8");
              added = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
            }
          } else {
            binary = true;
          }
        }
      } catch {}
      entry = { path: relPath, added, deleted: 0, ...(binary ? { binary: true } : {}) };
    }
    totalAdded += entry.added || 0;
    totalDeleted += entry.deleted || 0;
    files.push(entry);
  }

  return { totalAdded, totalDeleted, files };
}

export function auditScopeAfterRun(cwd, beforeSnapshot, scopeConfig) {
  if (!beforeSnapshot?.isGitRepo) {
    return {
      enforced: false,
      reason: beforeSnapshot?.reason || "Not a git repository",
      allowedPaths: scopeConfig.allowedPaths,
      forbiddenPaths: scopeConfig.forbiddenPaths,
      changedFiles: [],
      diffStat: { totalAdded: 0, totalDeleted: 0, files: [] },
      violations: [],
    };
  }

  const afterSnapshot = captureGitSnapshot(cwd);
  if (!afterSnapshot.isGitRepo) {
    return {
      enforced: false,
      reason: afterSnapshot.reason || "Unable to read git status after run",
      allowedPaths: scopeConfig.allowedPaths,
      forbiddenPaths: scopeConfig.forbiddenPaths,
      changedFiles: [],
      diffStat: { totalAdded: 0, totalDeleted: 0, files: [] },
      violations: [],
    };
  }

  const changedFiles = diffGitSnapshots(beforeSnapshot, afterSnapshot);
  const violations = [];
  for (const relPath of changedFiles) {
    const check = scopeConfig.checkPath(relPath, null);
    if (!check.allowed) {
      violations.push({
        path: relPath,
        reason: check.reason,
        matchedRule: check.matchedRule,
      });
    }
  }

  const diffStat = computeDiffStat(afterSnapshot.cwd, afterSnapshot.repoRoot, changedFiles);

  return {
    enforced: true,
    allowedPaths: scopeConfig.allowedPaths,
    forbiddenPaths: scopeConfig.forbiddenPaths,
    changedFiles,
    diffStat,
    violations,
  };
}

export function extractPathsFromToolCall(toolCall, cwd) {
  const found = new Set();
  const add = (val) => {
    if (typeof val !== "string") return;
    const norm = normalizeRelPath(val, cwd);
    if (norm) found.add(norm);
  };

  if (Array.isArray(toolCall?.locations)) {
    for (const loc of toolCall.locations) {
      add(loc?.path || loc?.uri?.replace(/^file:\/\//, ""));
    }
  }

  const input = toolCall?.rawInput || toolCall?.input || toolCall?.arguments;
  if (input && typeof input === "object") {
    for (const key of [
      "path",
      "file_path",
      "filePath",
      "target_file",
      "targetFile",
      "targetPath",
      "destination",
      "source",
      "old_path",
      "new_path",
    ]) {
      add(input[key]);
    }
    for (const arrKey of ["paths", "files"]) {
      if (Array.isArray(input[arrKey])) {
        for (const item of input[arrKey]) add(item);
      }
    }
  }

  return Array.from(found);
}
