# AGENTS.md — Automated Installation & Maintenance Guide for AI Agents

This file is written for **AI coding agents** (Antigravity, Claude Code, Codex, Cursor, etc.) asked by a user to install, upgrade, verify, or uninstall **Trihelm** directly from GitHub.

> **Repository role**: Trihelm is a portable multi-model orchestration plugin + MCP server (`codex-dsh-orchestrator`) for **Antigravity**. It installs into `~/.gemini/config/plugins/codex-dsh-orchestrator` and registers its MCP server cleanly in `~/.gemini/config/mcp_config.json`.

---

## Non-Negotiable Safety Guardrails

1. **NEVER hand-edit `~/.gemini/config/config.json`** (Antigravity owns that file and stores user settings/permissions there).
2. **NEVER overwrite existing entries in `~/.gemini/config/mcp_config.json`**. Always use `node install.mjs`, which atomically merges only the `codex-dsh-orchestrator` key and preserves every other MCP server.
3. **NEVER move `mcp_config.json` inside `~/.gemini/config/plugins/codex-dsh-orchestrator/`**. Keeping the server registered in global `~/.gemini/config/mcp_config.json` is intentional—it avoids an Antigravity plugin-bundled MCP loader issue where some tool parameter schemas drop to `null`.
4. **Do NOT require both Codex and DSH to proceed**. Missing optional backends degrade gracefully; install anyway and clearly report which backends were detected.

---

## Automated Install Procedure (From GitHub)

When a user says *"install Trihelm from `<github-repo-url>`"* or *"set up this repo for me"*, execute these exact steps:

### Step 1 · Preflight Environment Check
Run a single shell check:
```bash
node -v && git --version
```
- Require **Node.js ≥ 18** and **Git**. If Node.js < 18 or missing, stop and tell the user to install Node.js ≥ 18 first.

### Step 2 · Clone (or Pull) the Repository
If you are not already inside a local clone of this repo, clone it to a clean temporary directory (do **not** pollute the user's project repo):
```bash
git clone --depth 1 <github-repo-url> "${TMPDIR:-/tmp}/trihelm-install"
cd "${TMPDIR:-/tmp}/trihelm-install"
```
*(If the user already cloned the repo locally, run `git pull --ff-only` inside their existing checkout instead.)*

### Step 3 · Dry-Run Preview
Run the installer in preview mode first to inspect auto-detected binary paths (`node`, `codex`, `dsh`) and target paths:
```bash
node install.mjs --dry-run
```
- Verify `Node.js`, `Plugin dir`, and `MCP config` paths look sane.
- If the user provided custom binary paths or pool size, pass `--codex-bin <path>`, `--dsh-bin <path>`, or `--dsh-concurrency <1-6>`.

### Step 4 · Run Installer
```bash
node install.mjs
```
This automatically:
1. Copies `plugin.json`, `assets/logo.png`, `rules/AGENTS.md`, `skills/orchestrate-review/SKILL.md`, and `server/` into `~/.gemini/config/plugins/codex-dsh-orchestrator`.
2. Installs `@openai/codex-sdk` inside `~/.gemini/config/plugins/codex-dsh-orchestrator/server` via `npm ci --omit=dev`.
3. Auto-detects `node`, `codex`, and `dsh` and merges `mcpServers["codex-dsh-orchestrator"]` into `~/.gemini/config/mcp_config.json`.

*(Optional cleanup: if you cloned into `${TMPDIR:-/tmp}/trihelm-install`, you may remove that temporary clone after `node install.mjs` succeeds, since all runtime files are now copied into `~/.gemini/config/plugins/codex-dsh-orchestrator`.)*

### Step 5 · Handoff & Post-Install Verification
1. Tell the user to **restart Antigravity (or reload MCP servers)** so the `codex-dsh-orchestrator` MCP server starts with all 11 tools.
2. In Antigravity, link the plugin page directly as:
   `[Trihelm](customization://codex-dsh-orchestrator)`
   *(Important: always key `customization://` on the directory name `codex-dsh-orchestrator`, never `Trihelm`.)*
3. Summarize which optional backends were detected:
   - **Codex CLI**: ready if `FOUND`; otherwise tell the user they can install Codex CLI and sign in to enable `gpt-6.2-sol`, `gpt-6.2-astra`, `codex_review`, and ChatGPT built-in `image_gen`.
   - **DeepSeek Harness (`dsh`)**: ready if `FOUND`; otherwise tell the user they can install DeepSeek Harness to enable the 3-worker DSH ACP coding pool.
4. Once Antigravity reloads, verify live health by calling the MCP tool `orchestrator_status` and confirming `version: "1.3.0"`.

---

## Upgrade & Uninstall

- **Upgrade**: `git pull` (or fresh clone) and re-run `node install.mjs`. It is idempotent and preserves existing `mcp_config.json` entries plus historical `jobs/` and `metrics.json`.
- **Uninstall** (keep historical data):
  ```bash
  node install.mjs --uninstall
  ```
- **Full uninstall** (also delete saved `jobs/` and `metrics.json`):
  ```bash
  node install.mjs --uninstall --purge-data
  ```

---

## Development & Test Verification (For Repo Contributors)

When editing files inside this repository, always run the full test suite before committing:
```bash
cd server && npm install && npm test
```
All tests (`v1.2.test.mjs`, `v1.3.test.mjs`, `portable.test.mjs`) must pass with zero personal paths or secrets committed.
