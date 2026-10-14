import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function appPaths(environment: Environment) {
  const root = appDir(environment);
  return {
    root,
    binDir: join(root, "bin"),
    binary: join(root, "bin", BINARY_NAME),
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
