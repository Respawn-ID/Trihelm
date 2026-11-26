#!/usr/bin/env node
/**
 * Trihelm (codex-dsh-orchestrator) portable installer / uninstaller for Antigravity.
 *
 * Zero external dependencies — runs with Node.js >= 18 on macOS, Linux, and Windows.
 *
 * Usage:
 *   node install.mjs                  # Install or upgrade Trihelm plugin + global MCP registration
 *   node install.mjs --dry-run        # Preview actions without modifying files
 *   node install.mjs --uninstall      # Remove plugin & MCP registration (preserves other MCP servers)
 *   node install.mjs --help           # Show all options
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimePath, findInPath, resolveCodexBin, resolveDshBin } from "./server/lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = "codex-dsh-orchestrator";
const COPY_ITEMS = ["plugin.json", "assets", "rules", "skills", "server"];
const SKIP_NAMES = new Set(["node_modules", ".git", ".DS_Store", "test"]);

function parseArgs(argv) {
  const home = os.homedir();
  const opts = {
    uninstall: false,
    purgeData: false,
    dryRun: false,
    skipNpm: false,
    pluginDir: path.join(home, ".gemini", "config", "plugins", PLUGIN_ID),
    mcpConfig: path.join(home, ".gemini", "config", "mcp_config.json"),
    dataDir: path.join(home, ".gemini", "antigravity", "plugin_data", PLUGIN_ID),
    codexBin: null,
    dshBin: null,
    dshConcurrency: null,
    nodeBin:
      findInPath(process.platform === "win32" ? ["node.exe", "node"] : ["node"]) ||
      process.execPath,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--purge-data") opts.purgeData = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--skip-npm") opts.skipNpm = true;
    else if (a === "--plugin-dir" && argv[i + 1]) opts.pluginDir = path.resolve(argv[++i]);
    else if (a === "--mcp-config" && argv[i + 1]) opts.mcpConfig = path.resolve(argv[++i]);
    else if (a === "--data-dir" && argv[i + 1]) opts.dataDir = path.resolve(argv[++i]);
    else if (a === "--codex-bin" && argv[i + 1]) opts.codexBin = argv[++i];
    else if (a === "--dsh-bin" && argv[i + 1]) opts.dshBin = argv[++i];
    else if (a === "--dsh-concurrency" && argv[i + 1]) opts.dshConcurrency = argv[++i];
    else if (a === "--node-bin" && argv[i + 1]) opts.nodeBin = argv[++i];
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a} (use --help for usage)`);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Trihelm (codex-dsh-orchestrator) Installer for Antigravity

Usage:
  node install.mjs [options]

Options:
  --uninstall              Remove Trihelm plugin and its global mcp_config.json entry
  --purge-data             With --uninstall, also remove saved jobs/metrics in plugin_data
  --dry-run                Print planned operations without writing to disk
  --skip-npm               Skip installing server/node_modules dependencies
  --plugin-dir <path>      Override plugin install directory (default: ~/.gemini/config/plugins/codex-dsh-orchestrator)
  --mcp-config <path>      Override global mcp_config.json path (default: ~/.gemini/config/mcp_config.json)
  --codex-bin <path>       Explicit path to local Codex CLI binary
  --dsh-bin <path>         Explicit path to local DeepSeek Harness (dsh) CLI binary
  --dsh-concurrency <1-6>  Override DSH_MAX_CONCURRENCY (default: 3)
  --node-bin <path>        Override Node.js executable path written into mcp_config.json
  -h, --help               Show this help message
`);
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node.js >= 18 is required (found v${process.versions.node}).`);
  }
}

function copyTree(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (SKIP_NAMES.has(entry)) continue;
      copyTree(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dst, stat.mode);
    } catch {}
  }
}

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function isFile(p) {
  try {
    return Boolean(p && fs.statSync(p).isFile());
  } catch {
    return false;
  }
}

function runNpmInstall(serverDir) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const hasLock = fs.existsSync(path.join(serverDir, "package-lock.json"));
  const args = hasLock
    ? ["ci", "--omit=dev", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund"];
  execFileSync(npmCmd, args, { cwd: serverDir, stdio: "inherit" });
}

function install(opts) {
  checkNodeVersion();

  const resolvedCodex = opts.codexBin || resolveCodexBin();
  const resolvedDsh = opts.dshBin || resolveDshBin();
  const codexFound = isFile(resolvedCodex);
  const dshFound = isFile(resolvedDsh);

  const serverEntry = path.join(opts.pluginDir, "server", "index.mjs");
  const envBlock = {
    PATH: buildRuntimePath({
      extraDirs: [
        path.dirname(opts.nodeBin),
        codexFound ? path.dirname(resolvedCodex) : null,
        dshFound ? path.dirname(resolvedDsh) : null,
      ].filter(Boolean),
    }),
  };
  if (codexFound || opts.codexBin) envBlock.CODEX_BIN = resolvedCodex;
  if (dshFound || opts.dshBin) envBlock.DSH_BIN = resolvedDsh;
  if (opts.dshConcurrency) envBlock.DSH_MAX_CONCURRENCY = String(opts.dshConcurrency);

  const mcpEntry = {
    command: opts.nodeBin,
    args: [serverEntry],
    env: envBlock,
  };

  console.log(`\nTrihelm (Antigravity Multi-Model Orchestrator) — Installer`);
  console.log(`  Source repo : ${__dirname}`);
  console.log(`  Plugin dir  : ${opts.pluginDir}`);
  console.log(`  MCP config  : ${opts.mcpConfig}`);
  console.log(`  Node.js     : ${opts.nodeBin} (v${process.versions.node})`);
  console.log(`  Codex CLI   : ${codexFound ? `FOUND (${resolvedCodex})` : `not found (${resolvedCodex}) — optional, install Codex CLI for Sol/Astra/image_gen`}`);
  console.log(`  DSH CLI     : ${dshFound ? `FOUND (${resolvedDsh})` : `not found (${resolvedDsh}) — optional, install DeepSeek Harness for pooled DSH`}`);

  if (opts.dryRun) {
    console.log(`\n[dry-run] Planned mcpServers["${PLUGIN_ID}"]:`);
    console.log(JSON.stringify(mcpEntry, null, 2));
    return;
  }

  // 1. Copy plugin files (preserve existing server/node_modules if upgrading in place)
  const sameDir = path.resolve(__dirname) === path.resolve(opts.pluginDir);
  if (!sameDir) {
    fs.mkdirSync(opts.pluginDir, { recursive: true });
    for (const item of COPY_ITEMS) {
      const src = path.join(__dirname, item);
      if (!fs.existsSync(src)) continue;
      copyTree(src, path.join(opts.pluginDir, item));
    }
    console.log(`\n[1/3] Installed plugin files to ${opts.pluginDir}`);
  } else {
    console.log(`\n[1/3] Source and target plugin directory are identical; skipping file copy.`);
  }

  // 2. Install MCP server dependencies
  const serverDir = path.join(opts.pluginDir, "server");
  if (opts.skipNpm) {
    console.log(`[2/3] Skipped npm install (--skip-npm)`);
  } else {
    console.log(`[2/3] Installing server dependencies in ${serverDir}...`);
    runNpmInstall(serverDir);
  }

  // 3. Merge into global ~/.gemini/config/mcp_config.json without clobbering other servers
  const mcpDoc = readJsonFileSafe(opts.mcpConfig);
  if (!mcpDoc.mcpServers || typeof mcpDoc.mcpServers !== "object") {
    mcpDoc.mcpServers = {};
  }
  mcpDoc.mcpServers[PLUGIN_ID] = mcpEntry;
  writeJsonAtomic(opts.mcpConfig, mcpDoc);
  console.log(`[3/3] Registered "${PLUGIN_ID}" in ${opts.mcpConfig}`);

  console.log(`\nDone! Next steps:`);
  console.log(`  1. Restart Antigravity (or reload MCP servers) to activate Trihelm v1.3.0.`);
  console.log(`  2. Verify inside Antigravity by asking: "检查编排器状态" (runs orchestrator_status).`);
  if (!codexFound) {
    console.log(`  - Optional: install Codex CLI and sign in to enable GPT-6.2 Sol/Astra & ChatGPT image_gen.`);
  }
  if (!dshFound) {
    console.log(`  - Optional: install DeepSeek Harness to enable the 3-worker DSH ACP coding pool.`);
  }
}

function uninstall(opts) {
  console.log(`\nTrihelm — Uninstaller`);
  console.log(`  Plugin dir : ${opts.pluginDir}`);
  console.log(`  MCP config : ${opts.mcpConfig}`);

  if (opts.dryRun) {
    console.log(`[dry-run] Would remove ${opts.pluginDir} and delete mcpServers["${PLUGIN_ID}"] from ${opts.mcpConfig}.`);
    if (opts.purgeData) console.log(`[dry-run] Would also remove ${opts.dataDir}.`);
    return;
  }

  if (fs.existsSync(opts.pluginDir)) {
    fs.rmSync(opts.pluginDir, { recursive: true, force: true });
    console.log(`[1/2] Removed plugin directory: ${opts.pluginDir}`);
  } else {
    console.log(`[1/2] Plugin directory not present (already removed).`);
  }

  if (fs.existsSync(opts.mcpConfig)) {
    const mcpDoc = readJsonFileSafe(opts.mcpConfig);
    if (mcpDoc.mcpServers && Object.prototype.hasOwnProperty.call(mcpDoc.mcpServers, PLUGIN_ID)) {
      delete mcpDoc.mcpServers[PLUGIN_ID];
      writeJsonAtomic(opts.mcpConfig, mcpDoc);
      console.log(`[2/2] Removed "${PLUGIN_ID}" entry from ${opts.mcpConfig} (other servers preserved).`);
    } else {
      console.log(`[2/2] No "${PLUGIN_ID}" entry found in ${opts.mcpConfig}.`);
    }
  } else {
    console.log(`[2/2] MCP config not present.`);
  }

  if (opts.purgeData && fs.existsSync(opts.dataDir)) {
    fs.rmSync(opts.dataDir, { recursive: true, force: true });
    console.log(`[extra] Purged plugin data directory: ${opts.dataDir}`);
  }

  console.log(`\nUninstalled. Restart Antigravity to finish unloading MCP tools.`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.uninstall) {
    uninstall(opts);
  } else {
    install(opts);
  }
} catch (err) {
  process.stderr.write(`Error: ${err?.message || String(err)}\n`);
  process.exit(1);
}
