# Gorchestra Agent Instructions

Gorchestra is a self-contained AI coding agent orchestration platform built in Go.
Its guiding principle is: agents perform work; Gorchestra conducts the performance.

## Project Direction

- Build a Go backend orchestration engine with a React frontend.
- Persist sessions and events in SQLite.
- Stream live session activity to clients, initially with Server-Sent Events.
- Package the application as a single executable with embedded frontend assets.
- Keep orchestration provider-agnostic. Codex is the first adapter, not a special case in core orchestration logic.

## Core Architecture Rules

- Treat the event stream as the canonical representation of a session.
- Persist events before broadcasting them to connected clients.
- Assign every event in a session a monotonically increasing sequence number.
- Reconstruct sessions from persisted server-owned state, not frontend state.
- Support reconnect recovery by replaying events after the client's last known sequence number.
- Keep live streaming and replay behavior behind an internal abstraction so SSE can be replaced or supplemented later.
- Make agent adapters implement a shared interface. Core session orchestration should not depend on provider-specific details.

## Implementation Expectations

- Prefer simple, explicit Go code over premature abstractions.
- Keep package boundaries aligned with the architecture: orchestration, persistence, streaming, adapters, HTTP API, and frontend assets.
- Use structured event types rather than ad hoc strings for persisted session activity.
- Keep frontend state temporary and derived from server data wherever possible.
- Add tests around event sequencing, persistence-before-broadcast behavior, replay, and adapter boundaries.
- Avoid automatic retries in the initial implementation unless explicitly requested. Failures should be visible and understandable.

## Frontend Expectations

- Prioritize real-time visibility into agent work over chatbot-style interaction.
- Show current activity, tool calls, command output, intermediate progress, errors, and completion state.
- Handle refreshes and reconnects without losing session history.
- Keep the UI responsive on mobile.
- Design operational screens for scanning and monitoring long-running work.

## Local Human Testing

- The canonical persistent human-test stack is the macOS LaunchAgent `com.joey.gorchestra-human`.
- The LaunchAgent runs one `dev:tailnet` stack: Vite listens on `0.0.0.0:15173` and is reachable locally at `127.0.0.1:15173`, the Go API listens on `127.0.0.1:18080`, and SQLite lives at `.tmp/human/sessions.db`.
- Local URL: `http://127.0.0.1:15173`.
- Tailnet development URL: `https://gorchestra-dev.coin-triceratops.ts.net`. A tagged `tsnet` sidecar forwards the frontend to `127.0.0.1:15173` and `/api/*` directly to `127.0.0.1:18080`.
- Tailnet built-frontend URL: `https://gorchestra.coin-triceratops.ts.net`. The same sidecar forwards all traffic to `127.0.0.1:18080`, where the Go process serves its embedded frontend assets.
- The sidecar is the LaunchAgent `com.joey.gorchestra-tailscale-sidecar`. Manage it with `bun run tailscale:sidecar`, `bun run tailscale:sidecar:logs`, `bun run tailscale:sidecar:restart`, and the other `tailscale:sidecar:*` scripts. See `docs/tailscale-services.md`.
- The legacy `http://gorchestra.dev.gennari.industries` `devproxy` route may remain temporarily during migration; it points at this same human stack and is not a second server.
- Development normally happens against this already-running LaunchAgent stack. Assume backend source changes will rebuild automatically and frontend changes will arrive through Vite HMR; do not start or restart a server merely to pick up edits.
- Frontend source edits do not automatically update the built-frontend URL. Only when the user explicitly asks to promote or reload production, run `bun run prod:refresh`. It builds and stages the embedded frontend, signals the existing backend watcher, and defers the backend rebuild until active sessions finish. Do not manually restart the human stack to promote frontend assets.
- Before starting a server, run `bun run dev:human:status`. If it is healthy, use the existing stack.
- Manage the persistent stack with `bun run dev:human`, `bun run dev:human:status`, `bun run dev:human:logs`, `bun run dev:human:follow`, `bun run dev:human:restart`, and `bun run dev:human:stop`.
- Before any restart, run `bun run dev:human:status` and check `http://127.0.0.1:18080/api/sessions?status=running&limit=1` for active sessions. `dev:human:restart` interrupts those runs, so defer the restart unless the user explicitly asks or the server cannot recover.
- Never point a second backend at `.tmp/human/sessions.db`. The dev runner rejects that database outside the human LaunchAgent because startup recovery from a second process can corrupt live run status.
- For isolated agent testing, use different ports and a different database, for example `PORT=18180 WEB_PORT=15273 GORCHESTRA_DB=.tmp/agent-test/sessions.db bun run dev`. Keep isolated servers bound to localhost unless tailnet access is explicitly required.
- Validate the persistent stack with `bun run dev:human:status` and the sidecar with `bun run tailscale:sidecar`. During migration, the legacy route can also be checked with `devproxy check gorchestra`.

## Repository Notes

- This repository is in initial setup. Do not assume implementation directories exist until they are created.
- When a Go module exists, run `go test ./...` before finishing backend changes.
- When a frontend package exists, run the relevant package manager's test and build commands before finishing frontend changes.
- For release packaging, tagging, and Homebrew tap details, use `docs/distribution.md` as the source of truth.
- Keep generated artifacts, local databases, build output, and dependency directories out of git.
