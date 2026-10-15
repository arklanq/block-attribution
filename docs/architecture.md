# Architecture

Bun/TypeScript CLI compiled into standalone macOS/Linux binaries. User setup, file locations and coverage are in the [README](../README.md); external assumptions are recorded in [verification](verification.md).

## Code map

| Responsibility | Source |
| :- | :- |
| Commands and installation wizard. | [cli.ts](../src/cli.ts). |
| Shared attribution rules; shell/MCP inspection. | [rules.ts](../src/rules.ts), [command.ts](../src/command.ts). |
| Agent hooks; commit and PR checks. | [hook.ts](../src/hook.ts), [checks.ts](../src/checks.ts). |
| Git hook scripts and repository-hook forwarding. | [git-hooks.ts](../src/git-hooks.ts). |
| Install/uninstall plans, backups and atomic writes. | [plan.ts](../src/install/plan.ts), [operations.ts](../src/install/operations.ts). |
| Codex hook trust hashes and keys. | [codex-trust.ts](../src/install/codex-trust.ts). |

## Invariants

- Hooks reject attribution with an explanation; they never rewrite text. Human co-authors remain allowed.
- Global Git hooks require a wizard choice, recommended on; non-interactive runs use flags, saved preference, then the default. Existing global hooks directories are not replaced.
- Config edits preserve unrelated values and formatting, back up changed files and reject invalid input. `--dry-run` previews the same operation plan without applying it.
- Agent hooks are appended to preserve Codex trust indexes. Trust hashes use normalized, key-sorted JSON; keep compatibility covered by [tests](../tests/codex-trust.test.ts).
- `manifest.json` records prior settings for uninstall. Preserve subsequent user edits when restoring values.
- Claude's attribution sub-keys support older versions; built-in Git safety instructions stay enabled.
- Codex agent hooks are installed independently of global Git hooks. The final note reflects the global-hook choice and must not invent a UI switch for server-controlled attribution.
