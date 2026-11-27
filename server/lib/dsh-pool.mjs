import { spawn } from "node:child_process";
import readline from "node:readline";
import { extractPathsFromToolCall } from "./scope.mjs";

const READ_ONLY_TOOL_KINDS = new Set(["read", "search", "think", "other"]);
const READ_ONLY_NAME_PATTERNS = [
  /^read/i,
  /^view/i,
  /^list/i,
  /^ls$/i,
  /^find/i,
  /^glob/i,
  /^grep/i,
  /^search/i,
  /^cat$/i,
  /^git\s+(status|diff|log|show|branch)/i,
];
const WRITE_NAME_PATTERNS = [
  /write/i,
  /edit/i,
  /patch/i,
  /delete/i,
  /remove/i,
  /unlink/i,
  /move/i,
  /rename/i,
  /mkdir/i,
  /exec/i,
  /bash/i,
  /shell/i,
  /terminal/i,
  /run_command/i,
];

const INVALID_SESSION_RE =
  /session\s*(?:id\s*)?(?:not\s*found|unknown|invalid|expired|closed|does\s*not\s*exist)|(?:unknown|invalid|expired|missing|closed)\s+session/i;

function createAbortError(message = "Aborted") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function isReadOnlyToolCall(toolCall) {
  const kind = String(toolCall?.kind || "").toLowerCase();
  const title = String(toolCall?.title || toolCall?.name || "");
  if (kind === "edit" || kind === "delete" || kind === "move" || kind === "execute") {
    return false;
  }
  if (kind === "read" || kind === "search" || kind === "think") {
    return true;
  }
  if (WRITE_NAME_PATTERNS.some((re) => re.test(title))) {
    return false;
  }
  if (READ_ONLY_NAME_PATTERNS.some((re) => re.test(title))) {
    return true;
  }
  return (
    READ_ONLY_TOOL_KINDS.has(kind) &&
    title.length > 0 &&
    !WRITE_NAME_PATTERNS.some((re) => re.test(title))
  );
}

function choosePermissionOption(options, allow) {
  if (!Array.isArray(options) || options.length === 0) return null;
  if (allow) {
    return (
      options.find((o) => o.kind === "allow_once") ||
      options.find((o) => o.kind === "allow_always") ||
      options[0]
    );
  }
  return (
    options.find((o) => o.kind === "reject_once") ||
    options.find((o) => o.kind === "reject_always") ||
    null
  );
}

function flattenModelOptions(modelOpt) {
  const flat = [];
  if (!modelOpt || !Array.isArray(modelOpt.options)) return flat;

  const pushOpt = (opt, groupName = null) => {
    if (!opt || typeof opt !== "object") return;
    if (Array.isArray(opt.options)) {
      for (const child of opt.options) {
        pushOpt(child, opt.group || opt.name || groupName);
      }
      return;
    }
    if (typeof opt.value !== "string") return;
    let parsedProvider = null;
    let parsedModel = opt.value;
    try {
      const parsed = JSON.parse(opt.value);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        parsedProvider = String(parsed[0]);
        parsedModel = String(parsed[1]);
      }
    } catch {}
    flat.push({
      value: opt.value,
      name: String(opt.name || ""),
      group: groupName ? String(groupName) : parsedProvider,
      parsedProvider,
      parsedModel,
    });
  };

  for (const item of modelOpt.options) {
    pushOpt(item, null);
  }
  return flat;
}

function stripRoutingPrefix(str) {
  return String(str || "")
    .trim()
    .replace(/^(auto|routing|default)\//i, "");
}

function foldModelToken(str) {
  return stripRoutingPrefix(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function foldModelWithoutVersion(str) {
  return stripRoutingPrefix(str)
    .toLowerCase()
    .replace(/v\d+(?:\.\d+)*/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function modelMatchesOption(targetModel, opt) {
  const reqRaw = String(targetModel || "").trim().toLowerCase();
  const reqStripped = stripRoutingPrefix(reqRaw).toLowerCase();
  const reqFold = foldModelToken(targetModel);
  const optModelRaw = String(opt.parsedModel || "").trim().toLowerCase();
  const optModelStripped = stripRoutingPrefix(optModelRaw).toLowerCase();
  const optModelFold = foldModelToken(opt.parsedModel);
  const optNameFold = foldModelToken(opt.name);

  if (reqRaw && (reqRaw === optModelRaw || reqRaw === opt.value.toLowerCase())) return 4;
  if (reqStripped && (reqStripped === optModelStripped || reqStripped === optModelRaw)) return 3;
  if (reqFold && (reqFold === optModelFold || reqFold === optNameFold)) return 3;
  if (reqFold && (optNameFold.includes(reqFold) || optModelFold.includes(reqFold))) return 2;

  const reqNoVer = foldModelWithoutVersion(targetModel);
  const optModelNoVer = foldModelWithoutVersion(opt.parsedModel);
  const optNameNoVer = foldModelWithoutVersion(opt.name);
  if (reqNoVer && reqNoVer.length >= 6 && (reqNoVer === optModelNoVer || reqNoVer === optNameNoVer)) {
    return 1;
  }
  return 0;
}

/**
 * Resolves a requested DSH provider/model against the live `session/new`
 * model configOptions so both official model names (e.g. `deepseek-flash`,
 * `DeepSeek-V4.1-Flash`) and routed names (e.g. `auto/deepseek-v4.1-flash`)
 * work seamlessly across different machines.
 */
export function resolveDshModelOption(modelOpt, { provider, model } = {}) {
  const reqProvider = provider ? String(provider).trim() : "";
  const reqModel = model ? String(model).trim() : "";
  const currentValue = modelOpt?.currentValue || null;

  if (!reqProvider && !reqModel) {
    return { value: currentValue, needsSwitch: false, matched: true, note: null };
  }

  const options = flattenModelOptions(modelOpt);

  // If raw JSON tuple string was passed directly
  if (reqModel.startsWith("[")) {
    const exact = options.find((o) => o.value === reqModel);
    if (exact) {
      return { value: exact.value, needsSwitch: exact.value !== currentValue, matched: true, note: null };
    }
    if (options.length === 0) {
      return { value: reqModel, needsSwitch: reqModel !== currentValue, matched: true, note: null };
    }
    try {
      const parsed = JSON.parse(reqModel);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return resolveDshModelOption(modelOpt, { provider: parsed[0], model: parsed[1] });
      }
    } catch {}
  }

  // If DSH didn't report an options list (e.g. minimal mock), fall back to legacy tuple formatting
  if (options.length === 0) {
    let fallbackValue;
    if (reqProvider && reqModel) {
      fallbackValue = JSON.stringify([reqProvider, reqModel]);
    } else if (currentValue) {
      let curProvider = reqProvider;
      let curModel = reqModel;
      try {
        const parsed = JSON.parse(currentValue);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          if (!curProvider) curProvider = String(parsed[0]);
          if (!curModel) curModel = String(parsed[1]);
        }
      } catch {}
      fallbackValue = curProvider && curModel ? JSON.stringify([curProvider, curModel]) : reqModel || currentValue;
    } else {
      fallbackValue = reqProvider && reqModel ? JSON.stringify([reqProvider, reqModel]) : reqModel;
    }
    return { value: fallbackValue, needsSwitch: Boolean(fallbackValue && fallbackValue !== currentValue), matched: true, note: null };
  }

  // Score every available option on this machine
  const candidates = options
    .map((opt) => {
      const providerMatch =
        !reqProvider ||
        String(opt.parsedProvider || "").toLowerCase() === reqProvider.toLowerCase() ||
        String(opt.group || "").toLowerCase() === reqProvider.toLowerCase();
      const modelScore = reqModel ? modelMatchesOption(reqModel, opt) : 2;
      const isCurrent = opt.value === currentValue ? 1 : 0;
      return { opt, providerMatch, modelScore, isCurrent };
    })
    .filter((c) => (reqModel ? c.modelScore > 0 : c.providerMatch));

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (a.providerMatch !== b.providerMatch) return a.providerMatch ? -1 : 1;
      if (a.modelScore !== b.modelScore) return b.modelScore - a.modelScore;
      if (a.isCurrent !== b.isCurrent) return b.isCurrent - a.isCurrent;
      return 0;
    });
    const best = candidates[0];
    const adaptedNote =
      !best.providerMatch && reqProvider
        ? `Provider '${reqProvider}' unavailable on this DSH; auto-mapped to ${best.opt.value} (${best.opt.name}).`
        : null;
    return {
      value: best.opt.value,
      needsSwitch: best.opt.value !== currentValue,
      matched: true,
      note: adaptedNote,
    };
  }

  return {
    value: currentValue,
    needsSwitch: false,
    matched: false,
    note: `Requested model '${reqProvider ? `${reqProvider}/` : ""}${reqModel}' was not found in DSH options; kept current default ${currentValue || "model"}.`,
  };
}

export class DshAcpClient {
  constructor({
    dshBin,
    dshArgs = ["--profile", "acp"],
    defaultSyncTimeoutMs = 150_000,
    resolveCwd,
    resolveTimeoutMs,
    truncate,
    log = () => {},
    workerId = "dsh-1",
    onExit = null,
  }) {
    this.dshBin = dshBin;
    this.dshArgs = dshArgs;
    this.defaultSyncTimeoutMs = defaultSyncTimeoutMs;
    this.resolveCwd = resolveCwd;
    this.resolveTimeoutMs = resolveTimeoutMs;
    this.truncate = truncate;
    this.log = log;
    this.workerId = workerId;
    this.onExit = onExit;

    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initPromise = null;
    this.agentInfo = null;
    this.stderrTail = [];
    this.activeTurn = null;
    this.sessionModels = new Map();
    this.queue = Promise.resolve();
  }

  isRunning() {
    return Boolean(this.proc && !this.proc.killed);
  }

  async ensureStarted() {
    if (this.proc && !this.proc.killed && this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const proc = spawn(this.dshBin, this.dshArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      this.proc = proc;
      this.stderrTail = [];

      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        this.stderrTail.push(text);
        if (this.stderrTail.length > 30) this.stderrTail.shift();
      });

      this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      this.rl.on("line", (line) => this.handleLine(line));

      proc.on("exit", (code, signal) => {
        if (this.proc !== proc) return;
        this.log(`[${this.workerId}] dsh ACP exited (code=${code}, signal=${signal})`);
        const err = new Error(
          `dsh ACP process exited unexpectedly (code=${code}, signal=${signal}). stderr: ${this.stderrTail
            .join("")
            .slice(-1500)}`
        );
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(err);
        }
        this.pending.clear();
        this.proc = null;
        this.rl = null;
        this.initPromise = null;
        this.activeTurn = null;
        this.sessionModels.clear();
        if (this.onExit) this.onExit(this.workerId);
      });

      proc.on("error", (err) => {
        if (this.proc !== proc) return;
        this.log(`[${this.workerId}] dsh ACP spawn error: ${err.message}`);
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(err);
        }
        this.pending.clear();
        this.proc = null;
        this.rl = null;
        this.initPromise = null;
        this.sessionModels.clear();
      });

      const initRes = await this.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
        },
        30_000
      );
      this.agentInfo = initRes?.agentInfo || null;
      return initRes;
    })();

    return this.initPromise;
  }

  sendRaw(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("dsh ACP process is not running.");
    }
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, timeoutMs = this.defaultSyncTimeoutMs, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError("Job cancelled"));
        return;
      }

      const id = this.nextId++;
      const cleanupListeners = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        this.pending.delete(id);
        cleanupListeners();
        reject(createAbortError("Job cancelled"));
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanupListeners();
        reject(new Error(`dsh ACP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (val) => {
          cleanupListeners();
          resolve(val);
        },
        reject: (err) => {
          cleanupListeners();
          reject(err);
        },
        timer,
        method,
      });

      try {
        this.sendRaw({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        cleanupListeners();
        reject(err);
      }
    });
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.log(`[${this.workerId}] Ignored non-JSON stdout from dsh ACP: ${trimmed.slice(0, 200)}`);
      return;
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(
          new Error(
            `dsh ACP error (${msg.error.code}): ${msg.error.message || JSON.stringify(msg.error)}`
          )
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.method) {
      this.handleIncomingRequest(msg);
      return;
    }

    if (msg.method === "session/update") {
      this.handleSessionUpdate(msg.params);
    }
  }

  handleIncomingRequest(msg) {
    if (msg.method === "session/request_permission") {
      const params = msg.params || {};
      const toolCall = params.toolCall || {};
      const options = params.options || [];
      const policy = this.activeTurn?.permissionPolicy || "read_only";
      let allow = policy === "allow_all" ? true : isReadOnlyToolCall(toolCall);
      let denyReason = "Blocked by read_only permission policy";

      // Even under allow_all, enforce path-level scope guard when target paths are detectable
      if (allow && this.activeTurn?.scopeConfig && !isReadOnlyToolCall(toolCall)) {
        const paths = extractPathsFromToolCall(toolCall, this.activeTurn.cwd);
        for (const p of paths) {
          const check = this.activeTurn.scopeConfig.checkPath(p, null);
          if (!check.allowed) {
            allow = false;
            denyReason = `Blocked by scope policy (${check.reason}: ${p} vs ${check.matchedRule})`;
            break;
          }
        }
      }

      const chosen = choosePermissionOption(options, allow);

      if (!allow && this.activeTurn) {
        this.activeTurn.deniedActions.push({
          title: toolCall.title || toolCall.name || "unknown",
          kind: toolCall.kind || "unknown",
          reason: denyReason,
        });
        this.emitActiveProgress(true);
      }

      const result = chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } };

      try {
        this.sendRaw({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        this.log(`[${this.workerId}] Failed to reply to session/request_permission: ${err.message}`);
      }
      return;
    }

    try {
      this.sendRaw({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
      });
    } catch {}
  }

  emitActiveProgress(force = false) {
    const turn = this.activeTurn;
    if (!turn || !turn.onProgress) return;
    const now = Date.now();
    if (!force && now - turn.lastEmit < 1000) return;
    turn.lastEmit = now;
    const calls = Array.from(turn.toolCalls.values());
    const latestTool = calls.length > 0 ? calls[calls.length - 1] : null;
    turn.onProgress({
      stage: "running",
      workerId: this.workerId,
      sessionId: turn.sessionId,
      activeModel: turn.activeModel,
      responseChars: turn.textChars,
      thoughtChars: turn.thoughtChars,
      toolCallCount: calls.length,
      latestTool: latestTool
        ? `${latestTool.title || latestTool.kind} (${latestTool.status || "running"})`
        : null,
      deniedCount: turn.deniedActions.length,
    });
  }

  handleSessionUpdate(params) {
    if (!this.activeTurn || !params) return;
    if (params.sessionId && params.sessionId !== this.activeTurn.sessionId) return;

    const update = params.update || params;
    const kind = update.sessionUpdate || update.type;

    if (kind === "agent_message_chunk") {
      const text =
        typeof update.content === "string"
          ? update.content
          : update.content?.type === "text"
            ? update.content.text
            : update.text || "";
      if (text) {
        this.activeTurn.textChunks.push(text);
        this.activeTurn.textChars += text.length;
        this.emitActiveProgress(false);
      }
    } else if (kind === "agent_thought_chunk") {
      const text =
        typeof update.content === "string"
          ? update.content
          : update.content?.type === "text"
            ? update.content.text
            : update.text || "";
      if (text) {
        this.activeTurn.thoughtChunks.push(text);
        this.activeTurn.thoughtChars += text.length;
        this.emitActiveProgress(false);
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = update.toolCallId || update.id || `tc-${this.activeTurn.toolCalls.size + 1}`;
      const prev = this.activeTurn.toolCalls.get(id) || {};
      this.activeTurn.toolCalls.set(id, {
        id,
        title: update.title || prev.title || "",
        kind: update.kind || prev.kind || "",
        status: update.status || prev.status || "",
      });
      this.emitActiveProgress(true);
    }
  }

  enqueue(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async runPrompt(
    args,
    {
      signal,
      onProgress,
      isAsync = false,
      scopeConfig = null,
      onSessionBound = null,
      onSessionInvalidated = null,
      sessionConfirmed = false,
    } = {}
  ) {
    return this.enqueue(async () => {
      if (signal?.aborted) {
        throw createAbortError("Job cancelled");
      }

      const prompt = args?.prompt;
      if (!prompt || typeof prompt !== "string") {
        throw new Error("`prompt` (string) is required.");
      }

      const cwd = this.resolveCwd(args.cwd);
      const permissionPolicy = args.permissionPolicy === "allow_all" ? "allow_all" : "read_only";
      const timeoutMs = this.resolveTimeoutMs(args, isAsync);

      if (onProgress) {
        onProgress({ stage: "starting", workerId: this.workerId, lastActivity: "Connecting to DSH ACP" });
      }

      await this.ensureStarted();

      let sessionId = args.sessionId ? String(args.sessionId) : null;
      let createdNew = false;
      let confirmedSession = Boolean(sessionId && sessionConfirmed);
      let activeModel = sessionId ? this.sessionModels.get(sessionId) || null : null;
      let modelOpt = null;
      if (!sessionId) {
        const created = await this.request("session/new", { cwd, mcpServers: [] }, 30_000, signal);
        sessionId = created?.sessionId;
        if (!sessionId) {
          throw new Error(`dsh ACP session/new returned no sessionId: ${JSON.stringify(created)}`);
        }
        modelOpt = Array.isArray(created?.configOptions)
          ? created.configOptions.find((opt) => opt.id === "model") || null
          : null;
        if (modelOpt?.currentValue) {
          activeModel = modelOpt.currentValue;
          this.sessionModels.set(sessionId, activeModel);
        }
        createdNew = true;
        confirmedSession = true;
        if (onSessionBound) {
          onSessionBound(sessionId);
        }
      }

      const requestedModel = args.model || process.env.DSH_DEFAULT_MODEL || "";
      const requestedProvider = args.provider || process.env.DSH_DEFAULT_PROVIDER || "";
      let modelSwitchWarning = null;

      if (requestedModel || requestedProvider) {
        const resolved = resolveDshModelOption(modelOpt || { currentValue: activeModel, options: [] }, {
          provider: requestedProvider,
          model: requestedModel,
        });
        if (resolved.note) {
          modelSwitchWarning = resolved.note;
          this.log(`[${this.workerId}] ${resolved.note}`);
        }
        if (resolved.needsSwitch && resolved.value) {
          try {
            const setRes = await this.request(
              "session/set_config_option",
              {
                sessionId,
                configId: "model",
                value: resolved.value,
              },
              15_000,
              signal
            );
            const updatedModelOpt = Array.isArray(setRes?.configOptions)
              ? setRes.configOptions.find((opt) => opt.id === "model")
              : null;
            activeModel = updatedModelOpt?.currentValue || resolved.value;
            this.sessionModels.set(sessionId, activeModel);
          } catch (err) {
            if (err.name === "AbortError") throw err;
            modelSwitchWarning = `Could not switch DSH model to ${resolved.value} (${err.message}); continued with ${activeModel || "DSH default"}.`;
            this.log(`[${this.workerId}] ${modelSwitchWarning}`);
          }
        }
      }

      if (args.reasoningEffort) {
        try {
          await this.request(
            "session/set_config_option",
            {
              sessionId,
              configId: "reasoning_effort",
              value: String(args.reasoningEffort),
            },
            15_000,
            signal
          );
        } catch (err) {
          if (err.name === "AbortError") throw err;
          this.log(`[${this.workerId}] session/set_config_option warning: ${err.message}`);
        }
      }

      this.activeTurn = {
        sessionId,
        cwd,
        activeModel,
        permissionPolicy,
        scopeConfig,
        textChunks: [],
        thoughtChunks: [],
        textChars: 0,
        thoughtChars: 0,
        toolCalls: new Map(),
        deniedActions: [],
        onProgress,
        lastEmit: 0,
      };
      this.emitActiveProgress(true);

      const onAbortCancel = () => {
        try {
          this.sendRaw({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId },
          });
        } catch {}
      };
      if (signal) signal.addEventListener("abort", onAbortCancel, { once: true });

      try {
        const promptRes = await this.request(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: prompt }],
          },
          timeoutMs,
          signal
        );

        const responseText = this.activeTurn.textChunks.join("");
        const toolCalls = Array.from(this.activeTurn.toolCalls.values());
        const deniedActions = this.activeTurn.deniedActions;

        return {
          backend: "dsh-acp",
          workerId: this.workerId,
          agentInfo: this.agentInfo,
          sessionId,
          createdNew,
          activeModel,
          ...(modelSwitchWarning ? { modelSwitchWarning } : {}),
          cwd,
          permissionPolicy,
          stopReason: promptRes?.stopReason || null,
          response: responseText,
          toolCalls,
          deniedActions,
        };
      } catch (err) {
        let outErr = err;
        if (err?.message?.includes("timed out")) {
          onAbortCancel();
          outErr = new Error(
            `${err.message}${isAsync ? "" : " (use async: true for long-running coding tasks)"}`
          );
        }
        const invalidSession = INVALID_SESSION_RE.test(String(outErr?.message || ""));
        if (invalidSession && sessionId) {
          this.sessionModels.delete(sessionId);
          confirmedSession = false;
          if (onSessionInvalidated) {
            onSessionInvalidated(sessionId);
          }
        }
        if (outErr && typeof outErr === "object") {
          if (sessionId && confirmedSession && this.isRunning() && !outErr.sessionId) {
            outErr.sessionId = sessionId;
          }
          if (!outErr.workerId) outErr.workerId = this.workerId;
        }
        throw outErr;
      } finally {
        if (signal) signal.removeEventListener("abort", onAbortCancel);
        this.activeTurn = null;
      }
    });
  }

  async closeSession(sessionId) {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("`sessionId` (string) is required.");
    }
    if (!this.proc) {
      return { closed: false, reason: "dsh ACP is not currently running." };
    }
    await this.request("session/close", { sessionId }, 15_000);
    this.sessionModels.delete(sessionId);
    return { closed: true, sessionId, workerId: this.workerId };
  }

  dispose() {
    const proc = this.proc;
    const rl = this.rl;
    this.proc = null;
    this.rl = null;
    this.initPromise = null;
    this.activeTurn = null;
    this.sessionModels.clear();

    const disposeErr = new Error(`dsh ACP worker '${this.workerId}' disposed`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(disposeErr);
    }
    this.pending.clear();

    if (rl) {
      try {
        rl.removeAllListeners();
        rl.close();
      } catch {}
    }
    if (proc) {
      try {
        proc.removeAllListeners();
        proc.stderr?.removeAllListeners();
        proc.stdout?.removeAllListeners();
      } catch {}
      if (!proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }
    }
  }
}

export class DshAcpPool {
  constructor({
    dshBin,
    dshArgs = ["--profile", "acp"],
    maxConcurrency = 3,
    idleTimeoutMs = 600_000,
    boundSessionIdleTimeoutMs = null,
    defaultSyncTimeoutMs = 150_000,
    resolveCwd,
    resolveTimeoutMs,
    truncate,
    log = () => {},
  }) {
    this.dshBin = dshBin;
    this.dshArgs = dshArgs;
    this.maxConcurrency = Math.min(Math.max(Number(maxConcurrency) || 3, 1), 6);
    this.idleTimeoutMs = Math.max(Number(idleTimeoutMs) || 600_000, 10_000);
    const parsedBoundIdle = Number(boundSessionIdleTimeoutMs);
    this.boundSessionIdleTimeoutMs =
      Number.isFinite(parsedBoundIdle) && parsedBoundIdle > 0
        ? Math.max(parsedBoundIdle, this.idleTimeoutMs)
        : Math.max(this.idleTimeoutMs * 3, 1_800_000);
    this.defaultSyncTimeoutMs = defaultSyncTimeoutMs;
    this.resolveCwd = resolveCwd;
    this.resolveTimeoutMs = resolveTimeoutMs;
    this.truncate = truncate;
    this.log = log;

    this.nextWorkerNum = 1;
    this.slots = new Map(); // workerId -> { id, client, busy, lastUsedAt, boundSessions: Set<string> }
    this.sessionToWorker = new Map(); // sessionId -> workerId
    this.waiters = [];

    this.reaper = setInterval(() => this.reapIdleWorkers(), 60_000);
    if (typeof this.reaper.unref === "function") this.reaper.unref();
  }

  createSlot() {
    const id = `dsh-${this.nextWorkerNum++}`;
    const client = new DshAcpClient({
      dshBin: this.dshBin,
      dshArgs: this.dshArgs,
      defaultSyncTimeoutMs: this.defaultSyncTimeoutMs,
      resolveCwd: this.resolveCwd,
      resolveTimeoutMs: this.resolveTimeoutMs,
      truncate: this.truncate,
      log: this.log,
      workerId: id,
      onExit: (exitedId) => this.handleWorkerExit(exitedId),
    });
    const slot = {
      id,
      client,
      busy: false,
      lastUsedAt: Date.now(),
      boundSessions: new Set(),
    };
    this.slots.set(id, slot);
    return slot;
  }

  handleWorkerExit(workerId) {
    const slot = this.slots.get(workerId);
    if (!slot) return;
    for (const sid of slot.boundSessions) {
      if (this.sessionToWorker.get(sid) === workerId) {
        this.sessionToWorker.delete(sid);
      }
    }
    slot.boundSessions.clear();
  }

  pickIdleSlot() {
    let best = null;
    for (const slot of this.slots.values()) {
      if (slot.busy) continue;
      if (!best) {
        best = slot;
      } else if (slot.client.isRunning() && !best.client.isRunning()) {
        best = slot;
      } else if (slot.boundSessions.size < best.boundSessions.size) {
        best = slot;
      }
    }
    return best;
  }

  async acquireSlot(sessionId, signal, onProgress) {
    if (signal?.aborted) {
      throw createAbortError("Job cancelled");
    }

    // Session affinity: route follow-up turns to the worker that owns the sessionId
    if (sessionId && this.sessionToWorker.has(sessionId)) {
      const targetId = this.sessionToWorker.get(sessionId);
      const target = this.slots.get(targetId);
      if (target) {
        if (!target.busy) {
          target.busy = true;
          return target;
        }
        if (onProgress) {
          onProgress({
            stage: "queued",
            workerId: target.id,
            lastActivity: `Waiting for bound DSH worker ${target.id}`,
          });
        }
        return this.waitForSlot((slot) => slot.id === target.id, signal);
      }
      this.sessionToWorker.delete(sessionId);
    }

    const idle = this.pickIdleSlot();
    if (idle) {
      idle.busy = true;
      return idle;
    }

    if (this.slots.size < this.maxConcurrency) {
      const fresh = this.createSlot();
      fresh.busy = true;
      return fresh;
    }

    if (onProgress) {
      onProgress({
        stage: "queued",
        lastActivity: `Waiting for free DSH pool slot (${this.slots.size}/${this.maxConcurrency} busy)`,
      });
    }
    return this.waitForSlot(() => true, signal);
  }

  waitForSlot(predicate, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError("Job cancelled"));
        return;
      }
      const waiter = {
        predicate,
        resolve: (slot) => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(slot);
        },
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(createAbortError("Job cancelled"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  releaseSlot(slot) {
    slot.lastUsedAt = Date.now();
    const idx = this.waiters.findIndex((w) => w.predicate(slot));
    if (idx !== -1) {
      const [waiter] = this.waiters.splice(idx, 1);
      // Hand off slot directly while keeping busy=true
      waiter.resolve(slot);
      return;
    }
    slot.busy = false;
  }

  reapIdleWorkers(now = Date.now()) {
    for (const [id, slot] of this.slots.entries()) {
      if (slot.busy) continue;
      const idleMs = now - slot.lastUsedAt;
      if (slot.boundSessions.size === 0) {
        if (this.slots.size <= 1) continue;
        if (idleMs >= this.idleTimeoutMs) {
          this.log(`[${id}] Reaping idle DSH ACP worker`);
          slot.client.dispose();
          this.slots.delete(id);
        }
      } else if (idleMs >= this.boundSessionIdleTimeoutMs) {
        this.log(
          `[${id}] Reaping stale bound DSH ACP worker (${slot.boundSessions.size} idle session(s))`
        );
        this.handleWorkerExit(id);
        slot.client.dispose();
        if (this.slots.size > 1) {
          this.slots.delete(id);
        }
      }
    }
  }

  async runPrompt(args, hooks = {}) {
    const requestedSessionId = args?.sessionId ? String(args.sessionId) : null;
    const slot = await this.acquireSlot(requestedSessionId, hooks.signal, hooks.onProgress);
    const sessionConfirmed = Boolean(
      requestedSessionId &&
        slot.boundSessions.has(requestedSessionId) &&
        this.sessionToWorker.get(requestedSessionId) === slot.id
    );
    const bindSession = (sid) => {
      if (!sid) return;
      slot.boundSessions.add(sid);
      this.sessionToWorker.set(sid, slot.id);
    };
    const invalidateSession = (sid) => {
      if (!sid) return;
      slot.boundSessions.delete(sid);
      if (this.sessionToWorker.get(sid) === slot.id) {
        this.sessionToWorker.delete(sid);
      }
    };
    try {
      const res = await slot.client.runPrompt(args, {
        ...hooks,
        sessionConfirmed,
        onSessionBound: bindSession,
        onSessionInvalidated: invalidateSession,
      });
      if (res?.sessionId) {
        bindSession(res.sessionId);
      }
      return res;
    } finally {
      this.releaseSlot(slot);
    }
  }

  async closeSession(sessionId) {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("`sessionId` (string) is required.");
    }
    const workerId = this.sessionToWorker.get(sessionId);
    let slot = workerId ? this.slots.get(workerId) : null;
    if (!slot) {
      return { closed: false, sessionId, reason: "No active DSH worker holds this sessionId." };
    }
    if (!slot.busy) {
      slot.busy = true;
    } else {
      slot = await this.waitForSlot((s) => s.id === workerId, null);
    }
    try {
      const res = await slot.client.closeSession(sessionId);
      slot.boundSessions.delete(sessionId);
      if (this.sessionToWorker.get(sessionId) === slot.id) {
        this.sessionToWorker.delete(sessionId);
      }
      return res;
    } finally {
      this.releaseSlot(slot);
    }
  }

  getPoolStats() {
    let busyWorkers = 0;
    let runningWorkers = 0;
    for (const slot of this.slots.values()) {
      if (slot.busy) busyWorkers += 1;
      if (slot.client.isRunning()) runningWorkers += 1;
    }
    return {
      maxConcurrency: this.maxConcurrency,
      activeWorkers: this.slots.size,
      runningWorkers,
      busyWorkers,
      queuedWaiters: this.waiters.length,
      boundSessions: this.sessionToWorker.size,
    };
  }

  async ensurePrimaryHandshake() {
    let slot = this.slots.values().next().value;
    if (!slot) slot = this.createSlot();
    return slot.client.ensureStarted();
  }

  dispose() {
    clearInterval(this.reaper);
    for (const slot of this.slots.values()) {
      slot.client.dispose();
    }
    this.slots.clear();
    this.sessionToWorker.clear();
  }
}
