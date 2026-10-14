import { createHash } from "node:crypto";

import type { HookHandler } from "./hook-entries.ts";
import { canonicalJson, isObject, type JsonObject } from "./json.ts";

export type CodexEventLabel = "pre_tool_use" | "stop";

// Codex drops the matcher of these events before hashing (codex-rs/hooks/src/events/common.rs).
const EVENTS_WITHOUT_MATCHER = new Set<CodexEventLabel>(["stop"]);
const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * The hash Codex stores in `[hooks.state."<key>"] trusted_hash` once a hook is trusted
 * (codex-rs/hooks/src/engine/discovery.rs, codex-rs/config/src/fingerprint.rs): sha256 of the
 * compact, key-sorted JSON of the event label, matcher and normalized handler.
 */
export function codexTrustedHash(event: CodexEventLabel, matcher: string | undefined, handler: HookHandler): string {
  const identity = canonicalJson({
    event_name: event,
    ...(matcher !== undefined && !EVENTS_WITHOUT_MATCHER.has(event) ? { matcher } : {}),
    hooks: [
      {
        type: handler.type,
        command: handler.command,
        timeout: Math.max(1, handler.timeout ?? DEFAULT_TIMEOUT_SECONDS),
        async: false,
      },
    ],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function codexTrustKey(hooksJsonPath: string, event: CodexEventLabel, groupIndex: number, handlerIndex: number): string {
  return `${hooksJsonPath}:${event}:${groupIndex}:${handlerIndex}`;
}

type Lines = { lines: string[]; eol: string };

function splitLines(text: string): Lines {
  return { lines: text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function joinLines({ lines, eol }: Lines): string {
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length === 0 ? "" : `${lines.join(eol)}${eol}`;
}

export function parseToml(text: string, path: string): JsonObject {
  if (text.trim() === "") {
    return {};
  }
  try {
    const parsed = Bun.TOML.parse(text) as unknown;
    if (!isObject(parsed)) {
      throw new Error("the root value must be a table");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cannot safely edit ${path}: invalid TOML (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function stateHeader(key: string): string {
  return `[hooks.state.${JSON.stringify(key)}]`;
}

function findTable(lines: string[], header: string): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => line.trim() === header || line.trim().startsWith(`${header} #`));
  if (start < 0) {
    return undefined;
  }
  const next = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return { start, end: next < 0 ? lines.length : next };
}

export function readTrustedHash(text: string, path: string, key: string): string | undefined {
  const parsed = parseToml(text, path);
  const hooks = isObject(parsed.hooks) ? parsed.hooks : {};
  const state = isObject(hooks.state) ? hooks.state : {};
  const entry = state[key];
  return isObject(entry) && typeof entry.trusted_hash === "string" ? entry.trusted_hash : undefined;
}

const TRUSTED_HASH_LINE = /^\s*trusted_hash\s*=/;

export function setTrustedHash(text: string, path: string, key: string, hash: string): string {
  if (readTrustedHash(text, path, key) === hash) {
    return text;
  }
  const split = splitLines(text);
  const header = stateHeader(key);
  const table = findTable(split.lines, header);
  const line = `trusted_hash = ${JSON.stringify(hash)}`;

  if (table) {
    const hashIndex = split.lines.findIndex((value, index) => index > table.start && index < table.end && TRUSTED_HASH_LINE.test(value));
    if (hashIndex >= 0) {
      split.lines[hashIndex] = line;
    } else {
      split.lines.splice(table.start + 1, 0, line);
    }
  } else {
    // Keep hook state tables together: insert after the last existing one, else append.
    const lastState = split.lines.reduce((last, value, index) => (/^\s*\[hooks\.state\./.test(value) ? index : last), -1);
    if (lastState >= 0) {
      const end = findTable(split.lines, split.lines[lastState]!.trim())!.end;
      let insertAt = end;
      while (insertAt > lastState + 1 && split.lines[insertAt - 1]!.trim() === "") {
        insertAt -= 1;
      }
      split.lines.splice(insertAt, 0, "", header, line);
    } else {
      if (split.lines.some((value) => value.trim() !== "")) {
        split.lines.push("");
      }
      split.lines.push(header, line);
    }
  }

  const updated = joinLines(split);
  parseToml(updated, path);
  return updated;
}

/** Removes the trusted hash we set; drops the table when nothing else is left in it. */
export function removeTrustedHash(text: string, path: string, key: string): string {
  const split = splitLines(text);
  const table = findTable(split.lines, stateHeader(key));
  if (!table) {
    return text;
  }
  const body = split.lines.slice(table.start + 1, table.end).filter((line) => !TRUSTED_HASH_LINE.test(line));
  const meaningful = body.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (meaningful.length === 0) {
    split.lines.splice(table.start, table.end - table.start);
    const next = split.lines[table.start];
    if (table.start > 0 && split.lines[table.start - 1]?.trim() === "" && (next === undefined || next.trim() === "")) {
      split.lines.splice(table.start - 1, 1);
    }
  } else {
    split.lines.splice(table.start + 1, table.end - table.start - 1, ...body);
  }
  const updated = joinLines(split);
  parseToml(updated, path);
  return updated;
}

/** Renames a state table, used when removing our group shifts the index of a later group. */
export function renameTrustKey(text: string, path: string, from: string, to: string): string {
  const split = splitLines(text);
  const table = findTable(split.lines, stateHeader(from));
  if (!table || findTable(split.lines, stateHeader(to))) {
    return text;
  }
  split.lines[table.start] = stateHeader(to);
  const updated = joinLines(split);
  parseToml(updated, path);
  return updated;
}

/** Codex hooks are on by default; returns the edited text when `features.hooks` is explicitly false. */
export function enableHooksFeature(text: string, path: string): string {
  const parsed = parseToml(text, path);
  const features = isObject(parsed.features) ? parsed.features : {};
  const key = typeof features.hooks === "boolean" ? "hooks" : typeof features.codex_hooks === "boolean" ? "codex_hooks" : undefined;
  if (!key || features[key] !== false) {
    return text;
  }
  const split = splitLines(text);
  const table = findTable(split.lines, "[features]");
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)false\\b`);
  const index = table ? split.lines.findIndex((line, i) => i > table.start && i < table.end && pattern.test(line)) : -1;
  if (index < 0) {
    throw new Error(`Cannot safely edit ${path}: set features.${key} = true by hand to enable Codex hooks.`);
  }
  split.lines[index] = split.lines[index]!.replace(pattern, "$1true");
  return joinLines(split);
}
