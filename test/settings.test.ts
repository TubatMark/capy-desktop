import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODELS } from "../lib/types";
import { applyToEnv, dataDir, effective, loadSettings, redact, resetSettingsCache, saveSettings, settingsFile } from "../server/settings";

const ENV_KEYS = ["CAPY_DATA_DIR", "CAPY_BROWSER", "CAPY_OUTPUT", "CAPY_MODEL", "CAPY_USE_API_KEY", "ANTHROPIC_API_KEY", "CLIPRUN_BROWSER", "CLIPRUN_MODEL", "CLIPRUN_OUTPUT", "CLIPRUN_USE_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

let root: string;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = mkdtempSync(path.join(tmpdir(), "capy-settings-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // a fresh data dir per test so nothing leaks between them
  process.env.CAPY_DATA_DIR = path.join(root, String(++n));
  resetSettingsCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetSettingsCache();
});

describe("settings", () => {
  it("uses CAPY_DATA_DIR and falls back to Application Support", () => {
    expect(dataDir()).toBe(process.env.CAPY_DATA_DIR);
    expect(settingsFile()).toBe(path.join(process.env.CAPY_DATA_DIR!, "settings.json"));
    delete process.env.CAPY_DATA_DIR;
    expect(dataDir()).toMatch(/Library\/Application Support\/capy$/);
  });

  it("returns defaults when there is no file", () => {
    expect(existsSync(settingsFile())).toBe(false);
    expect(loadSettings()).toEqual({ agent: "claude", models: {}, claudeAuth: "subscription" });
    const e = effective();
    expect(e.browser).toBeUndefined();
    expect(e.outputDir).toBeUndefined();
    expect(e.model).toBe(MODELS[0].id);
    expect(e.claudeAuth).toBe("subscription");
  });

  it("falls back to environment variables", () => {
    process.env.CAPY_BROWSER = "chrome";
    process.env.CAPY_MODEL = "claude-opus-5-5";
    process.env.CAPY_OUTPUT = "~/clips";
    process.env.CAPY_USE_API_KEY = "1";
    process.env.ANTHROPIC_API_KEY = "sk-env-1234";
    const e = effective();
    expect(e.browser).toBe("chrome");
    expect(e.model).toBe("claude-opus-5-5");
    expect(e.outputDir).toBe(path.join(process.env.HOME!, "clips"));
    expect(e.claudeAuth).toBe("apiKey");
    expect(e.apiKey).toBe("sk-env-1234");
    // env does not leak into what is stored
    expect(loadSettings()).toEqual({ agent: "claude", models: {}, claudeAuth: "subscription" });
  });

  it("lets settings.json win over the environment", () => {
    process.env.CAPY_BROWSER = "chrome";
    process.env.CAPY_MODEL = "claude-opus-5-5";
    saveSettings({ browser: "safari", models: { claude: "claude-haiku-4-5-20251001" }, outputDir: "/tmp/x" });
    const e = effective();
    expect(e.browser).toBe("safari");
    expect(e.model).toBe("claude-haiku-4-5-20251001");
    expect(e.outputDir).toBe("/tmp/x");
  });

  it("writes the file with mode 0600 and creates the folder", () => {
    saveSettings({ apiKey: "sk-ant-secret-9876" });
    const file = settingsFile();
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ apiKey: "sk-ant-secret-9876" });
    // still 0600 after a second write
    saveSettings({ browser: "arc" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("merges partial patches and clears keys with an empty string", () => {
    saveSettings({ browser: "chrome", models: { claude: "claude-opus-5-5" } });
    expect(loadSettings()).toEqual({ agent: "claude", models: { claude: "claude-opus-5-5" }, claudeAuth: "subscription", browser: "chrome" });
    saveSettings({ browser: "" });
    expect(loadSettings()).toEqual({ agent: "claude", models: { claude: "claude-opus-5-5" }, claudeAuth: "subscription" });
    saveSettings({ claudeAuth: "apiKey", apiKey: "sk-abc-1234", checkedAt: 42 });
    expect(loadSettings()).toEqual({ agent: "claude", models: { claude: "claude-opus-5-5" }, claudeAuth: "apiKey", apiKey: "sk-abc-1234", checkedAt: 42 });
    // undefined means "leave alone"; per-agent models merge, and "" drops one
    saveSettings({ models: undefined });
    expect(loadSettings().models.claude).toBe("claude-opus-5-5");
    saveSettings({ models: { codex: "gpt-5" } });
    expect(loadSettings().models).toEqual({ claude: "claude-opus-5-5", codex: "gpt-5" });
    saveSettings({ models: { claude: "" } });
    expect(loadSettings().models).toEqual({ codex: "gpt-5" });
    expect(effective().model).toBe(MODELS[0].id);
    // survives a cache reset (i.e. it really is on disk)
    resetSettingsCache();
    expect(loadSettings().apiKey).toBe("sk-abc-1234");
  });

  it("redacts the API key", () => {
    const base = { agent: "claude" as const, models: {} };
    expect(redact({ ...base, claudeAuth: "apiKey", apiKey: "sk-ant-api03-abcdef1234" })).toEqual({ ...base, claudeAuth: "apiKey", apiKey: "••••1234" });
    expect(redact({ ...base, claudeAuth: "subscription", browser: "chrome" })).toEqual({ ...base, claudeAuth: "subscription", browser: "chrome" });
    expect(redact({ ...base, claudeAuth: "subscription", apiKey: "" })).not.toHaveProperty("apiKey");
  });

  it("reads the old single `model` key as the Claude model", () => {
    mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ model: "claude-opus-5-5" }));
    resetSettingsCache();
    expect(loadSettings().models).toEqual({ claude: "claude-opus-5-5" });
    expect(effective().model).toBe("claude-opus-5-5");
  });

  it("ignores junk in the file", () => {
    saveSettings({ browser: "chrome" });
    // hand-edit the file with unknown keys / wrong types
    const file = settingsFile();
    writeFileSync(file, JSON.stringify({ browser: 5, model: "", models: { nope: "x", codex: 3 }, agent: "hal", nope: true, claudeAuth: "other", checkedAt: "x" }));
    resetSettingsCache();
    expect(loadSettings()).toEqual({ agent: "claude", models: {}, claudeAuth: "subscription" });
    writeFileSync(file, "not json");
    resetSettingsCache();
    expect(loadSettings()).toEqual({ agent: "claude", models: {}, claudeAuth: "subscription" });
  });

  it("applyToEnv sets and clears CAPY_USE_API_KEY / ANTHROPIC_API_KEY", () => {
    applyToEnv();
    expect(process.env.CAPY_USE_API_KEY).toBeUndefined();

    saveSettings({ claudeAuth: "apiKey", apiKey: "sk-settings-0001" });
    expect(process.env.CAPY_USE_API_KEY).toBe("1");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-settings-0001");

    saveSettings({ claudeAuth: "subscription" });
    expect(process.env.CAPY_USE_API_KEY).toBeUndefined();
    // the key we put there is gone again
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    // apiKey mode without any key falls back to subscription behaviour
    saveSettings({ claudeAuth: "apiKey", apiKey: "" });
    expect(process.env.CAPY_USE_API_KEY).toBeUndefined();
  });
});

describe("audience", () => {
  it("defaults to en-us and saves original", () => {
    expect(effective().audience).toBe("en-us");
    saveSettings({ audience: "original" });
    expect(effective().audience).toBe("original");
  });
});
