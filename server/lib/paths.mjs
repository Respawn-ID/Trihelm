import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isExistingFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function findInPath(
  names,
  { env = process.env, platform = process.platform } = {}
) {
  const pathVar = env?.PATH || env?.Path || "";
  if (!pathVar) return null;

  const sep = platform === "win32" ? ";" : ":";
  const dirs = pathVar
    .split(sep)
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  const candidates = Array.isArray(names) ? names : [names];
  const exts =
    platform === "win32"
      ? (env?.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const name of candidates) {
      if (platform === "win32") {
        const direct = path.join(dir, name);
        if (isExistingFile(direct)) return direct;
        for (const ext of exts) {
          const withExt = path.join(dir, `${name}${ext.toLowerCase()}`);
          if (isExistingFile(withExt)) return withExt;
          const withUpper = path.join(dir, `${name}${ext.toUpperCase()}`);
          if (isExistingFile(withUpper)) return withUpper;
        }
      } else {
        const full = path.join(dir, name);
        if (isExistingFile(full)) return full;
      }
    }
  }
  return null;
}

function firstExisting(paths) {
  for (const p of paths) {
    if (isExistingFile(p)) return p;
  }
  return null;
}

export function resolveCodexBin({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const explicit = env?.CODEX_BIN?.trim();
  if (explicit) return explicit;

  const fromPath = findInPath(
    platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"],
    { env, platform }
  );
  if (fromPath) return fromPath;

  const fallbacks =
    platform === "win32"
      ? [
          path.join(env?.APPDATA || path.join(homeDir, "AppData", "Roaming"), "npm", "codex.cmd"),
          path.join(
            env?.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"),
            "Programs",
            "codex",
            "codex.exe"
          ),
          path.join(homeDir, ".local", "bin", "codex.exe"),
        ]
      : [
          path.join(homeDir, ".local", "bin", "codex"),
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          path.join(homeDir, ".npm-global", "bin", "codex"),
          path.join(homeDir, ".volta", "bin", "codex"),
          path.join(homeDir, ".asdf", "shims", "codex"),
        ];

  return firstExisting(fallbacks) || "codex";
}

export function resolveDshBin({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const explicit = env?.DSH_BIN?.trim();
  if (explicit) return explicit;

  const fromPath = findInPath(
    platform === "win32" ? ["dsh.exe", "dsh.cmd", "dsh"] : ["dsh"],
    { env, platform }
  );
  if (fromPath) return fromPath;

  const fallbacks =
    platform === "darwin"
      ? [
          "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
          path.join(
            homeDir,
            "Applications",
            "DeepSeek Harness.app",
            "Contents",
            "Resources",
            "runtime",
            "cli",
            "bin",
            "dsh"
          ),
          path.join(homeDir, ".local", "bin", "dsh"),
          "/opt/homebrew/bin/dsh",
          "/usr/local/bin/dsh",
        ]
      : platform === "win32"
        ? [
            path.join(
              env?.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"),
              "Programs",
              "DeepSeek Harness",
              "resources",
              "runtime",
              "cli",
              "bin",
              "dsh.exe"
            ),
            path.join(homeDir, ".local", "bin", "dsh.exe"),
          ]
        : [
            path.join(homeDir, ".local", "bin", "dsh"),
            "/usr/local/bin/dsh",
            "/opt/deepseek-harness/dsh",
          ];

  return firstExisting(fallbacks) || "dsh";
}

export function buildRuntimePath({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  extraDirs = [],
} = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const current = (env?.PATH || env?.Path || "")
    .split(sep)
    .map((d) => d.trim())
    .filter(Boolean);

  const defaults =
    platform === "win32"
      ? [path.join(homeDir, ".local", "bin")]
      : [
          path.join(homeDir, ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ];

  const merged = [];
  const seen = new Set();
  for (const dir of [...extraDirs, ...current, ...defaults]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(sep);
}
