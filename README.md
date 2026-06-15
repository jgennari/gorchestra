# Gorchestra

<p align="center">
  <strong>The control room for long-running AI coding agents.</strong>
</p>

<p align="center">
  Launch sessions. Stream every event. Inspect diffs. Edit files. Recover the full story from SQLite.
</p>

<p align="center">
  <img alt="Go runtime" src="https://img.shields.io/badge/runtime-Go-00ADD8?style=for-the-badge&logo=go&logoColor=white" />
  <img alt="React UI" src="https://img.shields.io/badge/ui-React-149ECA?style=for-the-badge&logo=react&logoColor=white" />
  <img alt="SQLite persistence" src="https://img.shields.io/badge/storage-SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white" />
  <img alt="SSE streaming" src="https://img.shields.io/badge/streaming-SSE-111827?style=for-the-badge" />
  <img alt="Codex adapter" src="https://img.shields.io/badge/agent-Codex-111827?style=for-the-badge" />
</p>

> Agents perform work. Gorchestra conducts the performance.

Gorchestra gives coding agents a durable runtime: a local Go server, a React command center, a SQLite-backed event log, workspace-aware file tools, and enough visibility to see what actually happened during a long autonomous run.

> [!NOTE]
> Screenshot slot: main session view with live transcript, activity rail, file explorer, and prompt composer.

## The Runtime At A Glance

| Run | Watch | Inspect | Remember |
| --- | --- | --- | --- |
| Launch Codex sessions from a local Go server. | Stream events, thinking, tool calls, and diffs live. | Browse, search, preview, and edit files in-session. | Store sessions and ordered events in SQLite. |
| Tune model, reasoning, service tier, and execution mode. | Reconnect with replay instead of losing context. | Jump from file-change diffs straight into Monaco. | Recover refreshes, restarts, and historical runs. |

## Why It Exists

Coding agents are useful, but long runs are hard to follow when all you have is a chat window. Gorchestra gives each run a local control room: start a session, watch what the agent is doing, inspect file changes, and keep the full history after refreshes or restarts.

It is built for getting work done locally:

- Pick a workspace and start Codex.
- Watch messages, thinking, tool calls, logs, errors, and file edits as they happen.
- Open changed files, review diffs, and edit Markdown or text without leaving the app.
- Come back later and see the same ordered session history.

## Quick Tour

Start a session, choose a workspace, and let the agent run. Gorchestra keeps the live transcript, workspace tools, and session controls together so you do not have to bounce between terminal tabs, editor windows, and logs.

- Tune Codex options like model, reasoning effort, service tier, planning mode, and dangerous mode.
- Follow messages, thinking, tool calls, command output, file edits, errors, and debug events in one transcript.
- Keep typing while a run is active, attach images, and answer agent-requested prompts when a run needs input.
- Browse, search, preview, and edit workspace files from the side rail.
- Review file-change diffs and jump straight into the editor for the changed file.
- Refresh or reconnect without losing the session history.

> [!TIP]
> Screenshot slot: file-change diff with the floating file-editor action and Monaco editor overlay.

## Install

Gorchestra is meant to run as one local binary with the React UI embedded inside it.

### Homebrew

```sh
brew install jgennari/tap/gorchestra
gorchestra --open
```

The published tap is `jgennari/homebrew-tap`; the formula builds Gorchestra from the tagged source archive with Go and installs the `gorchestra` binary.

### Direct Download

Download the archive for your platform from GitHub Releases, unpack it, and run the binary.

macOS and Linux:

```sh
tar -xzf gorchestra_<version>_<os>_<arch>.tar.gz
./gorchestra --open
```

Windows:

```powershell
Expand-Archive .\gorchestra_<version>_windows_<arch>.zip -DestinationPath .\gorchestra
.\gorchestra\gorchestra.exe --open
```

Release targets:

- `darwin/arm64`
- `darwin/amd64`
- `linux/amd64`
- `linux/arm64`
- `windows/amd64`
- `windows/arm64`

Real Codex sessions require the Codex CLI to be available on `PATH`, or configured with `--codex-bin`.

## Use

Start Gorchestra and open the browser:

```sh
gorchestra --open
```

By default, Gorchestra binds to `127.0.0.1:8080` and stores SQLite data in the OS app data location.

Common options:

```sh
gorchestra --host 127.0.0.1 --port 8081
gorchestra --data-dir ~/.gorchestra-dev
gorchestra --workspace /path/to/repo
gorchestra --workspace-root /path/to/allowed/root
gorchestra --codex-bin /path/to/codex
gorchestra --codex-model gpt-5
gorchestra --codex-sandbox workspace-write
gorchestra --codex-network-access=false
gorchestra --codex-web-search=cached
gorchestra --version
```

`--data-dir` creates the directory if needed and stores SQLite at `<data-dir>/gorchestra.db`. `--db` is still available as an exact SQLite path override and takes precedence over `--data-dir`.

Default data paths:

```txt
macOS: ~/Library/Application Support/Gorchestra/gorchestra.db
Linux: $XDG_DATA_HOME/gorchestra/gorchestra.db
Linux fallback: ~/.local/share/gorchestra/gorchestra.db
```

Environment equivalents include `GORCHESTRA_HOST`, `GORCHESTRA_PORT`, `GORCHESTRA_DATA_DIR`, `GORCHESTRA_DB`, `GORCHESTRA_WORKSPACE`, `GORCHESTRA_OPEN`, and the `GORCHESTRA_CODEX_*` variables matching the Codex flags.

Remove local app data:

```sh
rm -rf "$HOME/Library/Application Support/Gorchestra"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/gorchestra"
```

Codex shell commands run with network access enabled by default. Codex native web search runs in live mode by default; use `--codex-web-search=cached` or `--codex-web-search=disabled` to change it.

## Build From Source

Prerequisites:

- Go 1.23 or newer
- Bun 1.3 or newer

Build the release binary with embedded frontend assets:

```sh
bun run build
```

This installs frontend dependencies with Bun, builds the Vite app, stages `web/dist` into `internal/webassets/dist`, runs `go test ./...`, builds `dist/gorchestra`, and writes `dist/SHA256SUMS`.

Run the source-built binary:

```sh
./dist/gorchestra --open
```

Staged assets under `internal/webassets/dist` are committed so `go test ./...` and `go build ./cmd/app` work from a checkout. `bun run build` refreshes that directory from the latest Vite output before compiling the release binary.

## Tests

Backend:

```sh
go test ./...
```

Frontend:

```sh
cd web
bun run test
bun run build
```

Production:

```sh
bun run build
./dist/gorchestra --version
```

`dist/SHA256SUMS` contains SHA-256 checksums for local release artifacts.

## Project Trail

- [Roadmap](docs/roadmap.md) - target architecture, milestones, API shape, event model, and build order.
- [Sprint 1](docs/sprint-1.md) - project skeleton checklist and completion criteria.
- [Sprint 2](docs/sprint-2.md) - SQLite session and event store checklist and completion criteria.
- [Sprint 3](docs/sprint-3.md) - internal event pipeline checklist and completion criteria.
- [Sprint 4](docs/sprint-4.md) through [Sprint 10](docs/sprint-10.md) - follow-on implementation notes.
