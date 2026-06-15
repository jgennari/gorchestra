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

Gorchestra coordinates coding agents from a local Go server and stores every important thing they do as ordered events in SQLite. The browser connects to that event stream, replays anything it missed, and renders a live operational view of the session.

The result is a runtime where you can:

- Start agent sessions against specific workspaces.
- Watch messages, tool calls, file edits, logs, status changes, and errors as they happen.
- Reconnect or refresh without losing session history.
- Inspect and edit files in the same UI where the agent is working.
- Keep provider-specific behavior behind adapters instead of coupling the platform to one CLI.

## Runtime Tour

### Launch And Control Sessions

- Create sessions with a title, agent type, and workspace directory.
- Browse allowed workspace roots during session creation.
- See session status, event counts, tool counts, latest activity, and stream state at a glance.
- Rename sessions inline and archive completed sessions.
- Cancel running work when a session needs to stop.
- Recover interrupted runs after server restart by marking them failed with a visible event trail.

### Stream The Work

The event stream is the source of truth. Gorchestra persists events before broadcasting them, assigns each event a monotonically increasing sequence number, and uses Server-Sent Events for live delivery.

- Replays missed events after reconnect using `after_seq`.
- Supports historical reads by `after_seq`, `before_seq`, or tail queries.
- Sends stream heartbeats to keep live connections healthy.
- Groups raw events into readable transcript rows for messages, thinking, tool calls, file changes, logs, and provider debug output.
- Includes a debug mode for inspecting provider and internal events directly.

### Codex, But Not Codex-Locked

Codex is the first real adapter, with a fake agent available for development and tests.

- Continue Codex threads across prompts through persisted provider session IDs.
- Select Codex model, reasoning effort, service tier, fast mode, and planning mode per prompt.
- Configure Codex shell network access and native web search mode from binary flags.
- Start a Codex session with `run_dangerously` when you intentionally want no approval prompts and no sandbox restrictions.
- Keep core orchestration provider-agnostic through a shared agent interface.

### Transcript Built For Real Work

The transcript is built for watching work unfold, not just reading chat bubbles.

- Streams assistant messages and thinking state live.
- Collapses tool calls under assistant activity with expandable details.
- Shows command output, aggregated Codex tool output, errors, and debug payloads.
- Renders file-change events as readable labels with unified diff highlighting when patches are available.
- Provides copy buttons for code blocks and tool output.
- Adds a `Show in File Editor` action on file-change diffs so edited files can be opened directly in the middle pane.

> [!TIP]
> Screenshot slot: file-change diff with the floating file-editor action and Monaco editor overlay.

### Workspace, Diffs, And Editor

Gorchestra treats the session workspace as part of the runtime, not a side panel bolted onto chat.

- Browse session files from the activity rail.
- Search within the session workspace.
- Show git status markers next to file entries.
- Preview text and Markdown files in the middle pane.
- Edit UTF-8 files with Monaco and save changes back to disk.
- Keep binary or oversized files read-only.
- Open changed files from agent file-change diffs without hunting through the explorer.

### Prompting That Keeps Up

- Prompt drafts are stored per session in local browser storage.
- Press `Enter` to submit and `Ctrl+Enter` for a newline.
- Attach up to eight images, 5 MB each, by file picker or drag and drop.
- Keep typing the next message while a run is active.
- Answer agent-requested user input with structured controls when a provider pauses for a decision.
- Toggle debug events from the composer when deeper inspection is needed.

### Run Health At A Glance

The right rail summarizes the current run:

- Live connection state.
- Current activity metrics.
- Latest event label and timestamp.
- Token usage when the provider reports it.
- Workspace file browser and archive action.

The main message window uses a minimal scrollbar that stays out of the way until scrolling, and the panes can be resized for longer monitoring sessions.

## Install

Gorchestra is meant to run as one local binary with the React UI embedded inside it.

### Homebrew

```sh
brew install jgennari/tap/gorchestra
gorchestra --open
```

Homebrew packaging starts from the formula template in `packaging/homebrew/gorchestra.rb.template`.
The first tap release can copy that template into `jgennari/homebrew-tap` and fill in the release version and source archive checksum.

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

Initial release targets:

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

## Runtime API

The runtime API is intentionally simple and event-oriented:

- `GET /api/health`
- `GET /api/agents/{agentType}/options`
- `GET /api/workspaces/roots`
- `GET /api/workspaces/browse`
- `POST /api/sessions`
- `GET /api/sessions`
- `GET /api/sessions/{sessionId}`
- `PATCH /api/sessions/{sessionId}`
- `POST /api/sessions/{sessionId}/archive`
- `POST /api/sessions/{sessionId}/messages`
- `POST /api/sessions/{sessionId}/cancel`
- `POST /api/sessions/{sessionId}/requests/{requestId}/answer`
- `GET /api/sessions/{sessionId}/events`
- `GET /api/sessions/{sessionId}/events/stream`
- `GET /api/sessions/{sessionId}/files`
- `GET /api/sessions/{sessionId}/files/search`
- `GET /api/sessions/{sessionId}/files/content`
- `PUT /api/sessions/{sessionId}/files/content`

## Under The Hood

Gorchestra is split into a small Go runtime and a React operational UI.

Backend:

- `internal/store` manages SQLite sessions, events, migrations, provider session IDs, workspace paths, and session agent options.
- `internal/events` appends durable events and broadcasts live subscribers.
- `internal/session` tracks active runs, cancellation, and pending user-input requests.
- `internal/agents` defines the provider interface, with Codex and fake adapters.
- `internal/httpapi` exposes sessions, streaming, workspace browsing, file content, and agent options.
- `cmd/app` wires the runtime, CLI flags, startup recovery, and HTTP server.

Frontend:

- React and Vite power the single-page UI.
- The app derives display state from server sessions and events.
- The transcript groups raw events into messages, thinking, tool calls, file changes, logs, and debug rows.
- The workspace overlay renders Markdown, previews text, and edits files with Monaco.
- The activity rail combines session metrics, token usage, archive controls, and file browsing.

Packaging direction:

- Production builds produce a single lightweight executable with embedded frontend assets.
- The development loop still runs Go and Vite side by side for fast iteration.

Release/Homebrew shape:

- Local artifact: `dist/gorchestra`
- Checksums: `dist/SHA256SUMS`
- Release artifact naming: `gorchestra_<version>_<os>_<arch>.tar.gz` for macOS/Linux and `gorchestra_<version>_windows_<arch>.zip` for Windows
- Supported release targets: `darwin/arm64`, `darwin/amd64`, `linux/amd64`, `linux/arm64`, `windows/amd64`, and `windows/arm64`
- Release workflow: `.github/workflows/release.yml` publishes archives when a `v*.*.*` tag is pushed.
- Expected install command: `brew install jgennari/tap/gorchestra`
- Optional service command: `brew services start gorchestra`

Homebrew formula requirements:

- Download the versioned source archive from GitHub Releases.
- Verify the SHA-256 checksum.
- Build and install the `gorchestra` binary into `bin`.
- Include an optional service stanza that runs `gorchestra` with a persistent data directory.

More release and Homebrew notes live in [Distribution](docs/distribution.md).

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
