import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRuntimePath, resolveCodexBin, resolveDshBin } from "../lib/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "install.mjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("paths.mjs resolves binaries via env override, PATH lookup, home fallback, and safe defaults", () => {
  const tmp = makeTempDir("conductor-paths-");
  try {
    const binDir = path.join(tmp, "bin");
    const fakeHome = path.join(tmp, "home");
    const homeLocalBin = path.join(fakeHome, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(homeLocalBin, { recursive: true });

    const fakeCodexInPath = path.join(binDir, "codex");
    const fakeCodexInHome = path.join(homeLocalBin, "codex");
    const fakeDshInPath = path.join(binDir, "dsh");
    fs.writeFileSync(fakeCodexInPath, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(fakeCodexInHome, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(fakeDshInPath, "#!/bin/sh\n", { mode: 0o755 });

    // 1. Explicit env wins
    assert.equal(
      resolveCodexBin({ env: { CODEX_BIN: "/custom/codex", PATH: binDir }, platform: "darwin", homeDir: fakeHome }),
      "/custom/codex"
    );
    assert.equal(
      resolveDshBin({ env: { DSH_BIN: "/custom/dsh", PATH: binDir }, platform: "darwin", homeDir: fakeHome }),
      "/custom/dsh"
    );

    // 2. PATH lookup works before home fallback
    assert.equal(
      resolveCodexBin({ env: { PATH: binDir }, platform: "darwin", homeDir: fakeHome }),
      fakeCodexInPath
    );
    assert.equal(
      resolveDshBin({ env: { PATH: binDir }, platform: "linux", homeDir: fakeHome }),
      fakeDshInPath
    );

    // 3. Home ~/.local/bin fallback works when PATH is empty
    assert.equal(
      resolveCodexBin({ env: { PATH: "" }, platform: "linux", homeDir: fakeHome }),
      fakeCodexInHome
    );

    // 4. Bare binary name returned when nothing exists on disk
    const emptyHome = path.join(tmp, "empty-home");
    fs.mkdirSync(emptyHome, { recursive: true });
    assert.equal(
      resolveCodexBin({ env: { PATH: "" }, platform: "win32", homeDir: emptyHome }),
      "codex"
    );
    assert.equal(
      resolveDshBin({ env: { PATH: "" }, platform: "win32", homeDir: emptyHome }),
      "dsh"
    );

    // 5. buildRuntimePath deduplicates entries
    const built = buildRuntimePath({
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      homeDir: fakeHome,
      extraDirs: ["/custom/bin", "/usr/bin"],
    });
    const parts = built.split(":");
    assert.equal(parts[0], "/custom/bin");
    assert.equal(parts.filter((p) => p === "/usr/bin").length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("install.mjs installs, preserves existing MCP servers, and cleanly uninstalls in an isolated sandbox", () => {
  const sandbox = makeTempDir("conductor-install-");
  try {
    const pluginDir = path.join(sandbox, "plugins", "codex-dsh-orchestrator");
    const mcpConfig = path.join(sandbox, "mcp_config.json");
    const fakeCodex = path.join(sandbox, "fake-codex");
    fs.writeFileSync(fakeCodex, "#!/bin/sh\n", { mode: 0o755 });

    // Pre-existing MCP config with another server
    fs.writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { "existing-server": { command: "echo", args: ["hi"] } } }, null, 2),
      "utf8"
    );

    // Dry-run must not modify files
    const dryOut = execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "--dry-run", "--skip-npm", "--plugin-dir", pluginDir, "--mcp-config", mcpConfig],
      { encoding: "utf8" }
    );
    assert.match(dryOut, /\[dry-run\]/);
    assert.equal(fs.existsSync(pluginDir), false);

    // Real sandbox install (--skip-npm)
    execFileSync(
      process.execPath,
      [
        INSTALL_SCRIPT,
        "--skip-npm",
        "--plugin-dir",
        pluginDir,
        "--mcp-config",
        mcpConfig,
        "--codex-bin",
        fakeCodex,
        "--dsh-concurrency",
        "4",
      ],
      { encoding: "utf8" }
    );

    // Verify plugin files & branding copied
    for (const rel of [
      "plugin.json",
      "assets/logo.png",
      "rules/AGENTS.md",
      "skills/orchestrate-review/SKILL.md",
      "server/index.mjs",
      "server/wait-job.mjs",
      "server/lib/paths.mjs",
    ]) {
      assert.ok(fs.existsSync(path.join(pluginDir, rel)), `Missing installed file: ${rel}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf8"));
    assert.equal(manifest.displayName, "Trihelm");
    assert.equal(manifest.logo, "assets/logo.png");

    // Verify mcp_config.json merged without clobbering existing-server
    const merged = JSON.parse(fs.readFileSync(mcpConfig, "utf8"));
    assert.deepEqual(merged.mcpServers["existing-server"], { command: "echo", args: ["hi"] });
    const entry = merged.mcpServers["codex-dsh-orchestrator"];
    assert.ok(entry);
    assert.equal(entry.args[0], path.join(pluginDir, "server", "index.mjs"));
    assert.equal(entry.env.CODEX_BIN, fakeCodex);
    assert.equal(entry.env.DSH_MAX_CONCURRENCY, "4");

    // Uninstall cleanly removes only Conductor
    execFileSync(
      process.execPath,
      [INSTALL_SCRIPT, "--uninstall", "--plugin-dir", pluginDir, "--mcp-config", mcpConfig],
      { encoding: "utf8" }
    );
    assert.equal(fs.existsSync(pluginDir), false);
    const afterUninstall = JSON.parse(fs.readFileSync(mcpConfig, "utf8"));
    assert.deepEqual(afterUninstall.mcpServers["existing-server"], { command: "echo", args: ["hi"] });
    assert.equal(afterUninstall.mcpServers["codex-dsh-orchestrator"], undefined);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
