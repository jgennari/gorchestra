# Sprint 10: Packaging And Release Readiness

Sprint 10 turns the MVP into a single deployable application. The goal is to build one Go binary that serves the API and React frontend, stores data in a sensible default location, and can be released with reproducible artifacts.

This sprint should finish MVP deployability. Product expansion work such as auth, multi-user support, workspaces, and additional providers remains out of scope.

## Goal

Add production packaging:

- Embedded React assets.
- Single Go HTTP server for API and frontend routes.
- OS-appropriate default data directory.
- Production build commands.
- Release artifact layout.
- Smoke checks.
- Homebrew formula readiness.

Sprint 10 should leave Gorchestra installable and runnable as a local single-binary app.

## Scope

In scope:

- Build the frontend with Bun.
- Embed built frontend assets into the Go binary.
- Serve embedded React assets from the backend.
- Preserve `/api/*` backend routing.
- Add SPA fallback to `index.html`.
- Add CLI flags for host, port, data directory, open-browser behavior, and version.
- Use OS-appropriate default app data paths.
- Add reproducible local build commands.
- Add smoke checks for the built binary.
- Document release artifact naming and Homebrew formula requirements.

Out of scope:

- Auth or multi-user permissions.
- Cloud deployment.
- Docker packaging unless already trivial.
- Automatic update checks.
- Telemetry.
- Durable job queue.
- New providers.
- Frontend UX changes beyond production serving fixes.

## Decisions

- Final binary name: `gorchestra`.
- Production binary output: `dist/gorchestra`.
- Frontend package manager: Bun.
- Production frontend build command: `cd web && bun install --frozen-lockfile && bun run build`.
- Backend build command: `go build -o dist/gorchestra ./cmd/app`.
- Embed package: `internal/webassets`.
- Embedded asset source: copied Vite `web/dist` output.
- API route prefix: `/api/`.
- Frontend route fallback: embedded `index.html`.
- Default host: `127.0.0.1`.
- Default port: `8080`.
- Default data directory: OS app data directory.
- SQLite filename: `gorchestra.db`.
- `--data-dir` overrides the default database location.
- `--db` remains supported if it already exists, but `--data-dir` becomes the preferred user-facing flag.
- `--open` opens the browser after startup.
- `--version` prints version and exits.

## Checklist

### Frontend Build And Asset Staging

- [x] Confirm `cd web && bun install --frozen-lockfile` works.
- [x] Confirm `cd web && bun run build` writes production assets to `web/dist`.
- [x] Add a repeatable staging step that copies `web/dist` into `internal/webassets/dist`.
- [x] Ensure staged assets are available to `go:embed`.
- [x] Ensure old staged assets are removed before copying new ones.
- [x] Keep `web/node_modules` and temporary build artifacts out of git.
- [x] Decide whether `internal/webassets/dist` is committed or generated during release; document the decision.

### Go Embed And Static Serving

- [x] Add `internal/webassets`.
- [x] Embed staged frontend assets with `go:embed`.
- [x] Serve static assets from the embedded filesystem.
- [x] Preserve all `/api/*` routes as backend routes.
- [x] Serve `index.html` for non-API browser routes.
- [x] Return 404 for missing API routes.
- [x] Set reasonable content types for embedded assets.
- [x] Ensure browser refresh works on frontend routes.
- [x] Add tests for API route precedence and SPA fallback.

Example embed shape:

```go
//go:embed dist/*
var Assets embed.FS
```

Acceptable staged layout:

```txt
internal/webassets/
  assets.go
  dist/
    index.html
    assets/...
```

### Runtime Configuration

- [x] Add `--host`.
- [x] Add `--port`.
- [x] Add `--data-dir`.
- [x] Add `--open`.
- [x] Add `--version`.
- [x] Preserve existing flags from earlier sprints.
- [x] Add environment variable equivalents where already consistent with the config package style.
- [x] Print the listening URL on startup.
- [x] Avoid logging secrets, tokens, auth files, or full environment dumps.

Expected CLI shape:

```bash
gorchestra --host 127.0.0.1 --port 8080 --data-dir ./data --open
gorchestra --version
```

### Default Data Paths

- [x] On macOS, default to `~/Library/Application Support/Gorchestra`.
- [x] On Linux with `XDG_DATA_HOME`, default to `$XDG_DATA_HOME/gorchestra`.
- [x] On Linux without `XDG_DATA_HOME`, default to `~/.local/share/gorchestra`.
- [x] Create the data directory if it does not exist.
- [x] Store SQLite at `<data-dir>/gorchestra.db`.
- [x] Keep explicit `--db` behavior working if it already exists.
- [x] Document how `--db` and `--data-dir` interact if both are provided.

### Build And Release Commands

- [x] Add a top-level build command or script for production.
- [x] Add a clean command or script that removes generated release output.
- [x] Ensure build commands work from a clean checkout with Bun and Go installed.
- [x] Create `dist/` if missing.
- [x] Output `dist/gorchestra`.
- [x] Add checksums for release artifacts.
- [x] Document supported OS/architecture targets.

Suggested local release flow:

```bash
cd web && bun install --frozen-lockfile && bun run build
go test ./...
go build -o dist/gorchestra ./cmd/app
./dist/gorchestra --version
```

### Smoke Checks

- [x] Start `dist/gorchestra` with a temporary data directory.
- [x] Verify `GET /api/health`.
- [x] Verify the root path serves the React app.
- [x] Verify a frontend route refresh serves `index.html`.
- [x] Verify an empty database initializes automatically.
- [x] Verify session history survives binary restart.
- [x] Verify no local test database is written outside the configured data directory.

### Documentation

- [x] Update README with production build commands.
- [x] Update README with local run commands.
- [x] Document default data paths.
- [x] Document `--host`, `--port`, `--data-dir`, `--db`, `--open`, and `--version`.
- [x] Align roadmap packaging commands with Bun.
- [x] Document Homebrew install target shape.
- [x] Document how to remove local app data during development.

### Homebrew Readiness

- [x] Define release artifact naming.
- [x] Define checksum generation.
- [x] Draft Homebrew formula requirements.
- [x] Include optional service shape for `brew services`.
- [x] Document expected install command:

```bash
brew install jgennari/tap/gorchestra
gorchestra
```

- [x] Document optional service command:

```bash
brew services start gorchestra
```

### Version Control

- [ ] Commit Sprint 10 in one dedicated git commit after verification passes.

## Public Interfaces

Sprint 10 adds or confirms the production CLI:

```bash
gorchestra \
  --host 127.0.0.1 \
  --port 8080 \
  --data-dir ./data \
  --open
```

Version command:

```bash
gorchestra --version
```

Production HTTP behavior:

- `/api/*` routes are served by backend handlers.
- `/` serves the React app.
- Frontend browser routes fall back to `index.html`.
- Missing API routes return API-style 404s.

Default data paths:

```txt
macOS: ~/Library/Application Support/Gorchestra/gorchestra.db
Linux: $XDG_DATA_HOME/gorchestra/gorchestra.db
Fallback: ~/.local/share/gorchestra/gorchestra.db
```

## Tests And Verification

- [x] `cd web && bun install --frozen-lockfile` passes.
- [x] `cd web && bun run build` passes.
- [x] Frontend tests pass if configured.
- [x] `go test ./...` passes.
- [x] Production binary builds at `dist/gorchestra`.
- [x] `dist/gorchestra --version` exits successfully.
- [x] `dist/gorchestra --data-dir <tempdir>` starts successfully.
- [x] `GET /api/health` returns HTTP 200.
- [x] `GET /` returns the embedded frontend.
- [x] `GET /some/frontend/route` returns the embedded frontend.
- [x] `GET /api/does-not-exist` returns HTTP 404.
- [x] Restarting the binary preserves SQLite session history in the configured data directory.

## Completion Criteria

Sprint 10 is complete when:

- One binary serves both API and frontend.
- The app starts from an empty data directory.
- SQLite data is written to the configured or default app data path.
- Browser refresh works for frontend routes.
- Production build steps are documented and repeatable.
- Smoke checks cover health, frontend serving, SPA fallback, and persistence after restart.
- CLI flags are documented.
- Release artifact naming and checksum expectations are documented.
- Homebrew install requirements are documented.
- No auth, multi-user behavior, new providers, or durable job queue has been added.

## Handoff To Post-MVP

After Sprint 10, Gorchestra has the planned MVP foundation. Next work should be chosen from deferred product enhancements:

- Auth.
- Multi-user permissions.
- Workspace and repo management.
- Agent pool scheduling.
- Multiple concurrent agents per session.
- WebSocket transport.
- Background job queue.
- Remote worker nodes.
- Prompt/version tracking.
- Cost tracking.
- OpenTelemetry traces.
- Claude adapter.
- OpenAI Responses adapter.
- Local session export/import.
