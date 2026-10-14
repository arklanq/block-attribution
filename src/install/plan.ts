import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { GIT_HOOK_NAMES, renderGitHook } from "../git-hooks.ts";
import { appPaths, claudeConfigDir, codexHome, type Environment } from "../paths.ts";
import {
  codexTrustedHash,
  codexTrustKey,
  enableHooksFeature,
  readTrustedHash,
  removeTrustedHash,
  renameTrustKey,
  setTrustedHash,
  type CodexEventLabel,
} from "./codex-trust.ts";
import type { AgentName } from "./detect.ts";
import { hasManagedGroup, removeManagedGroups, upsertManagedGroup, type HookGroup } from "./hook-entries.ts";
import { jsonEqual, parseJsonObject, setJsonValue } from "./json.ts";
import type { Operation } from "./operations.ts";

export type InstallChoices = {
  agents: AgentName[];
  gitHooks: boolean;
  removeGitInstructions: boolean;
};

type Previous = { present: false } | { present: true; value: unknown };

export type Manifest = {
  version: 1;
  claude?: {
    settingsPath: string;
    previous: { attribution: Previous; includeGitInstructions?: Previous };
    written: { attribution: unknown; includeGitInstructions?: unknown };
  };
  codex?: {
    hooksPath: string;
    hooksFileExisted: boolean;
    configPath: string;
    trustKeys: string[];
    hooksFeatureWasDisabled: boolean;
  };
  git?: { hooksPath: string };
};

export type Plan = {
  operations: Operation[];
  warnings: string[];
  notes: string[];
};

export type PlanContext = {
  environment: Environment;
  /** Executable copied to the installation directory; hooks call the installed copy. */
  binarySource?: string;
  now?: Date;
};

// Claude Code versions before 2.1.281 reject `attribution: false`, so the three sub-keys are used.
export const CLAUDE_ATTRIBUTION = { commit: "", pr: "", sessionUrl: false };

const HOOK_TIMEOUT = { preToolUse: 30, stop: 60 };
const TOOL_MATCHER = "^(Bash|mcp__.*)$";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hookGroups(binary: string): { preToolUse: HookGroup; stop: HookGroup } {
  return {
    preToolUse: {
      matcher: TOOL_MATCHER,
      hooks: [{ type: "command", command: `${shellQuote(binary)} hook pre-tool-use`, timeout: HOOK_TIMEOUT.preToolUse }],
    },
    stop: {
      hooks: [{ type: "command", command: `${shellQuote(binary)} hook stop`, timeout: HOOK_TIMEOUT.stop }],
    },
  };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function readManifest(environment: Environment): Manifest | undefined {
  const text = readText(appPaths(environment).manifest);
  if (text === undefined) {
    return undefined;
  }
  const value = JSON.parse(text) as Manifest;
  return value.version === 1 ? value : undefined;
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function writeWithBackup(
  operations: Operation[],
  environment: Environment,
  now: Date,
  path: string,
  before: string | undefined,
  after: string,
  label: string,
  description: string,
): void {
  if (before === after) {
    return;
  }
  if (before !== undefined) {
    operations.push({
      kind: "write",
      path: join(appPaths(environment).backupsDir, `${label}.${timestamp(now)}`),
      content: before,
      mode: 0o600,
      showDiff: false,
      description: `Back up ${path}`,
    });
  }
  operations.push({ kind: "write", path, content: after, ...(before !== undefined ? { previous: before } : {}), description });
}

function previousOf(object: Record<string, unknown>, key: string): Previous {
  return key in object ? { present: true, value: object[key] } : { present: false };
}

function restoreValue(text: string, key: string, previous: Previous): string {
  return setJsonValue(text, [key], previous.present ? previous.value : undefined);
}

function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function gitEnv(environment: Environment): Record<string, string | undefined> {
  return { ...environment.env, HOME: environment.homeDir };
}

export function globalHooksPath(environment: Environment): string | undefined {
  const result = spawnSync("git", ["config", "--global", "--get", "core.hooksPath"], {
    encoding: "utf8",
    env: gitEnv(environment) as NodeJS.ProcessEnv,
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value === "" ? undefined : value.replace(/^~(?=\/|$)/, environment.homeDir);
}

// ---------------------------------------------------------------------------------------------
// Claude Code

function planClaudeInstall(
  operations: Operation[],
  context: Required<Pick<PlanContext, "environment" | "now">>,
  choices: InstallChoices,
  binary: string,
  manifest: Manifest | undefined,
): Manifest["claude"] {
  const { environment, now } = context;
  const path = join(claudeConfigDir(environment), "settings.json");
  const before = readText(path);
  const current = parseJsonObject(before ?? "", path);
  const groups = hookGroups(binary);
  let text = before ?? "{}\n";

  const previous = manifest?.claude?.previous ?? {
    attribution: previousOf(current, "attribution"),
  };
  const attributionDisabled = current.attribution === false || jsonEqual(current.attribution, CLAUDE_ATTRIBUTION);
  const writtenAttribution = attributionDisabled ? current.attribution : CLAUDE_ATTRIBUTION;
  if (!attributionDisabled) {
    text = setJsonValue(text, ["attribution"], CLAUDE_ATTRIBUTION);
  }

  const written: NonNullable<Manifest["claude"]>["written"] = { attribution: writtenAttribution };
  if (choices.removeGitInstructions) {
    previous.includeGitInstructions ??= previousOf(current, "includeGitInstructions");
    if (current.includeGitInstructions !== false) {
      text = setJsonValue(text, ["includeGitInstructions"], false);
    }
    written.includeGitInstructions = false;
  } else if (previous.includeGitInstructions && manifest?.claude?.written.includeGitInstructions === false) {
    if (current.includeGitInstructions === false) {
      text = restoreValue(text, "includeGitInstructions", previous.includeGitInstructions);
    }
    delete previous.includeGitInstructions;
  }

  text = upsertManagedGroup(text, path, "PreToolUse", groups.preToolUse).text;
  text = upsertManagedGroup(text, path, "Stop", groups.stop).text;

  writeWithBackup(operations, environment, now, path, before, text, "claude-settings.json", "Configure Claude Code (attribution off, hooks)");
  return { settingsPath: path, previous, written };
}

function planClaudeUninstall(operations: Operation[], environment: Environment, now: Date, manifest: Manifest | undefined, notes: string[]): void {
  const path = manifest?.claude?.settingsPath ?? join(claudeConfigDir(environment), "settings.json");
  const before = readText(path);
  if (before === undefined) {
    return;
  }
  const current = parseJsonObject(before, path);
  let text = removeManagedGroups(before, path, "PreToolUse").text;
  text = removeManagedGroups(text, path, "Stop").text;

  const claude = manifest?.claude;
  if (claude) {
    if (jsonEqual(current.attribution, claude.written.attribution)) {
      text = restoreValue(text, "attribution", claude.previous.attribution);
    }
    if (claude.previous.includeGitInstructions && jsonEqual(current.includeGitInstructions, claude.written.includeGitInstructions)) {
      text = restoreValue(text, "includeGitInstructions", claude.previous.includeGitInstructions);
    }
  } else {
    notes.push("No install record was found, so Claude Code's attribution setting was left as it is.");
  }
  writeWithBackup(operations, environment, now, path, before, text, "claude-settings.json", "Remove Block Attribution from Claude Code");
}

// ---------------------------------------------------------------------------------------------
// Codex

const CODEX_EVENTS: { event: "PreToolUse" | "Stop"; label: CodexEventLabel; key: "preToolUse" | "stop" }[] = [
  { event: "PreToolUse", label: "pre_tool_use", key: "preToolUse" },
  { event: "Stop", label: "stop", key: "stop" },
];

function planCodexInstall(
  operations: Operation[],
  context: Required<Pick<PlanContext, "environment" | "now">>,
  binary: string,
  manifest: Manifest | undefined,
  notes: string[],
): Manifest["codex"] {
  const { environment, now } = context;
  const home = codexHome(environment);
  const hooksPath = join(home, "hooks.json");
  const configPath = join(home, "config.toml");
  const trustPath = join(canonicalDir(home), "hooks.json");
  const hooksBefore = readText(hooksPath);
  const configBefore = readText(configPath);
  const groups = hookGroups(binary);

  let hooksText = hooksBefore ?? "{}\n";
  let configText = configBefore ?? "";
  const trustKeys: string[] = [];

  for (const { event, label, key } of CODEX_EVENTS) {
    const group = groups[key];
    const result = upsertManagedGroup(hooksText, hooksPath, event, group);
    hooksText = result.text;
    const trustKey = codexTrustKey(trustPath, label, result.groupIndex, result.handlerIndex);
    configText = setTrustedHash(configText, configPath, trustKey, codexTrustedHash(label, group.matcher, group.hooks[0]!));
    trustKeys.push(trustKey);
  }
  for (const staleKey of manifest?.codex?.trustKeys ?? []) {
    if (!trustKeys.includes(staleKey)) {
      configText = removeTrustedHash(configText, configPath, staleKey);
    }
  }

  const featureText = enableHooksFeature(configText, configPath);
  const hooksFeatureWasDisabled = (manifest?.codex?.hooksFeatureWasDisabled ?? false) || featureText !== configText;
  configText = featureText;
  if (hooksFeatureWasDisabled) {
    notes.push("Codex hooks were turned off in config.toml; Block Attribution turned them on.");
  }

  writeWithBackup(operations, environment, now, hooksPath, hooksBefore, hooksText, "codex-hooks.json", "Add Block Attribution hooks to Codex");
  writeWithBackup(operations, environment, now, configPath, configBefore, configText, "codex-config.toml", "Trust the Block Attribution hooks in Codex");
  return {
    hooksPath,
    hooksFileExisted: manifest?.codex?.hooksFileExisted ?? hooksBefore !== undefined,
    configPath,
    trustKeys,
    hooksFeatureWasDisabled,
  };
}

function planCodexUninstall(operations: Operation[], environment: Environment, now: Date, manifest: Manifest | undefined): void {
  const home = codexHome(environment);
  const hooksPath = manifest?.codex?.hooksPath ?? join(home, "hooks.json");
  const configPath = manifest?.codex?.configPath ?? join(home, "config.toml");
  const trustPath = join(canonicalDir(home), "hooks.json");
  const hooksBefore = readText(hooksPath);
  const configBefore = readText(configPath);
  if (hooksBefore === undefined) {
    return;
  }

  let hooksText = hooksBefore;
  let configText = configBefore ?? "";
  for (const { event, label } of CODEX_EVENTS) {
    if (!hasManagedGroup(hooksText, hooksPath, event)) {
      continue;
    }
    const removed = removeManagedGroups(hooksText, hooksPath, event);
    hooksText = removed.text;
    for (const groupIndex of removed.removedGroups) {
      configText = removeTrustedHash(configText, configPath, codexTrustKey(trustPath, label, groupIndex, 0));
    }
    // Later groups move up; keep the user's existing trust by moving their keys with them.
    for (const [from, to] of [...removed.moved.entries()].sort(([a], [b]) => a - b)) {
      if (from === to) {
        continue;
      }
      for (let handler = 0; handler < 16; handler += 1) {
        const fromKey = codexTrustKey(trustPath, label, from, handler);
        if (readTrustedHash(configText, configPath, fromKey) !== undefined) {
          configText = renameTrustKey(configText, configPath, fromKey, codexTrustKey(trustPath, label, to, handler));
        }
      }
    }
  }
  for (const key of manifest?.codex?.trustKeys ?? []) {
    configText = removeTrustedHash(configText, configPath, key);
  }

  const hooksEmpty = Object.keys(parseJsonObject(hooksText, hooksPath)).length === 0;
  if (hooksEmpty && manifest?.codex?.hooksFileExisted === false) {
    operations.push({ kind: "delete", path: hooksPath, description: "Remove the Codex hooks file Block Attribution created" });
  } else {
    writeWithBackup(operations, environment, now, hooksPath, hooksBefore, hooksText, "codex-hooks.json", "Remove Block Attribution hooks from Codex");
  }
  if (configBefore !== undefined) {
    writeWithBackup(operations, environment, now, configPath, configBefore, configText, "codex-config.toml", "Remove Block Attribution hook trust from Codex");
  }
}

// ---------------------------------------------------------------------------------------------
// Git

function planGitInstall(operations: Operation[], environment: Environment, binary: string, warnings: string[]): Manifest["git"] {
  const paths = appPaths(environment);
  const current = globalHooksPath(environment);
  if (current !== undefined && canonicalDir(current) !== canonicalDir(paths.gitHooksDir)) {
    warnings.push(
      `Global git hooks skipped: core.hooksPath is already set to ${current}. Block Attribution does not replace another hooks directory.`,
    );
    return undefined;
  }

  for (const name of GIT_HOOK_NAMES) {
    const path = join(paths.gitHooksDir, name);
    const content = renderGitHook(name, binary);
    const before = readText(path);
    if (before !== content) {
      operations.push({
        kind: "write",
        path,
        content,
        mode: 0o755,
        ...(before !== undefined ? { previous: before } : {}),
        ...(name === "commit-msg" || name === "pre-push" ? {} : { showDiff: false }),
        description: `Install git hook ${name}`,
      });
    }
  }
  if (current === undefined) {
    operations.push({
      kind: "run",
      command: ["git", "config", "--global", "core.hooksPath", paths.gitHooksDir],
      env: gitEnv(environment),
      description: "Point git at the Block Attribution hooks",
    });
  }
  return { hooksPath: paths.gitHooksDir };
}

function planGitUninstall(operations: Operation[], environment: Environment): void {
  const paths = appPaths(environment);
  const current = globalHooksPath(environment);
  if (current !== undefined && canonicalDir(current) === canonicalDir(paths.gitHooksDir)) {
    operations.push({
      kind: "run",
      command: ["git", "config", "--global", "--unset", "core.hooksPath"],
      env: gitEnv(environment),
      description: "Stop pointing git at the Block Attribution hooks",
    });
  }
  if (existsSync(paths.gitHooksDir)) {
    operations.push({ kind: "delete", path: paths.gitHooksDir, recursive: true, description: "Remove the git hooks" });
  }
}

// ---------------------------------------------------------------------------------------------

export function planInstall(context: PlanContext, choices: InstallChoices): Plan {
  const environment = context.environment;
  const now = context.now ?? new Date();
  const paths = appPaths(environment);
  const manifest = readManifest(environment);
  const operations: Operation[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const full = { environment, now };

  const binaryContent = context.binarySource ? readFileSync(context.binarySource) : undefined;
  const installedBinary = existsSync(paths.binary) ? readFileSync(paths.binary) : undefined;
  if (binaryContent && !(installedBinary && binaryContent.equals(installedBinary))) {
    operations.push({
      kind: "write",
      path: paths.binary,
      content: binaryContent,
      mode: 0o755,
      description: "Install the block-attribution executable",
    });
  } else if (!binaryContent && !installedBinary) {
    throw new Error("The block-attribution executable is missing. Run the installer from a release build.");
  }

  const next: Manifest = { version: 1 };
  if (choices.agents.includes("claude")) {
    next.claude = planClaudeInstall(operations, full, choices, paths.binary, manifest);
  } else if (manifest?.claude) {
    planClaudeUninstall(operations, environment, now, manifest, notes);
  }
  if (choices.agents.includes("codex")) {
    next.codex = planCodexInstall(operations, full, paths.binary, manifest, notes);
  } else if (manifest?.codex) {
    planCodexUninstall(operations, environment, now, manifest);
  }
  if (choices.gitHooks) {
    const git = planGitInstall(operations, environment, paths.binary, warnings);
    if (git) {
      next.git = git;
    }
  } else if (manifest?.git) {
    planGitUninstall(operations, environment);
  }

  const config = (() => {
    const text = readText(paths.config);
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  const configText = `${JSON.stringify({ ...config, answers: choices }, null, 2)}\n`;
  if (readText(paths.config) !== configText) {
    operations.push({ kind: "write", path: paths.config, content: configText, description: "Save installer answers" });
  }
  const manifestText = `${JSON.stringify(next, null, 2)}\n`;
  if (readText(paths.manifest) !== manifestText) {
    operations.push({ kind: "write", path: paths.manifest, content: manifestText, description: "Record what was changed" });
  }

  return { operations, warnings, notes };
}

export function planUninstall(context: PlanContext): Plan {
  const environment = context.environment;
  const now = context.now ?? new Date();
  const paths = appPaths(environment);
  const manifest = readManifest(environment);
  const operations: Operation[] = [];
  const notes: string[] = [];

  planClaudeUninstall(operations, environment, now, manifest, notes);
  planCodexUninstall(operations, environment, now, manifest);
  planGitUninstall(operations, environment);

  for (const [path, description, recursive] of [
    [paths.binDir, "Remove the executable", true],
    [paths.config, "Remove saved answers", false],
    [paths.manifest, "Remove the install record", false],
  ] as const) {
    if (existsSync(path)) {
      operations.push({ kind: "delete", path, recursive, description });
    }
  }
  if (existsSync(paths.backupsDir)) {
    notes.push(`Backups of your agent settings are kept in ${paths.backupsDir}.`);
  }
  return { operations, warnings: [], notes };
}
