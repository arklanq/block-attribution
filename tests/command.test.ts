import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeMcpToolCall, analyzeShellCommand, splitShellCommand } from "../src/command.ts";

const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

describe("splitShellCommand", () => {
  test("keeps quoted text in one word and splits on operators", () => {
    expect(splitShellCommand(`cd repo && git commit -m 'a b' -m "c \\"d\\""; echo x`)).toEqual([
      ["cd", "repo"],
      ["git", "commit", "-m", "a b", "-m", 'c "d"'],
      ["echo", "x"],
    ]);
  });

  test("does not treat heredoc bodies as commands", () => {
    expect(splitShellCommand("cat > notes.txt <<'EOF'\ngit commit -m x\nEOF\necho done")).toEqual([
      ["cat", ">", "notes.txt"],
      ["echo", "done"],
    ]);
  });
});

describe("analyzeShellCommand", () => {
  const cwd = mkdtempSync(join(tmpdir(), "block-attribution-command-"));
  const blocked = (command: string) => analyzeShellCommand(command, cwd).problems.length > 0;

  test("blocks an attribution trailer in -m", () => {
    expect(blocked(`git commit -m "feat: x" -m "${TRAILER}"`)).toBe(true);
  });

  test("blocks a trailer inside a heredoc message", () => {
    expect(blocked(`git commit -m "$(cat <<'EOF'\nfeat: x\n\n${TRAILER}\nEOF\n)"`)).toBe(true);
    expect(blocked(`git commit -F - <<'EOF'\nfeat: x\n\n${TRAILER}\nEOF`)).toBe(true);
  });

  test("reads -F files relative to a preceding cd", () => {
    const repo = mkdtempSync(join(cwd, "repo-"));
    writeFileSync(join(cwd, "message.txt"), `feat: x\n\n${TRAILER}\n`);
    expect(blocked(`cd ${repo} && git commit -F ../message.txt`)).toBe(true);
    expect(blocked("git commit --file=message.txt")).toBe(true);
    expect(blocked("git commit -aF message.txt")).toBe(true);
  });

  test("blocks hook bypasses", () => {
    expect(blocked('git commit --no-verify -m "feat: x"')).toBe(true);
    expect(blocked('git commit -nm "feat: x"')).toBe(true);
    expect(blocked("git push --no-verify")).toBe(true);
    expect(blocked('git -c core.hooksPath=/dev/null commit -m "feat: x"')).toBe(true);
  });

  test("allows clean commits and pushes", () => {
    expect(blocked('git commit -am "feat: x"')).toBe(false);
    expect(blocked('git commit -m "fix: handle the -n flag"')).toBe(false);
    expect(blocked("git push -n origin main")).toBe(false);
  });

  test("checks pull request bodies and body files", () => {
    writeFileSync(join(cwd, "body.md"), "Summary\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n");
    expect(blocked("gh pr create --title x --body-file body.md")).toBe(true);
    expect(blocked('gh pr edit 1 --body "Generated with [Codex](https://openai.com/codex/)."')).toBe(true);
    expect(blocked('gh pr create --title x --body "Summary"')).toBe(false);
  });

  test("ignores commands that do not commit or open pull requests", () => {
    expect(analyzeShellCommand(`grep -r "${TRAILER}" .`, cwd)).toEqual({ relevant: false, problems: [] });
    expect(analyzeShellCommand(`cat > notes.md <<'EOF'\ngit commit -m "${TRAILER}"\nEOF`, cwd).relevant).toBe(false);
  });
});

describe("analyzeMcpToolCall", () => {
  test("checks GitHub pull request tools", () => {
    const result = analyzeMcpToolCall("mcp__github__create_pull_request", {
      title: "feat: x",
      body: "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    });
    expect(result.problems).toHaveLength(1);
  });

  test("ignores read-only tools", () => {
    expect(analyzeMcpToolCall("mcp__github__get_pull_request", { body: TRAILER }).relevant).toBe(false);
  });
});
