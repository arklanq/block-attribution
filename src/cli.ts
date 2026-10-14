import { readFileSync } from "node:fs";

import { cancel, confirm, intro, isCancel, log, multiselect, note, outro, spinner } from "@clack/prompts";

import { checkCurrentPullRequest, checkUnpublishedCommits, formatCommitProblems } from "./checks.ts";
import { runCommitMsgHook, runPrePushHook } from "./git-hooks.ts";
import { runHook, type HookEvent } from "./hook.ts";
import { describeDetection, detectAgents, type AgentName } from "./install/detect.ts";
import { describeOperation, executeOperations } from "./install/operations.ts";
import { planInstall, planUninstall, readManifest, type InstallChoices, type Plan } from "./install/plan.ts";
import { appPaths, defaultEnvironment, extraPatterns, readUserConfig, type Environment } from "./paths.ts";

const USAGE = `Usage: block-attribution <command> [options]

Commands:
  install       Configure Claude Code and Codex and install the hooks.
  uninstall     Remove everything Block Attribution changed.
  status        Show detected agents and what is installed.
  check         Check unpushed commits and the open pull request in this repository.

Install options:
  --dry-run                   Show the changes without writing anything.
  --yes, --non-interactive    Do not ask; use flags, saved answers, then defaults.
  --skip-claude               Do not configure Claude Code.
  --skip-codex                Do not configure Codex.
  --git-hooks / --no-git-hooks
                              Install global git hooks (default: yes).
  --remove-git-instructions / --keep-git-instructions
                              Remove Claude Code's built-in commit and PR instructions (default: keep).
  --binary <path>             Executable to install (defaults to this executable).

Uninstall options:
  --dry-run, --yes`;

type Flags = {
  dryRun: boolean;
  yes: boolean;
  skip: Set<AgentName>;
  gitHooks?: boolean;
  removeGitInstructions?: boolean;
  binary?: string;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { dryRun: false, yes: false, skip: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--yes":
      case "--non-interactive":
        flags.yes = true;
        break;
      case "--skip-claude":
        flags.skip.add("claude");
        break;
      case "--skip-codex":
        flags.skip.add("codex");
        break;
      case "--git-hooks":
      case "--no-git-hooks":
        flags.gitHooks = arg === "--git-hooks";
        break;
      case "--remove-git-instructions":
      case "--keep-git-instructions":
        flags.removeGitInstructions = arg === "--remove-git-instructions";
        break;
      case "--binary":
        flags.binary = args[index + 1] ?? fail("--binary requires a path.");
        index += 1;
        break;
      default:
        fail(`Unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return flags;
}

function selfExecutable(flags: Flags): string | undefined {
  if (flags.binary) {
    return flags.binary;
  }
  // A compiled Bun executable runs its bundled source from the virtual /$bunfs/ file system.
  return import.meta.path.startsWith("/$bunfs/") || import.meta.path.startsWith("B:\\~BUN\\") ? process.execPath : undefined;
}

function savedAnswers(environment: Environment): Partial<InstallChoices> {
  try {
    const config = JSON.parse(readFileSync(appPaths(environment).config, "utf8")) as { answers?: Partial<InstallChoices> };
    return config.answers ?? {};
  } catch {
    return {};
  }
}

/** One line per step; several files written by the same step are listed once. */
function summarize(plan: Plan): string[] {
  return [...new Set(plan.operations.map((operation) => operation.description))];
}

function printPlan(plan: Plan, dryRun: boolean): void {
  if (plan.operations.length === 0) {
    console.log("Nothing to change.");
  }
  if (dryRun) {
    plan.operations.forEach((operation) => console.log(`Would: ${describeOperation(operation, true)}`));
  } else {
    summarize(plan).forEach((line) => console.log(`- ${line}`));
  }
  plan.warnings.forEach((warning) => console.log(`Warning: ${warning}`));
}

const CODEX_ACCOUNT_NOTE =
  "Codex attribution is an account setting on OpenAI's side; a config file cannot turn it off. The hooks block it either way.";

function finalNotes(plan: Plan, choices: InstallChoices): string[] {
  return [
    ...plan.notes,
    ...(choices.agents.includes("codex") ? [CODEX_ACCOUNT_NOTE] : []),
    "Start a new agent session so the hooks are loaded.",
  ];
}

function exitIfCancelled<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel("Nothing was changed.");
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
}

async function install(flags: Flags): Promise<void> {
  const environment = defaultEnvironment();
  const detections = detectAgents(environment);
  const saved = savedAnswers(environment);
  const interactive = !flags.yes && process.stdin.isTTY === true;
  const found = detections.filter((detection) => detection.found && !flags.skip.has(detection.agent)).map((detection) => detection.agent);

  let choices: InstallChoices = {
    agents: found,
    gitHooks: flags.gitHooks ?? saved.gitHooks ?? true,
    removeGitInstructions: flags.removeGitInstructions ?? saved.removeGitInstructions ?? false,
  };

  if (interactive) {
    intro("Block Attribution");
    note(detections.map(describeDetection).join("\n"), "Detected agents");
    const agents =
      found.length === 0
        ? []
        : exitIfCancelled(
            await multiselect<AgentName>({
              message: "Configure these agents to stop adding attribution?",
              options: found.map((agent) => ({ value: agent, label: agent === "claude" ? "Claude Code (CLI and Desktop)" : "Codex (CLI and Desktop)" })),
              initialValues: found,
              required: false,
            }),
          );
    const gitHooks =
      flags.gitHooks ??
      exitIfCancelled(
        await confirm({
          // A saved answer becomes the default, so the recommendation is only shown on the first run.
          message: `Install global git hooks that reject commits and pushes with AI attribution?${saved.gitHooks === undefined ? " (recommended)" : ""}`,
          initialValue: saved.gitHooks ?? true,
        }),
      );
    const removeGitInstructions =
      !agents.includes("claude")
        ? false
        : (flags.removeGitInstructions ??
          exitIfCancelled(
            await confirm({
              message:
                "Remove Claude Code's built-in commit and PR instructions? Only recommended if you use your own git workflow skills; it also removes the git status snapshot.",
              initialValue: saved.removeGitInstructions ?? false,
            }),
          ));
    choices = { agents, gitHooks, removeGitInstructions };
  }

  const plan = planInstall({ environment, binarySource: selfExecutable(flags) }, choices);

  if (flags.dryRun) {
    printPlan(plan, true);
    finalNotes(plan, choices).forEach((line) => console.log(`Note: ${line}`));
    return;
  }

  if (interactive) {
    note(summarize(plan).join("\n") || "Nothing to change.", "Changes");
    plan.warnings.forEach((warning) => log.warn(warning));
    if (plan.operations.length > 0 && !exitIfCancelled(await confirm({ message: "Apply these changes?", initialValue: true }))) {
      cancel("Nothing was changed.");
      process.exit(1);
    }
    const progress = spinner();
    progress.start("Applying changes");
    await executeOperations(plan.operations);
    progress.stop("Changes applied");
    finalNotes(plan, choices).forEach((line) => log.info(line));
    outro(`To uninstall: ${appPaths(environment).binary} uninstall`);
    return;
  }

  printPlan(plan, false);
  await executeOperations(plan.operations);
  finalNotes(plan, choices).forEach((line) => console.log(`Note: ${line}`));
  console.log(`Done. To uninstall: ${appPaths(environment).binary} uninstall`);
}

async function uninstall(flags: Flags): Promise<void> {
  const environment = defaultEnvironment();
  const plan = planUninstall({ environment });
  printPlan(plan, flags.dryRun);
  if (flags.dryRun) {
    return;
  }
  if (!flags.yes && process.stdin.isTTY === true && plan.operations.length > 0) {
    if (!exitIfCancelled(await confirm({ message: "Remove Block Attribution?", initialValue: true }))) {
      cancel("Nothing was changed.");
      process.exit(1);
    }
  }
  await executeOperations(plan.operations);
  plan.notes.forEach((line) => console.log(`Note: ${line}`));
  console.log("Block Attribution was removed.");
}

function status(): void {
  const environment = defaultEnvironment();
  detectAgents(environment).forEach((detection) => console.log(describeDetection(detection)));
  const manifest = readManifest(environment);
  console.log(
    manifest
      ? `Installed for: ${[manifest.claude && "Claude Code", manifest.codex && "Codex", manifest.git && "git"].filter(Boolean).join(", ") || "nothing"}`
      : "Not installed.",
  );
}

function check(): void {
  const patterns = extraPatterns(readUserConfig(defaultEnvironment()));
  const cwd = process.cwd();
  const commits = checkUnpublishedCommits(cwd, patterns);
  const pullRequest = checkCurrentPullRequest(cwd, patterns);
  if (commits.length === 0 && !pullRequest) {
    console.log("No AI attribution found in unpushed commits or the open pull request.");
    return;
  }
  if (commits.length > 0) {
    console.log(formatCommitProblems(commits));
  }
  if (pullRequest) {
    console.log(`Pull request ${pullRequest.url}:\n${pullRequest.details}`);
  }
  process.exit(1);
}

function finish(result: { exitCode: number; stdout?: string; stderr?: string }): never {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode);
}

process.on("uncaughtException", (error) => {
  console.error(`block-attribution: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "install":
    await install(parseFlags(args));
    break;
  case "uninstall":
    await uninstall(parseFlags(args));
    break;
  case "status":
    status();
    break;
  case "check":
    check();
    break;
  case "hook": {
    const event = args[0];
    if (event !== "pre-tool-use" && event !== "stop") {
      fail("Usage: block-attribution hook <pre-tool-use|stop>");
    }
    const patterns = extraPatterns(readUserConfig(defaultEnvironment()));
    finish(runHook(event as HookEvent, await Bun.stdin.text(), patterns));
    break;
  }
  case "git-hook": {
    const patterns = extraPatterns(readUserConfig(defaultEnvironment()));
    if (args[0] === "commit-msg" && args[1]) {
      finish(runCommitMsgHook(args[1], patterns));
    }
    if (args[0] === "pre-push") {
      finish(runPrePushHook(process.cwd(), args[1] ?? "origin", await Bun.stdin.text(), patterns));
    }
    fail("Usage: block-attribution git-hook <commit-msg <file>|pre-push <remote> <url>>");
    break;
  }
  case "-h":
  case "--help":
  case undefined:
    console.log(USAGE);
    break;
  default:
    fail(`Unknown command: ${command}\n\n${USAGE}`);
}
