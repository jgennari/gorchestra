# Sprint 7: Codex App-Server Adapter

Sprint 7 adds the first real agent provider: Codex. The goal is to run Codex through the existing agent interface, drive `codex app-server` over stdio JSON-RPC, normalize app-server notifications into Gorchestra events, and reuse the Sprint 6 run manager for cancellation.

This sprint should keep provider-specific behavior inside the Codex adapter. The orchestrator, event service, and HTTP handlers should continue to depend on provider-neutral agent behavior.

## Goal

Add:

- `internal/agents/codex`
- `agent_type: "codex"`
- Codex CLI process execution through `codex app-server --stdio`
- JSON-RPC request/response and notification handling over newline-delimited stdio
- App-server event parsing and normalization
- Codex cancellation through the existing run-control path

Sprint 7 should leave the repository ready for Sprint 8, where the frontend can expose the full create-message-stream loop to users.

## Scope

In scope:

- Add a Codex adapter that implements the Sprint 5 agent interface.
- Support `agent_type: "codex"` in session creation and message submission.
- Invoke Codex app-server over stdio.
- Initialize the app-server, start an ephemeral thread, and start a single turn for each Gorchestra run.
- Parse newline-delimited JSON-RPC messages from Codex stdout incrementally.
- Capture Codex stderr as provider log events.
- Normalize known Codex events into Gorchestra event types.
- Preserve unknown Codex notifications as raw provider events.
- Use Sprint 6 cancellation to send `turn/interrupt`, then stop active Codex processes if needed.
- Add parser, adapter, process, and HTTP integration tests with fake Codex binaries and fixtures.

Out of scope:

- Frontend session UI.
- Workspace/repo management UI.
- Multiple workspaces per server.
- Durable job queue.
- Resuming previous Codex sessions.
- Long-lived shared Codex app-server processes.
- Codex cloud tasks.
- OpenAI Responses API adapter.
- Claude adapter.
- Multi-agent orchestration.

## Current Codex Surface Notes

Planning verified the local Codex CLI surface with `codex-cli 0.139.0` and the official Codex app-server documentation.

Relevant current behavior:

- `codex app-server` exposes bidirectional JSON-RPC 2.0 for rich clients.
- `stdio://` is the default transport; messages are newline-delimited JSON objects on stdin/stdout.
- The CLI supports `codex app-server --stdio` and `codex app-server --listen stdio://`.
- The client flow for this sprint is `initialize`, `initialized`, `thread/start`, `turn/start`, notification streaming, and optional `turn/interrupt`.
- `thread/start` supports ephemeral threads, `cwd`, runtime workspace roots, approval policy, sandbox mode, and model override.
- `turn/start` accepts text user input and returns a Codex turn ID.
- Relevant notifications include `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, command output deltas, reasoning deltas, file-change updates, warnings, and errors.
- App-server terminal turn statuses include `completed`, `interrupted`, `failed`, and `inProgress`.

The implementation must still verify the exact event fields against the installed Codex version before locking parser behavior. Treat Codex app-server JSON-RPC as an external protocol that can evolve.

## Decisions

- Codex package: `internal/agents/codex`
- Codex invocation: `codex app-server --stdio`
- Default Codex binary: `codex`
- Codex binary override: `--codex-bin`
- Default Codex sandbox: `workspace-write`
- Codex sandbox override: `--codex-sandbox`
- Default Codex approval policy: `never`
- Codex model override: optional `--codex-model`
- Default workspace for Codex runs: server startup working directory
- Workspace override: optional server config flag `--workspace`
- Do not pass prompts through a shell; use `os/exec` arguments.
- Do not log environment variables, auth paths, access tokens, or API keys.
- Keep the existing `fake` agent available for deterministic tests.
- If the Codex binary cannot be found, `agent_type: "codex"` should be unavailable and session creation should return HTTP 503.
- If Codex starts but exits with an error, persist `agent.run.failed` and mark the session `failed`.
- If cancellation stops Codex, persist `agent.run.cancelled` and mark the session `cancelled`.
- Run one app-server process per Gorchestra run for Sprint 7. A pooled or long-lived app-server can be revisited after the frontend loop proves out.

## Checklist

### Configuration

- [x] Add config fields for Codex binary, sandbox, approval policy, optional model, and workspace.
- [x] Add CLI flags for `--codex-bin`, `--codex-sandbox`, `--codex-model`, and `--workspace`.
- [x] Keep Codex approval policy fixed at `never` in this sprint unless existing config already supports exposing it.
- [x] Validate the Codex binary with `<codex-bin> --version` during startup or agent registration.
- [x] Log Codex availability and version without failing fake-agent operation.
- [x] Return HTTP 503 when creating a Codex session while Codex is unavailable.

### Agent Registration

- [x] Register `fake` and `codex` agents through the provider-neutral registry.
- [x] Accept `agent_type: "codex"` in `POST /api/sessions`.
- [x] Keep unsupported agent types returning HTTP 400.
- [x] Keep session creation and message submission handlers independent from Codex-specific types.
- [x] Pass the configured workspace into `AgentInput.Workdir`.

### Codex Process Execution

- [x] Build the Codex command with `exec.CommandContext` or equivalent explicit process control.
- [x] Invoke Codex with arguments equivalent to:

```txt
codex app-server --stdio
```

- [x] Send `initialize` with Gorchestra client metadata.
- [x] Send `initialized` after the initialize response.
- [x] Send `thread/start` with `ephemeral: true`, configured workspace, approval policy `never`, sandbox, runtime workspace roots, and optional model.
- [x] Send `turn/start` with text user input and the configured workspace.
- [x] Include a model override only when one is configured.
- [x] Use the configured binary path instead of hard-coding `codex`.
- [x] Read stdout line-by-line as JSON-RPC messages.
- [x] Read stderr line-by-line and emit provider log events.
- [x] Wait for the process to exit after stdout and stderr readers finish.
- [x] Treat non-zero exit status as a failed run unless cancellation was requested.
- [x] Include process exit code in failure payloads when available.

### Cancellation

- [x] Connect Codex execution to the Sprint 6 run context.
- [x] On cancellation, send `turn/interrupt` when a thread ID and turn ID are known.
- [x] Prefer graceful app-server interruption first.
- [x] Force-kill the process after a short grace period if it does not exit.
- [x] Do not emit successful completion after cancellation.
- [x] Ensure active run cleanup still happens through the run manager.

### JSON-RPC Parser

- [x] Add a parser that accepts one JSON object per line.
- [x] Ignore blank lines.
- [x] Return structured parse errors that include the line number.
- [x] Preserve raw JSON for unknown notification methods.
- [x] Match responses to request IDs.
- [x] Handle server requests with a visible event and a JSON-RPC error response until explicit approval/user-input support is added.
- [x] Keep parser tests independent from spawning Codex.
- [x] Store representative JSON-RPC fixtures in testdata.
- [x] Include fixtures for success, command execution, agent messages, unknown notifications, and invalid JSON.

### Event Normalization

- [x] Normalize `thread/started` to `agent.run.started` with Codex thread ID in the payload.
- [x] Normalize `turn/started` to `agent.status.started` unless a run-start event has already been emitted.
- [x] Normalize `item/agentMessage/delta` to `agent.message.delta`.
- [x] Normalize completed agent-message items to `agent.message.completed`.
- [x] Normalize reasoning items to `agent.thinking.completed` when text or summary is available.
- [x] Normalize command execution start/completion items to `tool.call.started` and `tool.call.completed`.
- [x] Normalize file change items to `file.change.completed`.
- [x] Normalize MCP tool call items to `tool.call.started` and `tool.call.completed`.
- [x] Normalize web search items to `tool.call.started` and `tool.call.completed`.
- [x] Normalize `turn/completed` with status `completed` to `agent.run.completed`.
- [x] Normalize `turn/completed` with status `interrupted` to `agent.run.cancelled`.
- [x] Normalize `turn/completed` with status `failed` and top-level `error` to `agent.run.failed`.
- [x] Emit unknown Codex notifications as `provider.codex.event` with the raw payload.
- [x] Never emit more than one terminal run event for a single Codex run.

### Payload Rules

- [x] Include the raw Codex event type in every normalized payload as `provider_event_type`.
- [x] Include Codex item IDs when present.
- [x] Include command text, exit code, stdout, and stderr for command execution events when present.
- [x] Include changed file paths for file change events when present.
- [x] Do not include environment variables or auth file contents in payloads.
- [x] Keep payloads JSON-serializable and stable enough for frontend rendering.

### Error Handling

- [x] Missing Codex binary returns an agent-unavailable error.
- [x] Codex auth failures become `agent.run.failed` events and failed sessions.
- [x] Invalid JSON-RPC from Codex becomes `provider.codex.parse_error` and fails the run.
- [x] Stderr lines are emitted as `agent.log.delta` unless the run has already ended.
- [x] Process startup failure emits `agent.run.failed`.
- [x] Cancellation maps to `agent.run.cancelled`, not `agent.run.failed`.

### Tests

- [x] Test Codex binary availability detection.
- [x] Test `agent_type: "codex"` is accepted when the adapter is available.
- [x] Test `agent_type: "codex"` returns HTTP 503 when the adapter is unavailable.
- [x] Test command construction uses explicit args and configured workdir.
- [x] Test successful app-server JSON-RPC fixtures normalize into expected Gorchestra events.
- [x] Test command execution fixtures normalize into tool events.
- [x] Test unknown notifications become `provider.codex.event`.
- [x] Test invalid JSON-RPC fails with a parse error event.
- [x] Test fake Codex app-server process non-zero exit marks the run failed.
- [x] Test fake Codex app-server process cancellation sends `turn/interrupt` and marks the run cancelled.
- [x] Test terminal events are not duplicated.
- [x] Test stderr lines become log events.
- [x] Test `go test ./...` passes.
- [x] Test `go test -race ./...` passes or document any race-test limitation.

Use fake Codex app-server binaries or test helper processes for automated tests. Do not require real Codex credentials in default test runs. Real Codex integration tests may exist behind an explicit environment variable such as `GORCHESTRA_CODEX_INTEGRATION=1`.

### Manual Verification

- [x] Run `<codex-bin> --version` and record the version in test logs or implementation notes.
- [x] Generate or inspect the app-server JSON schema from the installed Codex version.
- [ ] Run a small real Codex app-server turn with `ephemeral: true`, `sandbox: read-only`, and `approvalPolicy: never`.
- [ ] Inspect the JSON-RPC notification fields produced by the installed version.
- [ ] Update parser fixtures if the real protocol differs from the planning assumptions.
- [ ] Verify a real Codex run streams normalized events through the existing SSE endpoint.
- [ ] Verify cancelling a real Codex run produces `agent.run.cancelled`.

## Public Interfaces

Sprint 7 expands session creation to support Codex:

```http
POST /api/sessions
```

Request:

```json
{
  "agent_type": "codex",
  "title": "Refactor auth middleware"
}
```

Success response remains:

```json
{
  "session_id": "sess_..."
}
```

Sprint 7 adds server configuration flags:

```bash
gorchestra \
  --workspace /path/to/repo \
  --codex-bin codex \
  --codex-sandbox workspace-write \
  --codex-model gpt-5.4
```

`--codex-model` is optional. If it is omitted, Codex uses its configured default model.

The message submission, event history, SSE, and cancellation endpoints keep the same HTTP shapes introduced in earlier sprints.

## Completion Criteria

Sprint 7 is complete when:

- `agent_type: "codex"` can be selected for a session.
- Submitting a message to a Codex session launches `codex app-server --stdio`.
- Gorchestra sends `initialize`, `thread/start`, and `turn/start`.
- Codex stdout JSON-RPC is parsed incrementally.
- Known Codex events are normalized into Gorchestra events.
- Unknown Codex events are preserved as raw provider events.
- Codex stderr is visible as log events.
- Codex run success, failure, and cancellation produce the correct terminal events and session statuses.
- Existing fake-agent behavior still works.
- Real Codex integration can be manually verified without changing default tests.
- `go test ./...` passes.
- `go test -race ./...` passes or any limitation is documented.
- No frontend session UI, Codex Cloud integration, shared app-server pool, or durable job queue has been added.

## Handoff To Sprint 8

Sprint 8 should build the frontend MVP on top of the backend vertical slice:

- Session list.
- Session creation with `fake` or `codex`.
- Prompt submission.
- Live event stream view.
- Reconnect state.
- Cancel button.
- Basic rendering groups for messages, logs, tools, errors, and completion.
