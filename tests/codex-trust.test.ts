import { describe, expect, test } from "bun:test";

import {
  codexTrustedHash,
  enableHooksFeature,
  readTrustedHash,
  removeTrustedHash,
  renameTrustKey,
  setTrustedHash,
} from "../src/install/codex-trust.ts";

describe("codexTrustedHash", () => {
  test("matches a hash Codex 0.162 wrote for a Stop hook", () => {
    // Recorded by Codex itself in ~/.codex/config.toml after the hook was approved in /hooks.
    expect(
      codexTrustedHash("stop", undefined, { type: "command", command: "/Users/arek/.local/bin/plannotator", timeout: 345600 }),
    ).toBe("sha256:86639dc12abe16305c7b7c86394d1c781ee0582a020df5a187abd6ba36804d6f");
  });

  test("ignores the matcher of Stop hooks", () => {
    const handler = { type: "command" as const, command: "x", timeout: 60 };
    expect(codexTrustedHash("stop", "anything", handler)).toBe(codexTrustedHash("stop", undefined, handler));
    expect(codexTrustedHash("pre_tool_use", "Bash", handler)).not.toBe(codexTrustedHash("pre_tool_use", undefined, handler));
  });
});

describe("trust table editing", () => {
  const base = '[features]\nhooks = true\n\n[hooks.state."/h.json:stop:0:0"]\ntrusted_hash = "sha256:a"\n\n[mcp_servers.x]\ncommand = "x"\n';

  test("inserts new tables next to existing hook state and removes them again", () => {
    const added = setTrustedHash(base, "config.toml", "/h.json:stop:1:0", "sha256:b");
    expect(added).toContain('trusted_hash = "sha256:a"\n\n[hooks.state."/h.json:stop:1:0"]\ntrusted_hash = "sha256:b"\n\n[mcp_servers.x]');
    expect(readTrustedHash(added, "config.toml", "/h.json:stop:1:0")).toBe("sha256:b");
    expect(setTrustedHash(added, "config.toml", "/h.json:stop:1:0", "sha256:b")).toBe(added);
    expect(removeTrustedHash(added, "config.toml", "/h.json:stop:1:0")).toBe(base);
  });

  test("appends to a file without hook state", () => {
    expect(setTrustedHash("", "config.toml", "/h.json:stop:0:0", "sha256:c")).toBe(
      '[hooks.state."/h.json:stop:0:0"]\ntrusted_hash = "sha256:c"\n',
    );
  });

  test("renames a key when a hook group moves", () => {
    const renamed = renameTrustKey(base, "config.toml", "/h.json:stop:0:0", "/h.json:stop:1:0");
    expect(readTrustedHash(renamed, "config.toml", "/h.json:stop:1:0")).toBe("sha256:a");
  });

  test("turns hooks on only when they are explicitly off", () => {
    expect(enableHooksFeature("[features]\nhooks = false\n", "config.toml")).toBe("[features]\nhooks = true\n");
    expect(enableHooksFeature(base, "config.toml")).toBe(base);
    expect(enableHooksFeature("", "config.toml")).toBe("");
  });
});
