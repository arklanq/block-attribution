# Manual installation

For macOS/Linux when the installer cannot be used, or for other agents. Back up edited files and preserve existing settings and hooks. See [coverage and limits](README.md#coverage-and-limits).

## Executable

Download your platform's binary from [releases](https://github.com/arklanq/block-attribution/releases) and verify its adjacent SHA-256 checksum, or build from a checkout:

```bash
bun install
bun run build:binary
```

Copy the binary to `~/.local/bin/block-attribution` and run `chmod +x` on it. Below, replace `<executable>` with its absolute path. Manual installation creates no manifest, so `status` still reports "Not installed".

## Agent hooks

Merge the following into `~/.claude/settings.json` and/or `~/.codex/hooks.json`, appending entries to existing arrays. Use `$CLAUDE_CONFIG_DIR` or `$CODEX_HOME` if configured. Create missing files with `{}`.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^(Bash|mcp__.*)$",
      "hooks": [{ "type": "command", "command": "'<executable>' hook pre-tool-use", "timeout": 30 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "'<executable>' hook stop", "timeout": 60 }]
    }]
  }
}
```

For **Claude Code**, also set this top-level key in `settings.json`:

```json
"attribution": { "commit": "", "pr": "", "sessionUrl": false }
```

For **Codex**, approve both hooks through `/hooks`. If `[features]` in `config.toml` explicitly disables `hooks` or its alias `codex_hooks`, set that key to `true`. Append hooks without reordering existing entries, because trust uses array positions. Codex's attribution policy cannot be disabled in local settings.

Start new agent sessions after editing.

### Other agents

Adapt the agent's hook payloads to this contract; both commands read JSON from stdin.

| Command | Input | Blocking response |
| :- | :- | :- |
| `<executable> hook pre-tool-use` | `cwd`, `tool_name` (`Bash` or `mcp__<server>__<tool>`), `tool_input` (`{"command":"…"}` for Bash). | Exit 2; reason on stderr. |
| `<executable> hook stop` | `cwd`, `stop_hook_active` (true when already continuing because of this hook). | Exit 0; `{"decision":"block","reason":"…"}` on stdout. |

Agents without hooks can still use Git hooks and `block-attribution check`.

## Git hooks

Optional, recommended. Check `git config --global --get core.hooksPath` first. If set, use that directory and preserve its scripts; otherwise create `~/.config/block-attribution/git-hooks`.

Create these executable files (`chmod +x`). If a file already exists, integrate only the attribution check into it, preserving its existing logic and stdin handling.

`commit-msg`:

```sh
#!/bin/sh
if [ -x '<executable>' ]; then
  '<executable>' git-hook commit-msg "$1" || exit 1
fi
repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/commit-msg"
if [ -x "$repo_hook" ]; then
  exec "$repo_hook" "$@"
fi
exit 0
```

`pre-push`:

```sh
#!/bin/sh
input="$(cat)"
if [ -x '<executable>' ]; then
  printf '%s\n' "$input" | '<executable>' git-hook pre-push "$@" || exit 1
fi
repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-push"
if [ -x "$repo_hook" ]; then
  printf '%s\n' "$input" | "$repo_hook" "$@"
  exit $?
fi
exit 0
```

Global hooks replace repository `.git/hooks`. To preserve other repository hooks, create an executable forwarder for each name, replacing `pre-commit` below:

```sh
#!/bin/sh
repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-commit"
if [ -x "$repo_hook" ]; then
  exec "$repo_hook" "$@"
fi
exit 0
```

If no global path was previously set, enable the new directory:

```bash
git config --global core.hooksPath ~/.config/block-attribution/git-hooks
```

## Verify

In a disposable repository with Git author identity configured, this commit must fail:

```bash
git init /tmp/block-attribution-test && cd /tmp/block-attribution-test
printf 'test\n\nCo-authored-by: Claude <noreply@anthropic.com>\n' > message.txt
git commit --allow-empty -F message.txt
```

Also ask your agent to attempt an attributed commit: its hook should block the command and request a clean retry.

## Uninstall

1. Remove only the agent hook entries you added. Restore Claude's previous `attribution` value and any Codex feature flag you changed.
2. Remove matching `[hooks.state."…"]` approvals from Codex's `config.toml`. If remaining hooks shifted position, approve them again through `/hooks`.
3. Undo your Git script additions. Unset global `core.hooksPath` only if you set it and it still points to your directory.
4. Remove the executable and files you created under `~/.config/block-attribution/`. Start new agent sessions.
