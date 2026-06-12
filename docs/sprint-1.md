# Sprint 1: Project Skeleton

Sprint 1 establishes the runnable project skeleton for Gorchestra. This sprint is intentionally limited to setup: Go backend, React/Vite frontend, local development commands, and basic verification.

This project is AI-developed, so Sprint 1 is not tied to a calendar timebox. Work should proceed in checklist order until the completion criteria pass.

## Goal

Make Gorchestra runnable locally as a Go backend plus React frontend skeleton.

The sprint should leave the repository ready for Sprint 2, where persistence, events, and session behavior can be added on top of stable project structure.

## Scope

In scope:

- Initialize the Go module.
- Add the backend entrypoint at `cmd/app/main.go`.
- Use `chi` as the backend HTTP router.
- Add `GET /api/health`.
- Add a Vite + React + TypeScript frontend under `web/`.
- Use Bun for frontend dependency management and scripts.
- Document repeatable local development and build commands.
- Add basic tests or checks for the backend health route.

Out of scope:

- SQLite schema and migrations.
- Session persistence.
- Event persistence.
- Event bus implementation.
- Server-Sent Events streaming.
- Replay from `after_seq`.
- Agent interface.
- Fake/mock agent.
- Codex adapter.
- Cancellation.
- Production frontend asset embedding.

## Decisions

- Go module path: `github.com/jgennari/gorchestra`
- Backend router: `chi`
- Frontend stack: Vite, React, TypeScript
- Frontend package manager/runtime: Bun
- Backend entrypoint: `cmd/app/main.go`
- Initial API endpoint: `GET /api/health`
- Health response: `{"status":"ok"}`

Sprint 1 standardizes frontend development and build commands on Bun.

## Checklist

### Repository And Module

- [x] Initialize `go.mod` with module path `github.com/jgennari/gorchestra`.
- [x] Add initial backend dependencies, including `chi`.
- [x] Keep generated build output and dependency directories out of git.
- [x] Confirm `.gitignore` covers Go binaries, frontend dependencies, frontend build output, local databases, and environment files.

### Backend Skeleton

- [x] Create `cmd/app/main.go`.
- [x] Start an HTTP server with a configurable port.
- [x] Default the port to `8080`.
- [x] Register API routes through `chi`.
- [x] Add `GET /api/health`.
- [x] Return HTTP 200 and JSON body `{"status":"ok"}` from the health endpoint.
- [x] Keep startup logging minimal and useful.

### Backend Verification

- [x] Add a backend test that exercises `GET /api/health`.
- [x] Verify `go test ./...` passes.
- [x] Verify `go run ./cmd/app` starts the server.
- [x] Verify `curl http://localhost:8080/api/health` returns `{"status":"ok"}`.

### Frontend Skeleton

- [x] Create a Vite + React + TypeScript app under `web/`.
- [x] Use Bun-generated lockfiles and scripts.
- [x] Keep the initial UI minimal: show the app name and a simple service status area.
- [x] Avoid implementing session UI in this sprint.
- [x] Verify `cd web && bun install` succeeds.
- [x] Verify `cd web && bun dev` starts the frontend dev server.
- [x] Verify `cd web && bun run build` succeeds.

### Development Workflow

- [x] Document backend startup with `go run ./cmd/app`.
- [x] Document frontend startup with `cd web && bun dev`.
- [x] Document backend tests with `go test ./...`.
- [x] Document frontend build with `cd web && bun run build`.
- [x] Add root Bun development scripts for combined backend/frontend hot reload.

### Documentation

- [x] Update the README with the local development commands once the skeleton exists.
- [x] Link Sprint 1 from the README documentation section.
- [x] Keep the roadmap focused on product direction; keep sprint execution details in this file.

## Public Interfaces

Sprint 1 introduces one public backend endpoint:

```http
GET /api/health
```

Expected response:

```json
{
  "status": "ok"
}
```

During development:

- The Go backend serves API routes.
- Vite serves the frontend.
- The frontend may call the backend health endpoint directly or through a Vite proxy if configured during implementation.

Production embedding of frontend assets is intentionally deferred.

## Completion Criteria

Sprint 1 is complete when:

- `go test ./...` passes.
- `go run ./cmd/app` starts the backend without panic.
- `GET /api/health` returns HTTP 200 with `{"status":"ok"}`.
- `cd web && bun install` succeeds.
- `cd web && bun run build` succeeds.
- `cd web && bun dev` can start the frontend development server.
- README or this sprint doc clearly explains how to run backend and frontend locally.

## Handoff To Sprint 2

Sprint 2 should begin after the skeleton is stable. The next likely work is:

- SQLite dependency and migration structure.
- `sessions` and `events` tables.
- Server-owned data types for sessions and events.
- Event sequence assignment tests.
