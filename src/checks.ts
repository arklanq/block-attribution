import { spawnSync } from "node:child_process";

import { describeFindings, findAttribution } from "./rules.ts";

const FIELD = "\x1f";
const RECORD = "\x1e";
const ZERO_SHA = /^0+$/;

export type CommandResult = { ok: boolean; stdout: string };

export type Runner = (command: string, args: string[], cwd: string, timeoutMs?: number) => CommandResult;

export const run: Runner = (command, args, cwd, timeoutMs = 15_000) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
};

export type CommitProblem = { sha: string; subject: string; details: string };

function commitProblems(logOutput: string, patterns: readonly RegExp[]): CommitProblem[] {
  return logOutput
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.includes(FIELD))
    .flatMap((record) => {
      const [sha = "", message = ""] = record.split(FIELD);
      const findings = findAttribution(message, patterns);
      return findings.length === 0
        ? []
        : [{ sha: sha.slice(0, 12), subject: message.split("\n")[0] ?? "", details: describeFindings(findings) }];
    });
}

function gitLog(cwd: string, revisionArgs: string[], runner: Runner): string | undefined {
  const result = runner("git", ["log", `--format=%H${FIELD}%B${RECORD}`, ...revisionArgs], cwd);
  return result.ok ? result.stdout : undefined;
}

/** Recent commits on HEAD that no remote-tracking branch contains yet. */
export function checkUnpublishedCommits(
  cwd: string,
  patterns: readonly RegExp[] = [],
  runner: Runner = run,
): CommitProblem[] {
  if (!runner("git", ["rev-parse", "--verify", "--quiet", "HEAD"], cwd).ok) {
    return [];
  }
  const output = gitLog(cwd, ["HEAD", "--not", "--remotes", "--since=12.hours", "-n", "50"], runner);
  return output === undefined ? [] : commitProblems(output, patterns);
}

/** Commits a push would send, from the pre-push hook's standard input. */
export function checkPushedCommits(
  cwd: string,
  remoteName: string,
  pushInput: string,
  patterns: readonly RegExp[] = [],
  runner: Runner = run,
): CommitProblem[] {
  const problems: CommitProblem[] = [];
  for (const line of pushInput.split("\n")) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || !remoteSha || ZERO_SHA.test(localSha)) {
      continue;
    }
    const range = ZERO_SHA.test(remoteSha)
      ? [localSha, "--not", `--remotes=${remoteName}`]
      : [`${remoteSha}..${localSha}`];
    const output = gitLog(cwd, range, runner);
    if (output !== undefined) {
      problems.push(...commitProblems(output, patterns));
    }
  }
  return problems;
}

export type PullRequestProblem = { url: string; details: string };

/** The open pull request of the current branch, through the GitHub CLI when it is available. */
export function checkCurrentPullRequest(
  cwd: string,
  patterns: readonly RegExp[] = [],
  runner: Runner = run,
): PullRequestProblem | undefined {
  const result = runner("gh", ["pr", "view", "--json", "title,body,url,state"], cwd);
  if (!result.ok) {
    return undefined;
  }
  try {
    const pr = JSON.parse(result.stdout) as { title?: string; body?: string; url?: string; state?: string };
    if (pr.state !== "OPEN") {
      return undefined;
    }
    const findings = findAttribution(`${pr.title ?? ""}\n${pr.body ?? ""}`, patterns);
    return findings.length === 0 ? undefined : { url: pr.url ?? "", details: describeFindings(findings) };
  } catch {
    return undefined;
  }
}

export function formatCommitProblems(problems: readonly CommitProblem[]): string {
  return problems.map((problem) => `Commit ${problem.sha} "${problem.subject}":\n${problem.details}`).join("\n");
}
