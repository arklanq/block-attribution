import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type Node,
  type ParseError,
} from "jsonc-parser";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string, path: string): JsonObject {
  if (text.trim() === "") {
    return {};
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) {
    const error = errors[0]!;
    throw new Error(`Cannot safely edit ${path}: ${printParseErrorCode(error.error)} at offset ${error.offset}.`);
  }
  if (!isObject(value)) {
    throw new Error(`Cannot safely edit ${path}: the root value must be an object.`);
  }
  return value;
}

function formattingOptions(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/^(\s+)["}]/m)?.[1] ?? "  ";
  const insertSpaces = !indent.includes("\t");
  return { eol, insertSpaces, tabSize: insertSpaces ? Math.max(1, indent.length) : 1 };
}

/** Sets (or, with `undefined`, removes) a value while keeping the rest of the file's formatting. */
export function setJsonValue(text: string, path: (string | number)[], value: unknown): string {
  const source = text.trim() === "" ? "{}\n" : text;
  return applyEdits(source, modify(source, path, value, { formattingOptions: formattingOptions(source) }));
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function arrayNode(text: string, path: (string | number)[]): Node | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  const node = root ? findNodeAtLocation(root, path) : undefined;
  return node?.type === "array" ? node : undefined;
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * Appends an item as text after the last one, so the existing items keep their exact formatting
 * (jsonc-parser's own insertion reformats the item before the new one).
 */
export function appendJsonArrayItem(text: string, path: (string | number)[], value: unknown): string {
  const array = arrayNode(text, path);
  const last = array?.children?.at(-1);
  if (!array || !last) {
    return setJsonValue(text, path, [value]);
  }
  const indent = lineIndent(text, last.offset);
  const options = formattingOptions(text);
  const unit = options.insertSpaces ? " ".repeat(options.tabSize ?? 2) : "\t";
  const rendered = JSON.stringify(value, null, unit).replaceAll("\n", `${options.eol}${indent}`);
  const end = last.offset + last.length;
  return `${text.slice(0, end)},${options.eol}${indent}${rendered}${text.slice(end)}`;
}

/** Removes one array item together with its separator, leaving the other items untouched. */
export function deleteJsonArrayItem(text: string, path: (string | number)[], index: number): string {
  const items = arrayNode(text, path)?.children ?? [];
  const item = items[index];
  if (!item) {
    return text;
  }
  if (items.length === 1) {
    return setJsonValue(text, path, []);
  }
  if (index > 0) {
    const previous = items[index - 1]!;
    return `${text.slice(0, previous.offset + previous.length)}${text.slice(item.offset + item.length)}`;
  }
  return `${text.slice(0, item.offset)}${text.slice(items[1]!.offset)}`;
}
