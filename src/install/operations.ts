import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type WriteOperation = {
  kind: "write";
  path: string;
  content: string | Uint8Array;
  previous?: string;
  mode?: number;
  /** False for copies such as backups, whose content dry-run should not print. */
  showDiff?: boolean;
  description: string;
};

export type DeleteOperation = {
  kind: "delete";
  path: string;
  recursive?: boolean;
  description: string;
};

export type RunOperation = {
  kind: "run";
  command: string[];
  env?: Record<string, string | undefined>;
  description: string;
};

export type Operation = WriteOperation | DeleteOperation | RunOperation;

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Writes through a temporary file and a rename; follows a symlinked target and keeps its mode. */
async function atomicWrite(path: string, content: string | Uint8Array, mode?: number): Promise<void> {
  let target = path;
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      target = await realpath(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.block-attribution-${process.pid}-${crypto.randomUUID()}`);
  try {
    await writeFile(temporary, content);
    if (mode !== undefined) {
      await chmod(temporary, mode);
    } else {
      try {
        await chmod(temporary, (await stat(target)).mode & 0o777);
      } catch {
        // New file: keep the default mode.
      }
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function executeOperations(operations: readonly Operation[]): Promise<void> {
  for (const operation of operations) {
    if (operation.kind === "write") {
      await atomicWrite(operation.path, operation.content, operation.mode);
    } else if (operation.kind === "delete") {
      await rm(operation.path, { force: true, recursive: operation.recursive ?? false });
    } else {
      const [command, ...args] = operation.command;
      const result = spawnSync(command!, args, {
        encoding: "utf8",
        env: { ...process.env, ...operation.env },
      });
      if (result.status !== 0) {
        throw new Error(`${operation.command.join(" ")} failed: ${result.stderr || result.error?.message || "unknown error"}`);
      }
    }
  }
}

/** A minimal unified diff for dry-run output. */
export function renderDiff(before: string, after: string, context = 2): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const lines: { mark: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ mark: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      lines.push({ mark: "+", text: b[j]! });
      j += 1;
    } else {
      lines.push({ mark: "-", text: a[i]! });
      i += 1;
    }
  }

  const visible = lines.map((_, index) =>
    lines.slice(Math.max(0, index - context), index + context + 1).some((near) => near.mark !== " "),
  );
  const output: string[] = [];
  lines.forEach((line, index) => {
    if (visible[index]) {
      output.push(`${line.mark} ${line.text}`);
    } else if (visible[index - 1]) {
      output.push("  …");
    }
  });
  return output.join("\n");
}

const SECRET_LINE = /(token|bearer|authorization|secret|password|api[_-]?key|credential)/i;

/** Dry-run output must not print credentials that live next to the edited settings. */
function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? line.replace(/(=|:)\s*.*$/, "$1 <redacted>") : line))
    .join("\n");
}

export function describeOperation(operation: Operation, withDiff: boolean): string {
  if (operation.kind === "run") {
    return `${operation.description}\n    $ ${operation.command.join(" ")}`;
  }
  if (operation.kind === "delete") {
    return `${operation.description}\n    delete ${operation.path}`;
  }
  const header = `${operation.description}\n    write ${operation.path}`;
  if (!withDiff || operation.showDiff === false || typeof operation.content !== "string") {
    return header;
  }
  const diff = renderDiff(redactSecrets(operation.previous ?? ""), redactSecrets(operation.content))
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `${header}\n${diff}`;
}
