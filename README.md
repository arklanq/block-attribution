# Block Attribution

Block Attribution keeps AI attribution out of your git commits and pull requests: `Co-authored-by` trailers, "Generated with Claude Code / Codex" lines and agent session links.

It configures Claude Code and Codex (CLI and desktop apps) not to add attribution, and installs hooks that reject a commit or pull request that still contains it, with a message that tells the agent what to remove.

Status: in design. See [docs/architecture.md](docs/architecture.md) for the plan and [docs/verification.md](docs/verification.md) for the verified behaviour of each agent.
