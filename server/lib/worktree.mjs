import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const WORKTREES_DIR_NAME = ".codex-dsh-worktrees";
const MANIFEST_FILE_NAME = ".manifest.json";
const ENV_FILE_RE = /^\.env(\..+)?$/;
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/i;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
}

function resolveGitRepoRoot(repoCwd) {
  const target = repoCwd ? path.resolve(repoCwd) : process.cwd();
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error(`Repository directory does not exist: ${target}`);
  }
  let topLevel;
  try {
    topLevel = git(["rev-parse", "--show-toplevel"], target).trim();
  } catch (err) {
    throw new Error(`Not a git repository: ${target} (${err?.stderr?.toString()?.trim() || err.message})`);
  }
  return fs.realpathSync(topLevel);
}

function getWorktreesRoot(repoRoot) {
  return path.join(path.dirname(repoRoot), WORKTREES_DIR_NAME);
}

function getManifestPath(worktreesRoot) {
  return path.join(worktreesRoot, MANIFEST_FILE_NAME);
}

function readManifest(worktreesRoot) {
  const p = getManifestPath(worktreesRoot);
  if (!fs.existsSync(p)) return { entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed.entries === "object" ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeManifest(worktreesRoot, manifest) {
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const target = getManifestPath(worktreesRoot);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function sanitizeSlug(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) {
    throw new Error("`name` must contain at least one alphanumeric character.");
  }
  return slug;
}

function countDirtyFiles(wtPath) {
  if (!fs.existsSync(wtPath)) return 0;
  try {
    const out = git(["status", "--porcelain=v1", "-uall"], wtPath).trim();
    if (!out) return 0;
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function parsePorcelainWorktrees(raw) {
  const blocks = raw.trim().split(/\n\n+/).filter(Boolean);
  const items = [];
  for (const block of blocks) {
    const item = {
      path: null,
      head: null,
      branch: null,
      detached: false,
      bare: false,
      prunable: false,
    };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        item.path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        item.head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        item.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "detached") {
        item.detached = true;
      } else if (line === "bare") {
        item.bare = true;
      } else if (line.startsWith("prunable")) {
        item.prunable = true;
      }
    }
    if (item.path) items.push(item);
  }
  return items;
}

export function worktreeCreate(args) {
  const repoRoot = resolveGitRepoRoot(args?.repoCwd);
  const slug = sanitizeSlug(args?.name);
  const baseRef = args?.baseRef ? String(args.baseRef).trim() : "HEAD";
  const copyEnv = args?.copyEnv !== false;
  const symlinkDirs = Array.isArray(args?.symlinkDirs)
    ? args.symlinkDirs.map((d) => String(d).trim()).filter(Boolean)
    : [];

  const shortId = crypto.randomBytes(2).toString("hex");
  const repoName = path.basename(repoRoot);
  const worktreesRoot = getWorktreesRoot(repoRoot);
  fs.mkdirSync(worktreesRoot, { recursive: true });

  const worktreePath = path.join(worktreesRoot, `${repoName}-${slug}-${shortId}`);
  const branch = `orch/${slug}-${shortId}`;

  git(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
  const realWorktreePath = fs.realpathSync(worktreePath);

  const copiedEnvFiles = [];
  if (copyEnv) {
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!ENV_FILE_RE.test(entry.name) || ENV_TEMPLATE_RE.test(entry.name)) continue;
      const src = path.join(repoRoot, entry.name);
      const dst = path.join(realWorktreePath, entry.name);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        copiedEnvFiles.push(entry.name);
      }
    }
  }

  const symlinkedDirs = [];
  const skippedSymlinks = [];
  for (const relDir of symlinkDirs) {
    const cleanRel = relDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!cleanRel || cleanRel.includes("..")) {
      skippedSymlinks.push({ dir: relDir, reason: "Invalid relative directory path" });
      continue;
    }
    const src = path.join(repoRoot, cleanRel);
    const dst = path.join(realWorktreePath, cleanRel);
    if (!fs.existsSync(src)) {
      skippedSymlinks.push({ dir: cleanRel, reason: "Source directory does not exist in main repo" });
      continue;
    }
    if (fs.existsSync(dst)) {
      skippedSymlinks.push({ dir: cleanRel, reason: "Destination already exists in worktree" });
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, "dir");
    symlinkedDirs.push(cleanRel);
  }

  const manifest = readManifest(worktreesRoot);
  manifest.entries[realWorktreePath] = {
    repoRoot,
    name: slug,
    branch,
    baseRef,
    createdAt: new Date().toISOString(),
    copiedEnvFiles,
    symlinkedDirs,
  };
  writeManifest(worktreesRoot, manifest);

  return {
    repoRoot,
    worktreePath: realWorktreePath,
    branch,
    baseRef,
    copiedEnvFiles,
    symlinkedDirs,
    skippedSymlinks: skippedSymlinks.length > 0 ? skippedSymlinks : undefined,
    hint: "Pass `worktreePath` as `cwd` to codex_run/dsh_run. Merge changes from the main repo after verification, then call worktree_cleanup.",
  };
}

function getWorktreeChangedFiles(wtPath, baseRef = "HEAD", mainHead = null) {
  if (!fs.existsSync(wtPath)) return [];
  const files = new Set();

  const compareBase = mainHead || baseRef || "HEAD";
  try {
    const committed = git(["diff", "--name-only", `${compareBase}...HEAD`], wtPath).trim();
    if (committed) {
      for (const line of committed.split("\n")) {
        if (line.trim()) files.add(line.trim());
      }
    }
  } catch {}

  try {
    const raw = git(["status", "--porcelain=v1", "-z", "-uall"], wtPath);
    const entries = raw.split("\0");
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const rel = entry.slice(3).trim();
      if (rel) files.add(rel);
      if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
        i += 1;
      }
    }
  } catch {}

  return Array.from(files).sort();
}

export function worktreeList(args) {
  const repoRoot = resolveGitRepoRoot(args?.repoCwd);
  const worktreesRoot = getWorktreesRoot(repoRoot);
  const manifest = readManifest(worktreesRoot);

  let mainHead = null;
  try {
    mainHead = git(["rev-parse", "HEAD"], repoRoot).trim();
  } catch {}

  const raw = git(["worktree", "list", "--porcelain"], repoRoot);
  const parsed = parsePorcelainWorktrees(raw);

  const worktrees = parsed.map((wt) => {
    const realPath = fs.existsSync(wt.path) ? fs.realpathSync(wt.path) : wt.path;
    const meta = manifest.entries[realPath] || manifest.entries[wt.path] || null;
    const isMain = realPath === repoRoot;
    const dirtyFiles = wt.bare ? 0 : countDirtyFiles(realPath);
    const changedFiles =
      !isMain && !wt.bare && (Boolean(meta) || (wt.branch && wt.branch.startsWith("orch/")))
        ? getWorktreeChangedFiles(realPath, meta?.baseRef || "HEAD", mainHead)
        : undefined;
    return {
      path: realPath,
      branch: wt.branch,
      head: wt.head,
      detached: wt.detached,
      bare: wt.bare,
      prunable: wt.prunable,
      isMain,
      managedByPlugin: Boolean(meta),
      createdAt: meta?.createdAt || null,
      dirtyFiles,
      ...(changedFiles !== undefined ? { changedFiles } : {}),
    };
  });

  // Pre-merge conflict detection across non-main orchestrator worktrees
  const fileOwners = new Map();
  for (const wt of worktrees) {
    if (!Array.isArray(wt.changedFiles) || wt.changedFiles.length === 0) continue;
    for (const file of wt.changedFiles) {
      if (!fileOwners.has(file)) fileOwners.set(file, []);
      fileOwners.get(file).push({
        branch: wt.branch,
        path: wt.path,
      });
    }
  }

  const potentialConflicts = [];
  for (const [file, owners] of fileOwners.entries()) {
    if (owners.length > 1) {
      potentialConflicts.push({ file, worktrees: owners });
    }
  }
  potentialConflicts.sort((a, b) => a.file.localeCompare(b.file));

  return {
    repoRoot,
    worktreesRoot,
    worktrees,
    potentialConflicts,
  };
}

export function worktreeCleanup(args) {
  if (!args?.worktreePath || typeof args.worktreePath !== "string") {
    throw new Error("`worktreePath` (string) is required.");
  }

  const repoRoot = resolveGitRepoRoot(args?.repoCwd);
  const worktreesRoot = getWorktreesRoot(repoRoot);
  const deleteBranch = args?.deleteBranch === true;
  const force = args?.force === true;

  const targetResolved = fs.existsSync(args.worktreePath)
    ? fs.realpathSync(args.worktreePath)
    : path.resolve(args.worktreePath);

  if (targetResolved === repoRoot) {
    throw new Error("Refusing to remove the main repository worktree.");
  }

  const raw = git(["worktree", "list", "--porcelain"], repoRoot);
  const listed = parsePorcelainWorktrees(raw);
  const matched = listed.find((wt) => {
    const wtReal = fs.existsSync(wt.path) ? fs.realpathSync(wt.path) : path.resolve(wt.path);
    return wtReal === targetResolved;
  });

  if (!matched) {
    throw new Error(`Worktree is not registered in this repository: ${targetResolved}`);
  }

  const dirtyFiles = countDirtyFiles(targetResolved);
  if (dirtyFiles > 0 && !force) {
    throw new Error(
      `Worktree has ${dirtyFiles} uncommitted/untracked file(s): ${targetResolved}. Commit/stash first or pass force: true.`
    );
  }

  const removeArgs = ["worktree", "remove"];
  if (force) removeArgs.push("--force");
  removeArgs.push(targetResolved);
  git(removeArgs, repoRoot);
  git(["worktree", "prune"], repoRoot);

  let branchDeleted = false;
  let branchWarning = null;
  const branchName = matched.branch;
  if (deleteBranch && branchName) {
    if (!branchName.startsWith("orch/")) {
      branchWarning = `Skipped deleting non-orchestrator branch '${branchName}' (only 'orch/*' branches can be auto-deleted).`;
    } else {
      try {
        git(["branch", force ? "-D" : "-d", branchName], repoRoot);
        branchDeleted = true;
      } catch (err) {
        branchWarning = `Could not delete branch '${branchName}': ${err?.stderr?.toString()?.trim() || err.message}`;
      }
    }
  }

  const manifest = readManifest(worktreesRoot);
  if (manifest.entries[targetResolved]) {
    delete manifest.entries[targetResolved];
    writeManifest(worktreesRoot, manifest);
  }

  return {
    removed: true,
    repoRoot,
    worktreePath: targetResolved,
    branchName,
    branchDeleted,
    branchWarning: branchWarning || undefined,
  };
}
