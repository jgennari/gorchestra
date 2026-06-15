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

## Repository Notes

- This repository is in initial setup. Do not assume implementation directories exist until they are created.
- When a Go module exists, run `go test ./...` before finishing backend changes.
- When a frontend package exists, run the relevant package manager's test and build commands before finishing frontend changes.
- For release packaging, tagging, and Homebrew tap details, use `docs/distribution.md` as the source of truth.
- Keep generated artifacts, local databases, build output, and dependency directories out of git.
