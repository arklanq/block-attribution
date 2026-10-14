import { readFileSync } from "node:fs";

import { checkPushedCommits, formatCommitProblems, type Runner, run } from "./checks.ts";
import { describeFindings, findAttribution } from "./rules.ts";

export const MANAGED_MARKER = "# Managed by Block Attribution.";

/** Client-side hooks git runs from core.hooksPath. Each one forwards to the repository's own hook. */
export const GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "post-index-change",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function repoHookLine(name: string): string {
  return `repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/${name}"`;
}

export function renderGitHook(name: string, binaryPath: string): string {
  const binary = shellQuote(binaryPath);
  const header = [
    "#!/bin/sh",
    MANAGED_MARKER,
    "# A global core.hooksPath replaces .git/hooks, so this script also runs the repository's own hook.",
  ];

  if (name === "pre-push") {
    return [
      ...header,
      'input="$(cat)"',
      `if [ -x ${binary} ]; then`,
      `  printf '%s\\n' "$input" | ${binary} git-hook pre-push "$@" || exit 1`,
      "fi",
      repoHookLine(name),
      'if [ -x "$repo_hook" ]; then',
      `  printf '%s\\n' "$input" | "$repo_hook" "$@"`,
      "  exit $?",
      "fi",
      "exit 0",
      "",
    ].join("\n");
  }

  return [
    ...header,
    ...(name === "commit-msg"
      ? [`if [ -x ${binary} ]; then`, `  ${binary} git-hook commit-msg "$1" || exit 1`, "fi"]
      : []),
    repoHookLine(name),
    'if [ -x "$repo_hook" ]; then',
    '  exec "$repo_hook" "$@"',
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

const BLOCK_HINT = "Remove the AI attribution and try again.";

export function runCommitMsgHook(messagePath: string, patterns: readonly RegExp[]): { exitCode: number; stderr?: string } {
  // `git commit --verbose` appends the diff below a scissors line; it is not part of the message.
  const message = readFileSync(messagePath, "utf8").split(/^. -{24} >8 -{24}$/m)[0] ?? "";
  const findings = findAttribution(message, patterns);
  if (findings.length === 0) {
    return { exitCode: 0 };
  }
  return {
    exitCode: 1,
    stderr: `Block Attribution: the commit message contains AI attribution:\n${describeFindings(findings)}\n${BLOCK_HINT}\n`,
  };
}

export function runPrePushHook(
  cwd: string,
  remoteName: string,
  pushInput: string,
  patterns: readonly RegExp[],
  runner: Runner = run,
): { exitCode: number; stderr?: string } {
  const problems = checkPushedCommits(cwd, remoteName, pushInput, patterns, runner);
  if (problems.length === 0) {
    return { exitCode: 0 };
  }
  return {
    exitCode: 1,
    stderr: `Block Attribution: the push contains commits with AI attribution:\n${formatCommitProblems(problems)}\nReword them, then push again.\n`,
  };
}
