# Block Attribution

Blocks AI attribution in Git commits and pull requests: AI co-author trailers, generated-by footers, session links and Claude Projects markers. Human co-authors remain allowed.

## Install

For macOS and Linux, with Claude Code and Codex. Windows is not supported in v1.

```bash
curl -fsSL https://raw.githubusercontent.com/arklanq/block-attribution/main/install.sh | bash
```

The installer verifies the release checksum, asks which detected agents to configure and recommends optional global Git hooks. Start a new agent session afterwards. For other agents or installation problems, see [manual installation](MANUAL_INSTALLATION.md).

To preview changes, append `-s -- --dry-run` after `bash`. For unattended installation, use `-s -- --yes`; available flags include `--skip-claude`, `--skip-codex` and `--no-git-hooks`. Flags override saved Git-hook preferences, then defaults.

```bash
block-attribution status
block-attribution check       # Check this repository.
block-attribution uninstall
```

## Configuration

| Location | Changes |
| :- | :- |
| `~/.claude/settings.json` | Disables built-in attribution; adds `PreToolUse` and `Stop` hooks. |
| `~/.codex/hooks.json`, `~/.codex/config.toml` | Appends agent hooks, enables them and records their trust. |
| Global Git config | Sets `core.hooksPath` only when enabled and no other global hooks directory is configured. |
| `~/.local/bin/block-attribution` | Executable; hooks use its absolute path, so they work without this directory in `PATH`. |
| `~/.config/block-attribution/` | Git hooks, saved answers, uninstall manifest and config backups. |

Overrides: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `BLOCK_ATTRIBUTION_BIN_DIR` and `XDG_CONFIG_HOME`.

To extend the [built-in rules](src/rules.ts), merge this into `~/.config/block-attribution/config.json`:

```json
{ "extraPatterns": ["assisted-by:"] }
```

## Coverage and limits

- Agent hooks check Git and GitHub CLI/MCP calls, including message files, and reject hook-bypass flags. Global `commit-msg` and `pre-push` hooks check commits and preserve repository hooks.
- At turn end, `Stop` checks up to 50 unpushed commits from the last 12 hours and the branch's open PR. `check` runs the same checks; PR inspection requires authenticated `gh` access.
- Codex attribution follows OpenAI's server policy; local settings cannot disable it. Enabled hooks should block it in supported workflows. Codex desktop hook execution remains unverified.
- Repository-local `core.hooksPath` overrides global hooks. Commands outside agent hooks can bypass Git hooks. Indirect commands may evade agent checks.
- Local hooks do not cover cloud sessions, GitHub web edits or later server additions. `commit-tree` snapshots are checked only if pushed.

## Development

```bash
bun install
bun run check         # Types, tests and installer syntax.
bun run build:binary  # release/block-attribution for this machine.
./release/block-attribution install --dry-run
```

A `v*` tag publishes macOS/Linux binaries and checksums. See [architecture](docs/architecture.md) and [verification evidence](docs/verification.md).
