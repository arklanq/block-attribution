# Verification

Historical checks from 2026-10-13–15 on macOS: Claude Code 2.1.296, Codex CLI 0.162.1 and Codex desktop 26.1007.30912. Attribution policy was rechecked on desktop 26.1007.71326 (build 20398). These observations do not establish support for future versions.

## Observed tests

- Claude Desktop blocked attributed commit messages (`-m`, heredoc and `-F`), hook bypasses and attributed PR bodies; a clean commit passed.
- Codex CLI blocked an attributed commit and the agent retried cleanly. `app-server hooks/list` accepted installer-generated trust entries.
- Global Git hooks rejected attributed commits and pushes while forwarding repository hooks. Repository-local `core.hooksPath` and `--no-verify` bypassed global checks as expected.
- Codex desktop agent-hook execution remains **unverified**. Restart agents after uninstalling; a running Claude session retained deleted project hooks.

## Compatibility sources

- Claude [attribution settings](https://code.claude.com/docs/en/settings-reference#attribution) and [hooks](https://code.claude.com/docs/en/hooks): empty commit/PR strings and `sessionUrl: false` disable built-in attribution. The installer uses sub-keys for versions predating `attribution: false`.
- Codex findings below refer to [commit 092d3acd](https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d), tag `rust-v0.162.1`; paths are relative to `codex-rs/`.
- Attribution is [server-computed policy](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/backend-client/src/types.rs#L83-L90), covering [commits and PRs](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/ext/git-attribution/src/world_state.rs#L17-L27). No local CLI setting disables it. CLI/app-server source and desktop bundle searches found no attribution-setting writer or confirmed UI toggle; signed-in settings and backend write support were not verified.
- Hook protocol: `hooks/src/events/pre_tool_use.rs` (exit 2 with nonempty stderr), `hooks/src/events/stop.rs` (`decision: block`, `stop_hook_active`). See [Codex hooks docs](https://learn.chatgpt.com/docs/hooks).
- Trust: `hooks/src/engine/discovery.rs`, `config/src/fingerprint.rs`, `hooks/src/events/common.rs`. Hashes depend on normalized handlers; trust keys include array indexes.
- Desktop bundle inspection found `commit-tree` snapshots with attribution. They bypass commit hooks; `pre-push` can catch them if pushed.

Run `bun run check` for automated checks. [Tests](../tests/) cover detection rules, commands, installation, Codex trust and Git hooks; they do not replace live agent verification. Current coverage limits are in the [README](../README.md#coverage-and-limits).
