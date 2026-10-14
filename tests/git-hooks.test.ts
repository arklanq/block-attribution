import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderGitHook, runCommitMsgHook } from "../src/git-hooks.ts";
import { runStop } from "../src/hook.ts";

const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

describe("runCommitMsgHook", () => {
  const dir = mkdtempSync(join(tmpdir(), "block-attribution-msg-"));

  test("rejects attribution and ignores the verbose diff", () => {
    writeFileSync(join(dir, "bad"), `feat: x\n\n${TRAILER}\n`);
    writeFileSync(join(dir, "verbose"), `feat: x\n# ------------------------ >8 ------------------------\n+${TRAILER}\n`);
    expect(runCommitMsgHook(join(dir, "bad"), []).exitCode).toBe(1);
    expect(runCommitMsgHook(join(dir, "verbose"), []).exitCode).toBe(0);
  });
});

describe("git hooks in a repository", () => {
  test("block attributed commits and still run the repository's own hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "block-attribution-git-"));
    const hooksDir = join(root, "hooks");
    const repo = join(root, "repo");
    mkdirSync(hooksDir);
    mkdirSync(repo);
    // A stand-in for the installed executable that delegates to the TypeScript entry point.
    const binary = join(root, "block-attribution");
    writeFileSync(binary, `#!/bin/sh\nexec bun ${JSON.stringify(join(import.meta.dir, "..", "src", "cli.ts"))} "$@"\n`);
    chmodSync(binary, 0o755);
    for (const name of ["commit-msg", "pre-commit"]) {
      writeFileSync(join(hooksDir, name), renderGitHook(name, binary));
      chmodSync(join(hooksDir, name), 0o755);
    }
    writeFileSync(join(root, "gitconfig"), `[core]\n\thooksPath = ${hooksDir}\n[user]\n\tname = T\n\temail = t@example.com\n`);
    const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), XDG_CONFIG_HOME: join(root, "xdg") };
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });

    git("init", "-q");
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${JSON.stringify(join(root, "repo-hook-ran"))}\n`);
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    writeFileSync(join(root, "message"), `feat: x\n\n${TRAILER}\n`);

    expect(git("commit", "-q", "--allow-empty", "-F", join(root, "message")).status).not.toBe(0);
    expect(git("commit", "-q", "--allow-empty", "-m", "feat: x").status).toBe(0);
    expect(spawnSync("test", ["-e", join(root, "repo-hook-ran")]).status).toBe(0);

    // The Stop hook reports unpushed commits that slipped through, e.g. with --no-verify.
    expect(git("commit", "-q", "--no-verify", "--allow-empty", "-F", join(root, "message")).status).toBe(0);
    const stop = runStop({ cwd: repo, stop_hook_active: false }, []);
    expect(JSON.parse(stop.stdout ?? "{}").decision).toBe("block");
    expect(runStop({ cwd: repo, stop_hook_active: true }, []).stdout).toBeUndefined();
  });
});
