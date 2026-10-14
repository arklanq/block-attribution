import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeOperations } from "../src/install/operations.ts";
import { planInstall, planUninstall, type InstallChoices } from "../src/install/plan.ts";
import type { Environment } from "../src/paths.ts";

const CLAUDE_SETTINGS = `{
  "permissions": { "defaultMode": "acceptEdits" },
  "attribution": { "commit": "Co-Authored-By: Someone <a@b.c>" }
}
`;
const CODEX_HOOKS = `{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/other", "timeout": 100 }] }
    ]
  }
}
`;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "block-attribution-home-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".claude", "settings.json"), CLAUDE_SETTINGS);
  writeFileSync(join(home, ".codex", "hooks.json"), CODEX_HOOKS);
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  writeFileSync(join(home, "gitconfig"), "");
  const binary = join(home, "fake-binary");
  writeFileSync(binary, "#!/bin/sh\n");
  const environment: Environment = {
    homeDir: home,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GIT_CONFIG_GLOBAL: join(home, "gitconfig") },
  };
  return { home, binary, environment };
}

const ALL: InstallChoices = { agents: ["claude", "codex"], gitHooks: true, removeGitInstructions: true };

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("install and uninstall", () => {
  test("installs everything, is idempotent, and uninstall restores the original files", async () => {
    const { home, binary, environment } = setup();

    await executeOperations(planInstall({ environment, binarySource: binary }, ALL).operations);

    const settings = JSON.parse(read(join(home, ".claude", "settings.json")));
    expect(settings.attribution).toEqual({ commit: "", pr: "", sessionUrl: false });
    expect(settings.includeGitInstructions).toBe(false);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("block-attribution' hook pre-tool-use");
    expect(settings.permissions).toEqual({ defaultMode: "acceptEdits" });

    const hooks = JSON.parse(read(join(home, ".codex", "hooks.json")));
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("/usr/local/bin/other");
    const config = read(join(home, ".codex", "config.toml"));
    expect(config).toContain(":pre_tool_use:0:0\"]");
    expect(config).toContain(":stop:1:0\"]");

    const hooksPath = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], { env: environment.env as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(hooksPath.stdout.trim()).toBe(join(home, ".config", "block-attribution", "git-hooks"));
    expect(existsSync(join(home, ".config", "block-attribution", "git-hooks", "commit-msg"))).toBe(true);

    expect(planInstall({ environment, binarySource: binary }, ALL).operations).toEqual([]);

    await executeOperations(planUninstall({ environment }).operations);
    expect(JSON.parse(read(join(home, ".claude", "settings.json")))).toEqual(JSON.parse(CLAUDE_SETTINGS));
    expect(read(join(home, ".codex", "hooks.json"))).toBe(CODEX_HOOKS);
    expect(read(join(home, ".codex", "config.toml"))).toBe("[features]\nhooks = true\n");
    expect(read(join(home, "gitconfig"))).not.toContain("hooksPath");
    expect(existsSync(join(home, ".config", "block-attribution", "bin"))).toBe(false);
  });

  test("planning writes nothing, which is what dry-run relies on", () => {
    const { home, binary, environment } = setup();
    const plan = planInstall({ environment, binarySource: binary }, ALL);
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(read(join(home, ".claude", "settings.json"))).toBe(CLAUDE_SETTINGS);
    expect(existsSync(join(home, ".config", "block-attribution"))).toBe(false);
  });

  test("does not replace another global hooks directory", () => {
    const { home, binary, environment } = setup();
    writeFileSync(join(home, "gitconfig"), "[core]\n\thooksPath = /somewhere/else\n");
    const plan = planInstall({ environment, binarySource: binary }, ALL);
    expect(plan.warnings.join("\n")).toContain("/somewhere/else");
    expect(plan.operations.some((operation) => operation.kind === "run")).toBe(false);
  });

  test("dropping an agent on reinstall removes its changes", async () => {
    const { home, binary, environment } = setup();
    await executeOperations(planInstall({ environment, binarySource: binary }, ALL).operations);
    await executeOperations(planInstall({ environment, binarySource: binary }, { ...ALL, agents: ["claude"] }).operations);
    expect(read(join(home, ".codex", "hooks.json"))).toBe(CODEX_HOOKS);
  });
});
