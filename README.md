# Block Attribution

Block Attribution keeps AI attribution out of your git commits and pull requests: `Co-authored-by` trailers, "Generated with Claude Code / Codex" lines, agent session links and Claude Projects markers.

It turns attribution off in Claude Code, and installs hooks that reject a commit or pull request that still contains it, with a message that tells the agent what to remove. It works with Claude Code and Codex, in the terminal and in their desktop apps.

## Installation

On macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/block-attribution/main/install.sh | bash
```

The script downloads the executable for your platform from GitHub Releases, verifies its SHA-256 checksum and starts a short wizard. The wizard shows which agents it found and asks:

1. Which agents to configure.
2. Whether to install global git hooks (recommended).
3. Whether to remove Claude Code's built-in commit and PR instructions. Only recommended if you use your own git workflow skills, because it also removes the git status snapshot Claude gets at the start of a session.

Preview the changes, or install without questions:

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/block-attribution/main/install.sh | bash -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/arklanq/block-attribution/main/install.sh | bash -s -- --yes --skip-codex --no-git-hooks
```

Without a terminal, or with `--yes`, the installer uses flags first, then your previous answers, then the defaults. Run it again at any time to change the answers.

Remove everything it changed:

```bash
block-attribution uninstall
```

On other systems, or if the installer fails, follow the [manual installation](docs/manual-installation.md) guide. It also covers manual uninstallation.

## What it changes

| Where | Change |
| :- | :- |
| `~/.claude/settings.json` | `attribution` set to `{ "commit": "", "pr": "", "sessionUrl": false }`; `PreToolUse` and `Stop` hooks; optionally `includeGitInstructions: false` |
| `~/.codex/hooks.json` | `PreToolUse` and `Stop` hooks, appended after your own hooks |
| `~/.codex/config.toml` | Trust entries for those two hooks, so Codex runs them without asking |
| Global git config | `core.hooksPath` pointing at `~/.config/block-attribution/git-hooks`, only when it is not set already |
| `~/.local/bin/block-attribution` | The executable (`BLOCK_ATTRIBUTION_BIN_DIR` changes the directory). The installer warns when the directory is not in `PATH`; the hooks call it by full path, so they work either way |
| `~/.config/block-attribution/` | Git hooks, saved answers, an install record and backups of every file it edited |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` are respected.

## How it blocks attribution

- **Agent hooks, before a command runs.** `git commit`, `git push`, `gh pr create/edit` and GitHub MCP tools are checked, including message files passed with `-F` or `--body-file`. `--no-verify` and `-c core.hooksPath=…` are refused, because they would skip the git hooks.
- **Git hooks.** `commit-msg` rejects the message and `pre-push` rejects commits that would be pushed. They also run each repository's own `.git/hooks`, which a global `core.hooksPath` would otherwise skip.
- **Agent hooks, when the agent finishes.** Unpushed commits from the last 12 hours and the current branch's open pull request are checked, and the agent is asked to fix them.

The full list of patterns is in [src/rules.ts](src/rules.ts). Add your own regular expressions in `~/.config/block-attribution/config.json`:

```json
{ "extraPatterns": ["assisted-by:"] }
```

## Limits

- Codex attribution is an account setting on OpenAI's side. No config file turns it off, but the hooks block it.
- Repositories with their own `core.hooksPath` (husky, lefthook) don't run the global git hooks. The agent hooks still apply.
- Claude Code cloud sessions (claude.ai/code) don't read your local settings.
- Pull requests edited in the GitHub web interface are not checked.

[docs/verification.md](docs/verification.md) lists how each agent behaves and how it was checked.

## Development

```bash
bun install
bun run check         # typecheck, tests, install.sh syntax
bun run build:binary  # release/block-attribution for this machine
./release/block-attribution install --dry-run
```

Pushing a `v*` tag builds the macOS and Linux executables with checksums and publishes a GitHub release.
