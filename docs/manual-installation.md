# Manual installation

The installer supports macOS. Use this guide on other systems, or when the installer fails. It makes the same changes by hand; skip any agent you don't use.

In the examples, `<executable>` is the full path of the `block-attribution` executable, for example `/home/me/.local/bin/block-attribution`. Agents and git call it by full path, so it doesn't need to be in `PATH`.

## Installation

### 1. Get the executable

Download the file for your platform from the [releases](https://github.com/arklanq/block-attribution/releases) page, if there is one, and check it against the `.sha256` file next to it. Otherwise build it with [Bun](https://bun.sh):

```bash
git clone https://github.com/arklanq/block-attribution.git
cd block-attribution
bun install
bun run build:binary
```

The executable is in `release/`. Copy it to a directory of your choice, for example `~/.local/bin`, and make it executable (`chmod +x` on macOS and Linux).

Check that it runs:

```bash
<executable> status
```

`status` lists the agents it finds. It reports "Not installed" after a manual installation, because only the installer writes an install record.

### 2. Claude Code

Edit `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). Create it with `{}` if it doesn't exist, and merge these keys into the existing ones instead of replacing the file:

```json
{
  "attribution": { "commit": "", "pr": "", "sessionUrl": false },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|mcp__.*)$",
        "hooks": [{ "type": "command", "command": "'<executable>' hook pre-tool-use", "timeout": 30 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "'<executable>' hook stop", "timeout": 60 }]
      }
    ]
  }
}
```

- If `hooks.PreToolUse` or `hooks.Stop` already exist, add the entries above to the end of those arrays.
- The single quotes keep a path with spaces together. On a system whose shell doesn't accept them, use the quoting that shell needs.
- Optional: add `"includeGitInstructions": false` to remove Claude Code's built-in commit and PR instructions. Only do this if you use your own git workflow skills, because it also removes the git status snapshot.

Claude Code applies settings changes without a restart, but start a new session to be sure the hooks are loaded.

### 3. Codex

Edit `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`). Create it with `{ "hooks": {} }` if it doesn't exist, and add these entries to the end of the `PreToolUse` and `Stop` arrays:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Bash|mcp__.*)$",
        "hooks": [{ "type": "command", "command": "'<executable>' hook pre-tool-use", "timeout": 30 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "'<executable>' hook stop", "timeout": 60 }]
      }
    ]
  }
}
```

- Add to the end of the arrays, not the beginning: Codex remembers approved hooks by their position, so moving your existing hooks would make Codex ask you to approve them again.
- On Windows, a handler can also have a `commandWindows` field, which Codex uses instead of `command` there.
- Codex runs new hooks only after you approve them. Start Codex, run `/hooks`, and approve the two Block Attribution hooks. (The installer writes this approval to `config.toml` itself; by hand, `/hooks` is the reliable way.)
- If `~/.codex/config.toml` has `hooks = false` under `[features]`, change it to `true`. Hooks are on by default.

Codex has no setting for attribution in its config files; it is an account setting on OpenAI's side. The hooks block it either way.

### 4. Git hooks (optional, recommended)

These hooks stop commits and pushes that contain attribution, whichever tool makes them.

First check whether a global hooks directory is already set:

```bash
git config --global --get core.hooksPath
```

If it prints a directory, use that directory instead of creating a new one, and don't change the setting. If it already has a `commit-msg` or `pre-push` file, add the `if [ -x '<executable>' ] … fi` block from the script below near the top of that file instead of replacing it.

Otherwise create a directory, for example `~/.config/block-attribution/git-hooks`, with these two files, and make both executable (`chmod +x`). Git for Windows runs them with its bundled shell.

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

Then point git at the directory:

```bash
git config --global core.hooksPath ~/.config/block-attribution/git-hooks
```

A global `core.hooksPath` makes git skip each repository's own `.git/hooks`. The two scripts above still run the repository's `commit-msg` and `pre-push`. If your repositories use other hooks in `.git/hooks`, such as `pre-commit`, add a forwarding script for each of them to the same directory:

```sh
#!/bin/sh
repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-commit"
if [ -x "$repo_hook" ]; then
  exec "$repo_hook" "$@"
fi
exit 0
```

Replace `pre-commit` in the file name and in the script with the hook's name. Repositories with their own `core.hooksPath` (husky, lefthook) don't use the global directory at all.

### 5. Check that it works

In a throwaway repository, a commit with an AI trailer must fail:

```bash
git init /tmp/block-attribution-test && cd /tmp/block-attribution-test
printf 'test\n\nCo-authored-by: Claude <noreply@anthropic.com>\n' > message.txt
git commit --allow-empty -F message.txt
```

The commit is rejected with "Block Attribution: the commit message contains AI attribution". Then ask Claude Code or Codex to make a commit with a `Co-authored-by: Claude` trailer; the agent hook stops the command and the agent retries without it.

## Uninstallation

Undo only the steps you did.

1. **Claude Code**: in `~/.claude/settings.json`, remove the `PreToolUse` and `Stop` entries whose command contains `block-attribution`, and delete `PreToolUse` or `Stop` if the array is empty. Remove `attribution` (or set your previous value) and `includeGitInstructions` if you added it.
2. **Codex**: in `~/.codex/hooks.json`, remove the two entries whose command contains `block-attribution`. Their approvals in `~/.codex/config.toml` are tables named like `[hooks.state."/home/me/.codex/hooks.json:stop:1:0"]`; delete the two that belong to the removed entries. If you removed entries that were not last in their array, open `/hooks` in Codex afterwards and approve the hooks it asks about again.
3. **Git**: if you created the hooks directory, run `git config --global --unset core.hooksPath` and delete the directory. If you added the scripts to an existing hooks directory, delete just those files.
4. Delete the executable, and `~/.config/block-attribution` if it exists.

Start new agent sessions afterwards so they stop loading the removed hooks.
