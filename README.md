# empanadash

A customized fork of [emdash](https://github.com/generalaction/emdash) — a cross-platform Electron app that orchestrates multiple CLI coding agents (Claude Code, Codex, Amp, etc.) in parallel, each isolated in their own Git worktree. 
## Download

Pre-built releases for macOS, Linux, and Windows are available on the [releases page](https://github.com/cecilyth-ic/empanadash/releases/latest).

## Customizations

### Agent Teams

Agents can spawn teammate tabs using Claude's `Agent` tool. When an agent calls `Agent` with `run_in_background: true`, empanadash intercepts the event via a PostToolUse hook and opens a new conversation tab — automatically attaching to the spawned agent's tmux session. This lets a single task fan out into a live multi-agent team, all visible in the UI.
