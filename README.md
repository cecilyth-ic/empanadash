# empanadash

A customized fork of [emdash](https://github.com/generalaction/emdash) — a cross-platform Electron app that orchestrates multiple CLI coding agents (Claude Code, Codex, Amp, etc.) in parallel, each isolated in their own Git worktree. 
## Download

Pre-built releases for macOS, Linux, and Windows are available on the [releases page](https://github.com/cecilyth-ic/empanadash/releases/latest).

## Customizations

### Agent Teams

Agents can spawn teammate tabs using Claude's `Agent` tool. When an agent calls `Agent` with `run_in_background: true`, empanadash intercepts the event via a PostToolUse hook and opens a new conversation tab — automatically attaching to the spawned agent's tmux session. This lets a single task fan out into a live multi-agent team, all visible in the UI.

### Improved Remote Project Stability

Upstream's SSH remote project support could freeze the UI when multiple remote projects were configured, because each sidebar item ran its own independent polling loop. empanadash fixes this with:

- **Batched state polling** — a single shared poller fetches all connection states in one IPC call, replacing N independent polling loops with one
- **Lightweight sidebar cache** — sidebar items subscribe to the shared cache instead of each running their own polling hook, so adding more remote projects doesn't add more pollers
- **Circuit breaker** — after 3 consecutive SSH failures, operations are rejected for 30s to prevent cascade failures
- **Per-operation timeouts** — individual timeouts for commands (30s), SFTP (10s), and worktree creation (60s) instead of hanging indefinitely
- **Stale branch cleanup** — worktree creation detects and cleans up leftover branches before retrying
