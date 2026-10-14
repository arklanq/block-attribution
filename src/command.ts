import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { describeFindings, findAttribution, type Finding } from "./rules.ts";

const MAX_MESSAGE_FILE_BYTES = 1024 * 1024;
const COMMAND_PREFIXES = new Set(["env", "command", "exec", "sudo", "nohup", "time"]);
// Short options of `git commit` that take a value, so the rest of the cluster is that value.
const COMMIT_VALUE_SHORT_OPTIONS = new Set(["m", "F", "c", "C", "t"]);

export type CommandAnalysis = {
  /** True when the command creates a commit, pushes, or creates or edits a pull request. */
  relevant: boolean;
  problems: string[];
};

/** Splits a shell command into simple commands made of unquoted words. */
export function splitShellCommand(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let index = 0;
  // Heredoc bodies are data, not commands; their text is still checked as part of the whole command.
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];

  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) {
      segments.push(words);
    }
    words = [];
  };

  while (index < command.length) {
    const char = command[index]!;

    if (char === "\\" && index + 1 < command.length) {
      word += command[index + 1];
      inWord = true;
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(index + 1, stop);
      inWord = true;
      index = stop + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && index + 1 < command.length) {
          word += command[index + 1];
          index += 2;
        } else {
          word += command[index];
          index += 1;
        }
      }
      inWord = true;
      index += 1;
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      index += 1;
      continue;
    }
    if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
      endWord();
      index += 2;
      const stripTabs = command[index] === "-";
      if (stripTabs) {
        index += 1;
      }
      while (command[index] === " " || command[index] === "\t") {
        index += 1;
      }
      const match = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/.exec(command.slice(index));
      if (match) {
        heredocs.push({ delimiter: match[1] ?? match[2] ?? match[3]!.replaceAll("\\", ""), stripTabs });
        index += match[0].length;
      }
      continue;
    }
    if (char === "\n" && heredocs.length > 0) {
      endSegment();
      index += 1;
      for (const heredoc of heredocs.splice(0)) {
        while (index < command.length) {
          const lineEnd = command.indexOf("\n", index);
          const end = lineEnd < 0 ? command.length : lineEnd;
          const line = command.slice(index, end);
          index = end + 1;
          if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
            break;
          }
        }
      }
      continue;
    }
    if (char === "\n" || char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      endSegment();
      index += 1;
      continue;
    }
    word += char;
    inWord = true;
    index += 1;
  }

  endSegment();
  return segments;
}

function stripPrefixes(words: string[]): string[] {
  let start = 0;
  while (start < words.length) {
    const word = words[start]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || COMMAND_PREFIXES.has(word)) {
      start += 1;
    } else {
      break;
    }
  }
  return words.slice(start);
}

type GitInvocation = {
  subcommand: string;
  args: string[];
  directory?: string;
  configs: string[];
};

function parseGit(words: string[]): GitInvocation | undefined {
  if (words.length === 0 || basename(words[0]!) !== "git") {
    return undefined;
  }

  const configs: string[] = [];
  let directory: string | undefined;
  let index = 1;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "-c" || word === "-C" || word === "--git-dir" || word === "--work-tree") {
      const value = words[index + 1] ?? "";
      if (word === "-c") {
        configs.push(value);
      } else if (word === "-C") {
        directory = directory ? resolve(directory, value) : value;
      }
      index += 2;
      continue;
    }
    if (word.startsWith("--config-env") || word.startsWith("-c")) {
      configs.push(word.replace(/^(?:-c|--config-env=?)/, ""));
      index += 1;
      continue;
    }
    if (word.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }

  if (index >= words.length) {
    return undefined;
  }
  return {
    subcommand: words[index]!,
    args: words.slice(index + 1),
    ...(directory ? { directory } : {}),
    configs,
  };
}

function parseCommitArgs(args: string[]): { noVerify: boolean; files: string[] } {
  let noVerify = false;
  const files: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      break;
    }
    if (arg === "--no-verify") {
      noVerify = true;
    } else if (arg === "--file" || arg === "-F") {
      files.push(args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--file=")) {
      files.push(arg.slice("--file=".length));
    } else if (/^--(?:message|template|reuse-message|reedit-message|fixup|squash|author|date|cleanup|trailer)$/.test(arg)) {
      index += 1;
    } else if (/^-[^-]/.test(arg)) {
      for (let charIndex = 1; charIndex < arg.length; charIndex += 1) {
        const option = arg[charIndex]!;
        if (option === "n") {
          noVerify = true;
        }
        if (COMMIT_VALUE_SHORT_OPTIONS.has(option)) {
          const attached = arg.slice(charIndex + 1);
          const value = attached || args[index + 1] || "";
          if (option === "F") {
            files.push(value);
          }
          if (!attached) {
            index += 1;
          }
          break;
        }
      }
    }
  }

  return { noVerify, files };
}

function parseGhPrArgs(args: string[]): string[] {
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--body-file" || arg === "-F") {
      files.push(args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--body-file=")) {
      files.push(arg.slice("--body-file=".length));
    }
  }
  return files;
}

function readMessageFile(path: string, cwd: string): string | undefined {
  if (!path || path === "-") {
    return undefined;
  }
  const fullPath = resolve(cwd, path);
  try {
    if (statSync(fullPath).size > MAX_MESSAGE_FILE_BYTES) {
      return undefined;
    }
    return readFileSync(fullPath, "utf8");
  } catch {
    return undefined;
  }
}

function attributionProblem(source: string, findings: Finding[]): string {
  return `${source} contains AI attribution:\n${describeFindings(findings)}`;
}

export function analyzeShellCommand(
  command: string,
  cwd: string,
  extraPatterns: readonly RegExp[] = [],
): CommandAnalysis {
  const problems: string[] = [];
  const messageFiles: { path: string; cwd: string }[] = [];
  let relevant = false;

  for (const segment of splitShellCommand(command)) {
    const words = stripPrefixes(segment);
    // Relative message files are resolved against the directory a preceding `cd` moved to.
    if ((words[0] === "cd" || words[0] === "pushd") && words[1] && !words[1].startsWith("-")) {
      cwd = resolve(cwd, words[1].replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      continue;
    }
    const git = parseGit(words);

    if (git) {
      const gitCwd = git.directory ? resolve(cwd, git.directory) : cwd;
      if (git.subcommand === "commit" || git.subcommand === "push") {
        relevant = true;
        if (git.configs.some((config) => /^core\.hookspath\b/i.test(config))) {
          problems.push("Overriding core.hooksPath bypasses the attribution check.");
        }
      }
      if (git.subcommand === "commit") {
        const commit = parseCommitArgs(git.args);
        if (commit.noVerify) {
          problems.push("git commit --no-verify (-n) skips the attribution check.");
        }
        messageFiles.push(...commit.files.map((path) => ({ path, cwd: gitCwd })));
      } else if (git.subcommand === "push" && git.args.includes("--no-verify")) {
        problems.push("git push --no-verify skips the attribution check.");
      }
      continue;
    }

    if (words.length >= 3 && basename(words[0]!) === "gh") {
      if (words[1] === "pr" && /^(?:create|new|edit|comment|review|merge)$/.test(words[2]!)) {
        relevant = true;
        messageFiles.push(...parseGhPrArgs(words.slice(3)).map((path) => ({ path, cwd })));
      } else if (words[1] === "api" && words.some((word) => /\/pulls\b|\/issues\/\d+\/comments\b/.test(word))) {
        relevant = true;
      }
    }
  }

  if (!relevant) {
    return { relevant, problems };
  }

  const commandFindings = findAttribution(command, extraPatterns);
  if (commandFindings.length > 0) {
    problems.push(attributionProblem("The command", commandFindings));
  }
  for (const file of messageFiles) {
    const content = readMessageFile(file.path, file.cwd);
    const findings = content === undefined ? [] : findAttribution(content, extraPatterns);
    if (findings.length > 0) {
      problems.push(attributionProblem(`The message file ${file.path}`, findings));
    }
  }

  return { relevant, problems };
}

// MCP tools that write commits, files or pull request text, e.g. mcp__github__create_pull_request.
const MCP_WRITE_VERB = /create|update|edit|merge|push|commit|write|add|submit|reply/i;
const MCP_GIT_OBJECT = /pull|_pr\b|commit|push|file|comment|review/i;

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, output));
  }
}

export function analyzeMcpToolCall(
  toolName: string,
  toolInput: unknown,
  extraPatterns: readonly RegExp[] = [],
): CommandAnalysis {
  const tool = toolName.split("__").at(-1) ?? "";
  if (!toolName.startsWith("mcp__") || !MCP_WRITE_VERB.test(tool) || !MCP_GIT_OBJECT.test(tool)) {
    return { relevant: false, problems: [] };
  }
  const strings: string[] = [];
  collectStrings(toolInput, strings);
  const findings = findAttribution(strings.join("\n"), extraPatterns);
  return {
    relevant: true,
    problems: findings.length > 0 ? [attributionProblem(`The ${toolName} call`, findings)] : [],
  };
}
