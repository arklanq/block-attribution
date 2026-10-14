import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const APP_NAME = "block-attribution";
export const BINARY_NAME = "block-attribution";

export type Environment = {
  homeDir: string;
  env: Record<string, string | undefined>;
};

export function defaultEnvironment(): Environment {
  return { homeDir: homedir(), env: process.env };
}

export function appDir({ homeDir, env }: Environment): string {
  return join(env.XDG_CONFIG_HOME || join(homeDir, ".config"), APP_NAME);
}

/** The executable goes where user tools usually live, so it can be run by name once that directory is in PATH. */
export function binDir({ homeDir, env }: Environment): string {
  return env.BLOCK_ATTRIBUTION_BIN_DIR || join(homeDir, ".local", "bin");
}

export function isInPath(directory: string, { homeDir, env }: Environment): boolean {
  const target = resolve(directory);
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry.replace(/^~(?=\/|$)/, homeDir)) === target);
}

export function appPaths(environment: Environment) {
  const root = appDir(environment);
  return {
    root,
    binDir: binDir(environment),
    binary: join(binDir(environment), BINARY_NAME),
    gitHooksDir: join(root, "git-hooks"),
    config: join(root, "config.json"),
    manifest: join(root, "manifest.json"),
    backupsDir: join(root, "backups"),
  };
}

export function claudeConfigDir({ homeDir, env }: Environment): string {
  return env.CLAUDE_CONFIG_DIR || join(homeDir, ".claude");
}

export function codexHome({ homeDir, env }: Environment): string {
  return env.CODEX_HOME || join(homeDir, ".codex");
}

export type UserConfig = {
  /** Extra regular expressions (case-insensitive) treated as attribution. */
  extraPatterns?: string[];
};

export function readUserConfig(environment: Environment): UserConfig {
  try {
    return JSON.parse(readFileSync(appPaths(environment).config, "utf8")) as UserConfig;
  } catch {
    return {};
  }
}

export function extraPatterns(config: UserConfig): RegExp[] {
  return (config.extraPatterns ?? []).flatMap((source) => {
    try {
      return [new RegExp(source, "i")];
    } catch {
      return [];
    }
  });
}
