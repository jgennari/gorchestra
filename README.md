# Gorchestra

Gorchestra is a self-contained AI coding agent orchestration platform built in Go.

Its purpose is to coordinate, monitor, and persist long-running coding agent sessions while providing real-time visibility into everything the agents are doing.

> Agents perform work. Gorchestra conducts the performance.

## Vision

Modern coding agents are increasingly capable of working independently for extended periods of time. As more agents become available, developers need a single orchestration layer that can:

- Launch and manage agent sessions
- Stream progress in real time
- Persist all activity
- Recover seamlessly from disconnects
- Support multiple agent providers
- Remain deployable as a single lightweight application

Gorchestra is the conductor coordinating a collection of autonomous workers.

## Core Architecture

Gorchestra is planned as:

- Go backend orchestration engine
- React frontend
- SQLite persistence layer
- In-memory event streaming system
- Pluggable agent adapter framework
- Codex as the initial supported agent

The application should be packaged as a single executable with embedded frontend assets.

## Design Principles

### Event-Driven Foundation

Everything in Gorchestra is represented as an event:

- User prompts
- Agent responses
- Tool invocations
- Command execution
- File modifications
- Status changes
- Errors
- Completion notifications

Events are streamed live and persisted durably. The event stream is the canonical representation of a session.

### Server-Owned State

The backend is the source of truth. The frontend maintains only temporary UI state and rendering concerns.

Session reconstruction, replay, recovery, and synchronization are all driven from the server.

### Replayable Sessions

Every event within a session receives a monotonically increasing sequence number.

Clients track the highest sequence number they have received. If a connection is interrupted:

1. The client reconnects.
2. The client sends its last known sequence number.
3. Gorchestra replays all missing events.
4. Live streaming resumes.

This guarantees lossless recovery while keeping synchronization logic simple.

### Real-Time First

Users should see work as it happens. Agent output is streamed incrementally rather than withheld until completion.

The experience should feel closer to observing a live terminal session than interacting with a traditional chat application.

### Transparency Over Magic

Users should be able to see what agents are doing, including current activity, tool calls, command execution, intermediate output, progress updates, errors, and completion state.

Failures should be visible and understandable. Automatic retries are intentionally excluded from the initial design.

## Agent Abstraction

Gorchestra must not become tightly coupled to a single provider. All orchestration logic operates through a common agent interface.

Planned agent implementations include:

- Codex
- Claude
- OpenAI Responses API
- Local agents
- Future providers

Codex will be the first implementation, but the orchestration engine remains provider-agnostic.

## Streaming Model

The initial implementation uses Server-Sent Events.

Requirements:

- Live event delivery
- Automatic reconnection
- Event replay
- Low operational complexity

The architecture should permit migration to WebSockets later without requiring major backend changes.

## Persistence Model

All sessions and events are stored in SQLite.

Events are persisted before being broadcast to connected clients.

Persistence supports:

- Session history
- Event replay
- Session reconstruction
- Future analytics
- Future observability

SQLite is chosen initially for simplicity, portability, and local-first deployment.

## Frontend Goals

The frontend should provide:

- Session management
- Live event viewing
- Session history
- Agent status visualization
- Reconnection handling
- Responsive mobile support

The interface should prioritize visibility into agent activity rather than mimicking a traditional chatbot experience.

## Documentation

- [Roadmap](docs/roadmap.md) - target architecture, milestones, API shape, event model, and build order.
- [Sprint 1](docs/sprint-1.md) - project skeleton checklist and completion criteria.
- [Sprint 2](docs/sprint-2.md) - SQLite session and event store checklist and completion criteria.
- [Sprint 3](docs/sprint-3.md) - internal event pipeline checklist and completion criteria.

## Local Development

Prerequisites:

- Go 1.23 or newer
- Bun 1.3 or newer

Install frontend dependencies:

```sh
cd web
bun install
```

Run the backend and frontend together with hot reload:

```sh
bun run dev
```

This starts:

- Go backend on `http://localhost:8080`
- Vite frontend on `http://127.0.0.1:5173`
- Backend restart on Go source changes
- React HMR through Vite

Set `PORT`, `WEB_PORT`, or `GORCHESTRA_DB` to override the default ports and development database path.

Run the same development stack for tailnet access:

```sh
bun run dev:tailnet
```

Tailnet mode binds Vite to `0.0.0.0` while keeping API requests proxied to the local Go backend. From another tailnet machine, open:

```txt
http://<tailscale-ip>:5173
```

The script prints the detected Tailscale IPv4 address when `tailscale` is available. For MagicDNS hostnames, allow the hostname explicitly:

```sh
VITE_ALLOWED_HOSTS=your-machine.your-tailnet.ts.net bun run dev:tailnet
```

Run a persistent human dev server in tmux:

```sh
bun run dev:human
```

This starts the tailnet dev stack in a `gorchestra-human` tmux session with stable defaults:

- Backend: `http://localhost:18080`
- Frontend: `http://127.0.0.1:15173`
- Database: `.tmp/human/sessions.db`

Useful commands:

```sh
bun run dev:human:status
bun run dev:human:logs
bun run dev:human:attach
bun run dev:human:restart
bun run dev:human:reset
bun run dev:human:stop
```

Override defaults with `GORCHESTRA_HUMAN_PORT`, `GORCHESTRA_HUMAN_WEB_PORT`, `GORCHESTRA_HUMAN_DB`, or `GORCHESTRA_HUMAN_TMUX`.

Backend:

```sh
go run ./cmd/app
```

The backend listens on port `8080` and uses `./sessions.db` by default. Set `PORT` or pass `--db` to override them:

```sh
PORT=8081 go run ./cmd/app --db .tmp/sessions.db
```

Codex shell commands run with network access enabled by default. Use `--codex-network-access=false` to disable command-line network access for Codex turns. Codex native web search runs in live mode by default; use `--codex-web-search=cached` or `--codex-web-search=disabled` to change it.

Health check:

```sh
curl http://localhost:8080/api/health
```

Backend tests:

```sh
go test ./...
```

Frontend:

```sh
cd web
bun dev
```

The Vite dev server proxies `/api` requests to `http://localhost:8080`.

Frontend build:

```sh
cd web
bun run build
```

## Initial Success Criteria

The first version of Gorchestra is successful when:

1. A user can create a session.
2. A prompt can be submitted.
3. Codex can execute work.
4. Events stream live to connected browsers.
5. Events are persisted to SQLite.
6. Browser refreshes and reconnects recover automatically.
7. Session history survives application restarts.
8. The system remains deployable as a single executable.

## Status

Sprint 1 project skeleton is scaffolded with a Go backend health endpoint and a Vite React frontend service monitor.
