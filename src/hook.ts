import { analyzeMcpToolCall, analyzeShellCommand } from "./command.ts";
import {
  checkCurrentPullRequest,
  checkUnpublishedCommits,
  formatCommitProblems,
  type Runner,
  run,
} from "./checks.ts";

export type HookEvent = "pre-tool-use" | "stop";

export type HookResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

type HookInput = {
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
};

const FIX_HINT =
  "The user does not want AI attribution in commits or pull requests. Fix the problems listed above and retry. Do not try to bypass this check.";

export function runPreToolUse(input: HookInput, patterns: readonly RegExp[]): HookResult {
  const toolName = input.tool_name ?? "";
  const cwd = input.cwd || process.cwd();
  const toolInput = input.tool_input as { command?: unknown } | undefined;

  const analysis =
    toolName === "Bash" && typeof toolInput?.command === "string"
      ? analyzeShellCommand(toolInput.command, cwd, patterns)
      : analyzeMcpToolCall(toolName, input.tool_input, patterns);

  if (analysis.problems.length === 0) {
    return { exitCode: 0 };
  }
  // Exit code 2 with the reason on stderr blocks the tool call in both Claude Code and Codex.
  return {
    exitCode: 2,
    stderr: `Block Attribution stopped this command.\n${analysis.problems.join("\n")}\n${FIX_HINT}\n`,
  };
}

export function runStop(input: HookInput, patterns: readonly RegExp[], runner: Runner = run): HookResult {
  if (input.stop_hook_active || !input.cwd) {
    return { exitCode: 0 };
  }

  const problems: string[] = [];
  const commits = checkUnpublishedCommits(input.cwd, patterns, runner);
  if (commits.length > 0) {
    problems.push(
      `Unpushed commits contain AI attribution. Reword them (for example with git commit --amend or an interactive rebase):\n${formatCommitProblems(commits)}`,
    );
  }
  const pullRequest = checkCurrentPullRequest(input.cwd, patterns, runner);
  if (pullRequest) {
    problems.push(
      `The pull request ${pullRequest.url} contains AI attribution. Edit its title or body with gh pr edit:\n${pullRequest.details}`,
    );
  }

  if (problems.length === 0) {
    return { exitCode: 0 };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      decision: "block",
      reason: `Block Attribution: ${problems.join("\n")}\n${FIX_HINT}`,
    })}\n`,
  };
}

export function runHook(event: HookEvent, rawInput: string, patterns: readonly RegExp[]): HookResult {
  let input: HookInput;
  try {
    input = JSON.parse(rawInput) as HookInput;
  } catch {
    // A hook that cannot read its input must not break the agent.
    return { exitCode: 0, stderr: "Block Attribution: could not parse hook input.\n" };
  }
  return event === "pre-tool-use" ? runPreToolUse(input, patterns) : runStop(input, patterns);
}
