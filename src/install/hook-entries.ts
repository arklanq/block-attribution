import {
  appendJsonArrayItem,
  deleteJsonArrayItem,
  isObject,
  jsonEqual,
  parseJsonObject,
  setJsonValue,
  type JsonObject,
} from "./json.ts";

export type HookHandler = {
  type: "command";
  command: string;
  timeout: number;
};

export type HookGroup = {
  matcher?: string;
  hooks: HookHandler[];
};

const MANAGED_COMMAND = /block-attribution['"]? hook (?:pre-tool-use|stop)\b/;

export function isManagedHandler(handler: unknown): boolean {
  return isObject(handler) && typeof handler.command === "string" && MANAGED_COMMAND.test(handler.command);
}

function readGroups(text: string, path: string, event: string): unknown[] {
  const root = parseJsonObject(text, path);
  if (root.hooks !== undefined && !isObject(root.hooks)) {
    throw new Error(`Cannot safely edit ${path}: "hooks" must be an object.`);
  }
  const groups = isObject(root.hooks) ? root.hooks[event] : undefined;
  if (groups !== undefined && !Array.isArray(groups)) {
    throw new Error(`Cannot safely edit ${path}: hooks.${event} must be an array.`);
  }
  return groups ?? [];
}

function handlers(group: unknown): unknown[] {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
}

export type UpsertResult = { text: string; groupIndex: number; handlerIndex: number };

/**
 * Puts the managed group in place. An existing managed handler is updated where it is, so other
 * entries keep their positions (Codex trust keys depend on them); otherwise the group is appended.
 */
export function upsertManagedGroup(text: string, path: string, event: string, group: HookGroup): UpsertResult {
  const groups = readGroups(text, path, event);
  const groupIndex = groups.findIndex((candidate) => handlers(candidate).some(isManagedHandler));

  if (groupIndex < 0) {
    return { text: appendJsonArrayItem(text, ["hooks", event], group), groupIndex: groups.length, handlerIndex: 0 };
  }

  const existing = groups[groupIndex] as JsonObject;
  const existingHandlers = handlers(existing);
  const handlerIndex = existingHandlers.findIndex(isManagedHandler);
  const replacement: JsonObject =
    existingHandlers.length === 1
      ? { ...existing, ...group }
      : { ...existing, hooks: existingHandlers.map((handler, index) => (index === handlerIndex ? group.hooks[0] : handler)) };
  if (jsonEqual(existing, replacement)) {
    return { text, groupIndex, handlerIndex };
  }
  return {
    text: setJsonValue(text, ["hooks", event, groupIndex], replacement),
    groupIndex,
    handlerIndex: existingHandlers.length === 1 ? 0 : handlerIndex,
  };
}

export type RemoveResult = {
  text: string;
  /** Old group index → new group index, for groups that remain. */
  moved: Map<number, number>;
  removedGroups: number[];
};

export function removeManagedGroups(text: string, path: string, event: string): RemoveResult {
  const groups = readGroups(text, path, event);
  const moved = new Map<number, number>();
  const removedGroups: number[] = [];
  let updated = text;

  // Walk backwards so earlier indexes stay valid while items are removed.
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const groupHandlers = handlers(groups[index]);
    if (!groupHandlers.some(isManagedHandler)) {
      continue;
    }
    if (groupHandlers.every(isManagedHandler)) {
      updated = deleteJsonArrayItem(updated, ["hooks", event], index);
      removedGroups.push(index);
      continue;
    }
    for (let handler = groupHandlers.length - 1; handler >= 0; handler -= 1) {
      if (isManagedHandler(groupHandlers[handler])) {
        updated = deleteJsonArrayItem(updated, ["hooks", event, index, "hooks"], handler);
      }
    }
  }
  groups.forEach((_, index) => {
    if (!removedGroups.includes(index)) {
      moved.set(index, index - removedGroups.filter((removed) => removed < index).length);
    }
  });

  if (updated === text) {
    return { text, moved, removedGroups };
  }
  if (readGroups(updated, path, event).length === 0) {
    updated = setJsonValue(updated, ["hooks", event], undefined);
  }
  const root = parseJsonObject(updated, path);
  if (isObject(root.hooks) && Object.keys(root.hooks).length === 0) {
    updated = setJsonValue(updated, ["hooks"], undefined);
  }
  return { text: updated, moved, removedGroups: removedGroups.reverse() };
}

export function hasManagedGroup(text: string, path: string, event: string): boolean {
  return readGroups(text, path, event).some((group) => handlers(group).some(isManagedHandler));
}
