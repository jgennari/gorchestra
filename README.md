# Threave

**Bring your coding agents together.** Give each task the right agent, model, and thinking depth. Follow their work live, collect the results, and carry the same sessions from your desk to your phone.

[Website](https://threave.io) · [Install](https://threave.io/get/) · [Mobile access](https://threave.io/mobile/) · [Releases](https://github.com/threave-io/threave/releases)

Threave is a self-hosted orchestration service for Codex, Claude, OpenCode, and Pi. A parent session can delegate work to child sessions, including across providers. Each child has its own durable run and report, while the work remains linked in the UI. You can tune models, reasoning levels, fast mode, and planning mode per run. The event stream records messages, tool calls, output, errors, and completion in SQLite, so reconnecting does not erase the story.

## What you can do

- Split a project into concurrent, focused agent sessions and monitor each run.
- Mix supported providers, models, and thinking levels according to the task.
- Watch tool calls and output as they happen; fetch durable reports when work completes.
- Queue follow-ups, answer requests, inspect file changes, and browse the workspace.
- Reconnect on desktop or install the PWA on your phone through a private Tailscale connection.

Threave runs on your machine. It does not host your agents or sync your sessions to a third-party cloud. Mobile access connects back to your running service; see [the private access guide](https://threave.io/mobile/).

## Install

On macOS with Homebrew:

```sh
brew install threave-io/tap/threave
threave serve --open
```

For a background service:

```sh
brew services start threave-io/tap/threave
open http://127.0.0.1:15173
```

The service reads `$(brew --prefix)/etc/threave/threave.env`. Edit it and restart the service to change the port, data directory, workspace roots, or provider binaries.

On macOS, Linux, or Windows, download the matching archive from [GitHub Releases](https://github.com/threave-io/threave/releases/latest). Archives contain the `threave` executable with the frontend embedded. For example:

```sh
tar -xzf threave_<version>_<os>_<arch>.tar.gz
./threave serve --open
```

Install and configure at least one supported provider CLI: Codex, Claude, OpenCode, or Pi. Threave detects providers available on `PATH`, and each provider can also be set with a `--*-bin` flag.

Running `threave` with no arguments prints offline help. Use `threave commands --json` for a machine-readable command catalog.

## Delegate a task

The browser presents parent and child sessions together. Agents running inside Threave also receive a short bootstrap with their session ID and a path to the control binary. A typical delegated run looks like this:

```sh
threave run --agent codex --title "Dependency audit" \
  --prompt-file task.md --detach --json
threave runs wait RUN_ID --timeout 10m --json
threave runs report RUN_ID --json
```

Inside a managed run, omit `--agent`, `--parent`, and `--cwd` to inherit the provider and workspace and attach the new session as a child. Override the model or thinking level where supported:

```sh
"$THREAVE_BIN" run --title "Review the API" --model MODEL_ID \
  --thinking high --prompt-file review.md --detach --json
```

Use `runs watch` to stream events, `sessions send` to queue or steer a follow-up, and `search` to find sessions, durable history, and workspace files. `threave help` and `threave commands --json` enumerate the complete contract.

## Configuration and existing Gorchestra installs

The rename preserves existing installations. The new binary accepts both `THREAVE_*` and `GORCHESTRA_*` environment variables; new names take precedence. It looks for existing Gorchestra data directories and `gorchestra.db` before creating new Threave data, and it accepts both `.threave/host.yaml` and `.gorchestra/host.yaml` preview recipes. The release archives include a `gorchestra` executable alias, and the Homebrew formula keeps the old command available. Browser storage keys remain compatible with previously installed PWAs.

The default local address is `http://127.0.0.1:8080`. A typical service configuration is:

```text
THREAVE_HOST=127.0.0.1
THREAVE_PORT=15173
THREAVE_DATA_DIR=/path/to/data
THREAVE_WORKSPACE=~
THREAVE_WORKSPACE_ROOTS=~
THREAVE_OPEN=false
```

`--data-dir` stores SQLite at `<data-dir>/threave.db` for a new install. `--db` selects an exact SQLite path. Keep your old database and config in place while upgrading; the new service reads them without a destructive migration.

**Private mobile access:** expose the local service only to your Tailscale tailnet with Tailscale Serve, then add the HTTPS page to your phone's home screen. Do not expose the unauthenticated Threave API to the public internet. Follow the [mobile guide](https://threave.io/mobile/) for setup and verification.

## Build from source

Prerequisites: Go 1.23+ and Bun 1.3+.

```sh
bun run build
./dist/threave serve --open
```

The build compiles the React frontend, stages it in `internal/webassets/dist`, runs backend tests, and produces a single binary. To run checks separately:

```sh
go test ./...
cd web && bun run test && bun run build
```

The architecture keeps orchestration provider-agnostic: provider adapters implement a shared interface, server-owned events are persisted before broadcast, and reconnecting clients replay ordered events from SQLite. See [distribution](docs/distribution.md) for release packaging and [hosted previews](docs/hosted-previews.md) for workspace development stacks.
