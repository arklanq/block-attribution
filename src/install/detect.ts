import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { claudeConfigDir, codexHome, type Environment } from "../paths.ts";

export type AgentName = "claude" | "codex";

export type AgentDetection = {
  agent: AgentName;
  /** Human-readable variants that were found, e.g. "CLI 2.1.296", "Desktop app". */
  variants: string[];
  configDir: string;
  configDirExists: boolean;
  found: boolean;
};

export type Probe = {
  which: (command: string) => string | null;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  version: (binary: string) => string | undefined;
  platform: NodeJS.Platform;
};

export const systemProbe: Probe = {
  which: (command) => Bun.which(command),
  exists: existsSync,
  readText: (path) => {
    try {
      return readFileSync(path, "latin1");
    } catch {
      return undefined;
    }
  },
  version: (binary) => {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return result.status === 0 ? result.stdout.trim().match(/\d+\.\d+\.\d+\S*/)?.[0] : undefined;
  },
  platform: process.platform,
};

function applicationDirs(environment: Environment): string[] {
  return ["/Applications", join(environment.homeDir, "Applications")];
}

function findApp(environment: Environment, probe: Probe, names: string[], bundleId: string): boolean {
  if (probe.platform !== "darwin") {
    return false;
  }
  return applicationDirs(environment).some((dir) =>
    names.some((name) => {
      const plist = probe.readText(join(dir, name, "Contents", "Info.plist"));
      return plist !== undefined && plist.includes(bundleId);
    }),
  );
}

function cliVariant(probe: Probe, command: string): string | undefined {
  const path = probe.which(command);
  if (!path) {
    return undefined;
  }
  const version = probe.version(path);
  return version ? `CLI ${version}` : "CLI";
}

export function detectAgents(environment: Environment, probe: Probe = systemProbe): AgentDetection[] {
  const claudeDir = claudeConfigDir(environment);
  const claudeVariants = [
    cliVariant(probe, "claude"),
    findApp(environment, probe, ["Claude.app"], "com.anthropic.claudefordesktop") ? "Desktop app" : undefined,
  ].filter((variant): variant is string => variant !== undefined);

  const codexDir = codexHome(environment);
  const codexVariants = [
    cliVariant(probe, "codex"),
    // The Codex desktop app ships as ChatGPT.app with the com.openai.codex bundle id.
    findApp(environment, probe, ["ChatGPT.app", "Codex.app"], "com.openai.codex") ? "Desktop app" : undefined,
  ].filter((variant): variant is string => variant !== undefined);

  return [
    {
      agent: "claude",
      variants: claudeVariants,
      configDir: claudeDir,
      configDirExists: probe.exists(claudeDir),
      found: claudeVariants.length > 0 || probe.exists(claudeDir),
    },
    {
      agent: "codex",
      variants: codexVariants,
      configDir: codexDir,
      configDirExists: probe.exists(codexDir),
      found: codexVariants.length > 0 || probe.exists(codexDir),
    },
  ];
}

export function describeDetection(detection: AgentDetection): string {
  const name = detection.agent === "claude" ? "Claude Code" : "Codex";
  if (!detection.found) {
    return `${name}: not found`;
  }
  const variants = detection.variants.length > 0 ? detection.variants.join(", ") : "configuration only";
  return `${name}: ${variants} (${detection.configDir})`;
}
