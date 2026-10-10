import {
  routeAiTask,
  type AiImage,
  type RoutedAiResult,
} from "../server/ai-router";
import type { AiTaskContext, AiTaskId } from "../lib/ai-policy";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  constants,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  query,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CancelledError,
  currentSignal,
  assertExecutionCurrent,
  currentExecutionTimeout,
  isCancelled,
  registerSpawnedProcess,
  closeSpawnedProcess,
  terminateProcessGroup,
} from "./exec";
import type { AgentId, AgentInfo } from "../lib/types";

export class ClaudeAuthError extends Error {}

/**
 * One-shot Claude call through the Agent SDK (billed to the `claude` login on this machine).
 * Fails fast on auth errors instead of silently retrying for minutes, and drops
 * ANTHROPIC_API_KEY from the subprocess so usage goes to the Claude plan
 * (set CAPY_USE_API_KEY=1 to keep it).
 */
async function askClaudeRaw(
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options,
  o: {
    timeoutMs?: number;
    onRetry?: (msg: string) => void;
    retryLimit?: number;
  } = {},
): Promise<any> {
  assertExecutionCurrent();
  const abortController = new AbortController();
  const outer = currentSignal();
  if (outer?.aborted) throw new CancelledError();
  const onOuterAbort = () => abortController.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  const env: Record<string, string | undefined> = { ...process.env };
  if (!(process.env.CAPY_USE_API_KEY ?? process.env.CLIPRUN_USE_API_KEY))
    delete env.ANTHROPIC_API_KEY;
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, o.timeoutMs)
    : undefined;

  let result: any;
  const spawned: { pid: number; token: string }[] = [];
  const kills = new Map<number, Promise<void>>();
  function stopProcess(pid: number, token: string) {
    if (!kills.has(pid)) kills.set(pid, terminateProcessGroup(pid, 150, token));
    return kills.get(pid)!;
  }
  const spawnClaudeCodeProcess: NonNullable<
    Options["spawnClaudeCodeProcess"]
  > = (input) => {
    const token = randomUUID();
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      // Do not merge process.env: subscription auth intentionally removed its API key.
      env: {
        ...input.env,
        CAPY_PROCESS_TOKEN: token,
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const onAbort = () => {
      if (child.pid) void stopProcess(child.pid, token);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", () =>
      input.signal?.removeEventListener("abort", onAbort),
    );
    child.stderr.on("data", () => {});
    if (child.pid) {
      spawned.push({ pid: child.pid, token });
      try {
        registerSpawnedProcess(child.pid, token);
      } catch (error) {
        void stopProcess(child.pid, token);
        throw error;
      }
      child.kill = () => {
        void stopProcess(child.pid!, token);
        return true;
      };
    }
    return child;
  };
  try {
    for await (const m of query({
      prompt,
      options: { ...options, env, abortController, spawnClaudeCodeProcess },
    })) {
      if (m.type === "system" && (m as any).subtype === "api_retry") {
        const r = m as any;
        if (r.error_status === 401 || r.error_status === 403) {
          abortController.abort();
          throw new ClaudeAuthError(
            "Claude login missing or expired. Run `claude`, log in, then try again.",
          );
        }
        if (r.attempt > (o.retryLimit ?? 0)) {
          abortController.abort();
          throw Error("Claude internal retry ceiling exhausted");
        }
        o.onRetry?.(
          `Claude API retry ${r.attempt}/${r.max_retries} (${r.error_status ?? "network error"})`,
        );
      }
      if (m.type === "result") result = m;
    }
  } catch (e) {
    if (outer?.aborted) throw new CancelledError();
    if (e instanceof ClaudeAuthError) throw e;
    if (timedOut)
      throw new Error(
        `Claude did not answer within ${Math.round(o.timeoutMs! / 1000)}s`,
      );
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
    for (const child of spawned) {
      await stopProcess(child.pid, child.token);
      closeSpawnedProcess(child.pid);
    }
  }
  if (outer?.aborted) throw new CancelledError();

  if (!result)
    throw new Error(
      timedOut ? "Claude timed out" : "Claude returned no result",
    );
  if (result.is_error) {
    const text = String(result.result ?? result.subtype);
    if (/log ?in|auth/i.test(text))
      throw new ClaudeAuthError(`${text}. Run \`claude\` and log in.`);
    throw new Error(`Claude returned an error: ${text}`);
  }
  return result;
}

interface RunCtx {
  prompt: string;
  model?: string;
  /** Scratch folder the CLI runs in (and may write its answer to). */
  dir: string;
}

interface AgentSpec {
  id: AgentId;
  name: string;
  vendor: string;
  /** Binaries to look for, first match wins. */
  bins: string[];
  install: string;
  url: string;
  modelHint: string;
  /** Non-interactive invocation. Claude has none: it runs through the Agent SDK. */
  argv?: (
    c: RunCtx,
  ) => Promise<{ args: string[]; stdin?: string; outFile?: string }>;
}

export const AGENT_SPECS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    bins: ["claude"],
    install: "npm i -g @anthropic-ai/claude-code",
    url: "https://claude.com/claude-code",
    modelHint: "claude-sonnet-5",
  },
  {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    bins: ["codex"],
    install: "npm i -g @openai/codex",
    url: "https://github.com/openai/codex",
    modelHint: "gpt-5",
    argv: async ({ prompt, model, dir }) => {
      const outFile = path.join(dir, "answer.txt");
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-C",
        dir,
        "-o",
        outFile,
      ];
      if (model) args.push("-m", model);
      args.push("-");
      return { args, stdin: prompt, outFile };
    },
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    vendor: "Cursor",
    bins: ["cursor-agent"],
    install: "curl https://cursor.com/install -fsS | bash",
    url: "https://cursor.com/cli",
    modelHint: "sonnet-4.5",
    argv: async ({ prompt, model, dir }) => {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--mode",
        "ask",
        "--trust",
        "--workspace",
        dir,
      ];
      if (model) args.push("--model", model);
      args.push(prompt);
      return { args };
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    bins: ["gemini"],
    install: "npm i -g @google/gemini-cli",
    url: "https://github.com/google-gemini/gemini-cli",
    modelHint: "gemini-2.5-pro",
    argv: async ({ prompt, model }) => {
      const args = ["--output-format", "json"];
      if (model) args.push("-m", model);
      args.push("-p", prompt);
      return { args };
    },
  },
  {
    id: "qwen",
    name: "Qwen Code",
    vendor: "Alibaba",
    bins: ["qwen"],
    install: "npm i -g @qwen-code/qwen-code",
    url: "https://github.com/QwenLM/qwen-code",
    modelHint: "qwen3-coder-plus",
    argv: async ({ prompt, model }) => {
      const args: string[] = [];
      if (model) args.push("-m", model);
      args.push("-p", prompt);
      return { args };
    },
  },
  {
    id: "opencode",
    name: "opencode",
    vendor: "SST",
    bins: ["opencode"],
    install: "curl -fsSL https://opencode.ai/install | bash",
    url: "https://opencode.ai",
    modelHint: "anthropic/claude-sonnet-5",
    argv: async ({ prompt, model }) => {
      const args = ["run"];
      if (model) args.push("-m", model);
      args.push(prompt);
      return { args };
    },
  },
  {
    id: "droid",
    name: "Droid",
    vendor: "Factory",
    bins: ["droid"],
    install: "curl -fsSL https://app.factory.ai/cli | sh",
    url: "https://factory.ai",
    modelHint: "claude-sonnet-5",
    argv: async ({ prompt, model, dir }) => {
      const file = path.join(dir, "prompt.txt");
      await writeFile(file, prompt);
      const args = ["exec", "-o", "json", "--cwd", dir, "-f", file];
      if (model) args.push("-m", model);
      return { args };
    },
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    vendor: "GitHub",
    bins: ["copilot"],
    install: "npm i -g @github/copilot",
    url: "https://github.com/github/copilot-cli",
    modelHint: "gpt-5",
    argv: async ({ prompt, model }) => {
      const args: string[] = [];
      if (model) args.push("--model", model);
      args.push("-s", "-p", prompt);
      return { args };
    },
  },
  {
    id: "amp",
    name: "Amp",
    vendor: "Sourcegraph",
    bins: ["amp"],
    install: "npm i -g @sourcegraph/amp",
    url: "https://ampcode.com",
    modelHint: "",
    argv: async ({ prompt }) => ({ args: ["-x", prompt] }),
  },
];

export function agentSpec(id: string): AgentSpec {
  const s = AGENT_SPECS.find((a) => a.id === id);
  if (!s)
    throw new Error(
      `Unknown AI "${id}". Known: ${AGENT_SPECS.map((a) => a.id).join(", ")}`,
    );
  return s;
}

/**
 * Where CLIs usually land. A dev server started from a GUI often has a bare PATH,
 * so look in the common install folders too.
 */
function searchDirs(): string[] {
  const home = homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".claude/local"),
    path.join(home, "Library/pnpm"),
    path.join(home, ".bun/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".opencode/bin"),
    path.join(home, ".factory/bin"),
    path.join(home, ".cargo/bin"),
    // npm -g under nvm (codex is often installed this way); newest Node first
    ...nvmBins(home),
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [
    ...new Set([
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
      ...extra,
    ]),
  ];
}

function nvmBins(home: string): string[] {
  try {
    return readdirSync(path.join(home, ".nvm/versions/node"))
      .sort((x, y) => y.localeCompare(x, undefined, { numeric: true }))
      .map((v) => path.join(home, ".nvm/versions/node", v, "bin"));
  } catch {
    return [];
  }
}

/** PATH for child processes: node-based CLIs need `node` next to them. */
function childPath(): string {
  return searchDirs().join(path.delimiter);
}

async function findBin(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    for (const dir of searchDirs()) {
      const p = path.join(dir, name);
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnText(
  bin: string,
  args: string[],
  o: { stdin?: string; cwd?: string; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const signal = currentSignal();
    if (signal?.aborted) return reject(new CancelledError());
    try {
      assertExecutionCurrent();
    } catch (error) {
      return reject(error);
    }
    const token = randomUUID();
    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: {
        ...process.env,
        PATH: childPath(),
        NO_COLOR: "1",
        CI: "1",
        CAPY_PROCESS_TOKEN: token,
      },
      stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let error: Error | undefined;
    let killing: Promise<void> | undefined;
    const stop = () => {
      if (child.pid && !killing)
        killing = terminateProcessGroup(child.pid, 150, token);
    };
    const abort = () => {
      error = new CancelledError();
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.min(o.timeoutMs, currentExecutionTimeout() ?? Infinity),
    );
    try {
      if (child.pid) registerSpawnedProcess(child.pid, token);
    } catch (e) {
      error = e as Error;
      stop();
    }
    child.stdout!.on("data", (data: Buffer) => {
      if (Buffer.byteLength(stdout) + data.length > 16 * 1024 * 1024) {
        error = new Error("AI subprocess output limit exceeded");
        stop();
      } else stdout += data.toString();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-32 * 1024);
    });
    child.on("error", (e) => {
      error = isCancelled(e) ? new CancelledError() : e;
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // A retry must wait until descendants from the previous attempt are gone.
      if (killing) await killing;
      if (child.pid) closeSpawnedProcess(child.pid);
      if (error || signal?.aborted)
        return reject(error ?? new CancelledError());
      resolve({ code, stdout, stderr, timedOut });
    });
    if (o.stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(o.stdin);
    }
  });
}

let cache: { at: number; list: AgentInfo[] } | null = null;

/** Look for every known AI CLI on this machine. Cached for a minute; pass fresh to rescan. */
export async function detectAgents(fresh = false): Promise<AgentInfo[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.list;
  const list = await Promise.all(
    AGENT_SPECS.map(async (s): Promise<AgentInfo> => {
      const found = await findBin(s.bins);
      let version: string | undefined;
      if (found) {
        const r = await spawnText(found, ["--version"], {
          timeoutMs: 8000,
        }).catch(() => null);
        const line =
          r?.code === 0
            ? (r.stdout || r.stderr).trim().split("\n")[0]
            : undefined;
        version =
          line
            ?.replace(/^[^\d]*(?=\d)/, "")
            .split(/\s/)[0]!
            .slice(0, 40) || undefined;
      }
      return {
        id: s.id,
        name: s.name,
        vendor: s.vendor,
        bin: s.bins[0]!,
        // Claude runs through the Agent SDK bundled with capy, so it works without the CLI on PATH
        installed: s.id === "claude" ? true : Boolean(found),
        path: found,
        version,
        install: s.install,
        url: s.url,
        modelHint: s.modelHint,
      };
    }),
  );
  cache = { at: Date.now(), list };
  return list;
}

export interface AskOpts {
  task?: AiTaskId;
  context?: AiTaskContext;
  validate?: (data: unknown) => boolean;
  maxBudgetUsd?: number;
  retryLimit?: number;
  model?: string;
  system: string;
  /** JSON Schema the answer must match. */
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxTurns?: number;
  timeoutMs?: number;
  onRetry?: (msg: string) => void;
  /** Stills for a vision task; only Claude accepts them. */
  images?: AiImage[];
}

export interface AskResult extends RoutedAiResult {}

/** One user turn holding the text prompt followed by each labelled image (Messages API content blocks). */
export function claudeImagePrompt(
  prompt: string,
  images: AiImage[],
): AsyncIterable<SDKUserMessage> {
  const content = [
    { type: "text" as const, text: prompt },
    ...images.flatMap((image) => [
      ...(image.label ? [{ type: "text" as const, text: image.label }] : []),
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mediaType,
          data: image.data,
        },
      },
    ]),
  ];
  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } satisfies SDKUserMessage;
  })();
}

/** One-shot structured question to the chosen AI. Claude goes through the Agent SDK; the rest run their CLI headless. */
export async function askAgent(
  agent: AgentId,
  prompt: string,
  o: AskOpts,
): Promise<AskResult> {
  return routeAiTask(
    { ...o, task: o.task ?? "edit-assistance", agent, prompt },
    (selected, input, bounded) =>
      askAgentRaw(selected, input, { ...o, ...bounded }),
  );
}

/** Compatibility export for diagnostics; every public call still enters task routing. */
export async function askClaude(
  prompt: string,
  options: Options,
  o: { timeoutMs?: number; onRetry?: (msg: string) => void } = {},
): Promise<any> {
  const result = await askAgent("claude", prompt, {
    task: "diagnostic",
    model: options.model,
    system:
      typeof options.systemPrompt === "string"
        ? options.systemPrompt
        : "Answer the diagnostic as JSON: {ok: true}.",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    ...o,
  });
  return {
    result: JSON.stringify(result.data),
    structured_output: result.data,
    total_cost_usd: result.costUsd,
  };
}
async function askAgentRaw(
  agent: AgentId,
  prompt: string,
  o: AskOpts,
): Promise<AskResult> {
  if (o.images?.length && agent !== "claude")
    throw Error(`${agent} cannot look at images; only Claude can`);
  if (agent === "claude") {
    const options: Options = {
      model: o.model,
      maxBudgetUsd: o.maxBudgetUsd,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: o.maxTurns ?? 2,
      effort: o.effort ?? "medium",
      systemPrompt: o.system,
      outputFormat: { type: "json_schema", schema: o.schema },
    };
    const r = await askClaudeRaw(
      o.images?.length ? claudeImagePrompt(prompt, o.images) : prompt,
      options,
      {
        timeoutMs: o.timeoutMs,
        onRetry: o.onRetry,
        retryLimit: o.retryLimit,
      },
    );
    const modelUsage = Object.values(r.modelUsage ?? {}) as {
      canonicalModel?: string;
      costBasis?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }[];
    const knownEstimate =
      typeof r.total_cost_usd === "number" &&
      Number.isFinite(r.total_cost_usd) &&
      r.total_cost_usd >= 0 &&
      !modelUsage.some((usage) => usage.costBasis === "unknown");
    // SDK result.usage covers only the main loop; modelUsage is cumulative
    // across the query pipeline. Neither receipt proves provider invoice totals.
    const hasTokenReceipt =
      modelUsage.length > 0 &&
      modelUsage.every((usage) =>
        [
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadInputTokens,
          usage.cacheCreationInputTokens,
        ].every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        ),
      );
    return {
      data: r.structured_output ?? extractJson(r.result),
      costUsd: knownEstimate ? r.total_cost_usd : undefined,
      cost: {
        basis: knownEstimate ? "estimated" : "unknown",
        ...(knownEstimate ? { value: r.total_cost_usd } : {}),
      },
      turns: r.num_turns,
      actualModel:
        modelUsage.length === 1 ? modelUsage[0]?.canonicalModel : undefined,
      ...(hasTokenReceipt
        ? {
            usage: {
              inputTokens: modelUsage.reduce(
                (sum, usage) =>
                  sum +
                  usage.inputTokens! +
                  usage.cacheReadInputTokens! +
                  usage.cacheCreationInputTokens!,
                0,
              ),
              outputTokens: modelUsage.reduce(
                (sum, usage) => sum + usage.outputTokens!,
                0,
              ),
            },
          }
        : {}),
    };
  }

  const spec = agentSpec(agent);
  const bin = await findBin(spec.bins);
  if (!bin)
    throw new Error(
      `${spec.name} is not installed (no \`${spec.bins[0]}\` found). Install it with: ${spec.install}`,
    );

  const full = `${o.system}

${prompt}

Answer with only one JSON object that matches this JSON Schema. No prose, no code fences, do not use any tools:
${JSON.stringify(o.schema)}`;

  const dir = await mkdtemp(path.join(tmpdir(), `capy-${agent}-`));
  try {
    const { args, stdin, outFile } = await spec.argv!({
      prompt: full,
      model: o.model,
      dir,
    });
    const r = await spawnText(bin, args, {
      stdin,
      cwd: dir,
      timeoutMs: o.timeoutMs ?? 10 * 60_000,
    });
    if (r.timedOut)
      throw new Error(
        `${spec.name} did not answer within ${Math.round((o.timeoutMs ?? 600_000) / 1000)}s`,
      );

    let text = stripAnsi(r.stdout);
    if (outFile)
      text = (await readFile(outFile, "utf8").catch(() => "")) || text;
    const envelope = parseEnvelope(text);
    if (envelope?.error) throw new Error(`${spec.name}: ${envelope.error}`);
    if (r.code !== 0)
      throw new Error(
        `${spec.name} exited with code ${r.code}: ${lastLines(stripAnsi(r.stderr) || text)}`,
      );

    const data = extractJson(envelope?.text ?? text);
    if (data === undefined)
      throw new Error(
        `${spec.name} did not answer with JSON: ${lastLines(envelope?.text ?? text)}`,
      );
    return { data, cost: { basis: "unknown" } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Cheap round trip to prove the AI is installed, logged in and answering. */
export async function testAgent(
  agent: AgentId,
  model?: string,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const r = await askAgent(agent, 'Reply with {"ok": true}.', {
      model,
      task: "diagnostic",
      system: "You are a health check. Answer only with the requested JSON.",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      effort: "low",
      timeoutMs: 120_000,
    });
    const ok = (r.data as { ok?: unknown } | undefined)?.ok === true;
    return {
      ok,
      ms: Date.now() - t0,
      error: ok ? undefined : "Answered, but not with the expected JSON",
    };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Headless CLIs wrap the answer in a JSON result object (cursor, droid, gemini); unwrap it. */
function parseEnvelope(
  s: string,
): { text?: string; error?: string } | undefined {
  let o: any;
  try {
    o = JSON.parse(s.trim());
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  if (o.is_error)
    return { error: String(o.result ?? o.error ?? "unknown error") };
  if (o.error && typeof o.response !== "string")
    return {
      error:
        typeof o.error === "string"
          ? o.error
          : (o.error.message ?? JSON.stringify(o.error)),
    };
  const text =
    typeof o.result === "string"
      ? o.result
      : typeof o.response === "string"
        ? o.response
        : undefined;
  return text === undefined ? undefined : { text };
}

/** Pull the JSON object out of a reply that may have fences or chatter around it. */
export function extractJson(s: unknown): unknown {
  if (typeof s !== "string") return undefined;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Short error text: the API message when the CLI printed a JSON error, else the last few lines. */
function lastLines(s: string) {
  const msgs = [...s.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  if (msgs.length) return msgs.at(-1)![1]!.replace(/\\"/g, '"').slice(0, 400);
  return s.trim().split("\n").slice(-4).join(" ").slice(0, 400) || "no output";
}
