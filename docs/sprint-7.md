# Sprint 7: Codex Adapter

Sprint 7 adds the first real agent provider: Codex. The goal is to run Codex through the existing agent interface, normalize its JSONL output into Gorchestra events, and reuse the Sprint 6 run manager for cancellation.

This sprint should keep provider-specific behavior inside the Codex adapter. The orchestrator, event service, and HTTP handlers should continue to depend on provider-neutral agent behavior.

## Goal

Add:

- `internal/agents/codex`
- `agent_type: "codex"`
- Codex CLI process execution through `codex exec --json`
- JSONL event parsing and normalization
- Codex cancellation through the existing run-control path

Sprint 7 should leave the repository ready for Sprint 8, where the frontend can expose the full create-message-stream loop to users.

## Scope

In scope:

- Add a Codex adapter that implements the Sprint 5 agent interface.
- Support `agent_type: "codex"` in session creation and message submission.
- Invoke Codex non-interactively with JSONL output.
- Parse Codex stdout JSONL incrementally.
- Capture Codex stderr as provider log events.
- Normalize known Codex events into Gorchestra event types.
- Preserve unknown Codex JSONL events as raw provider events.
- Use Sprint 6 cancellation to stop active Codex processes.
- Add parser, adapter, process, and HTTP integration tests with fake Codex binaries and fixtures.

Out of scope:

- Frontend session UI.
- Workspace/repo management UI.
- Multiple workspaces per server.
- Durable job queue.
- Resuming previous Codex sessions.
- Codex app-server integration.
- Codex cloud tasks.
- OpenAI Responses API adapter.
- Claude adapter.
- Multi-agent orchestration.

## Current Codex Surface Notes

Planning verified the local Codex CLI surface with `codex-cli 0.139.0`.

Relevant current behavior:

- `codex exec` is the documented non-interactive mode.
- `codex exec --json` emits JSON Lines on stdout.
- Documented JSONL event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`.
- Documented item types include agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates.
- `codex exec --ephemeral` avoids persisting Codex session files for the run.

The implementation must still verify the exact event fields against the installed Codex version before locking parser behavior. Treat Codex JSONL as an external protocol that can evolve.

## Decisions

- Codex package: `internal/agents/codex`
- Codex invocation: `codex exec --json --color never --ephemeral`
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

## Checklist

### Configuration

- [ ] Add config fields for Codex binary, sandbox, approval policy, optional model, and workspace.
- [ ] Add CLI flags for `--codex-bin`, `--codex-sandbox`, `--codex-model`, and `--workspace`.
- [ ] Keep Codex approval policy fixed at `never` in this sprint unless existing config already supports exposing it.
- [ ] Validate the Codex binary with `<codex-bin> --version` during startup or agent registration.
- [ ] Log Codex availability and version without failing fake-agent operation.
- [ ] Return HTTP 503 when creating a Codex session while Codex is unavailable.

### Agent Registration

- [ ] Register `fake` and `codex` agents through the provider-neutral registry.
- [ ] Accept `agent_type: "codex"` in `POST /api/sessions`.
- [ ] Keep unsupported agent types returning HTTP 400.
- [ ] Keep session creation and message submission handlers independent from Codex-specific types.
- [ ] Pass the configured workspace into `AgentInput.Workdir`.

### Codex Process Execution

- [ ] Build the Codex command with `exec.CommandContext` or equivalent explicit process control.
- [ ] Invoke Codex with arguments equivalent to:

```txt
codex exec --json --color never --ephemeral --sandbox workspace-write --ask-for-approval never --cd <workdir> <message>
```

- [ ] Include `--model <model>` only when a model override is configured.
- [ ] Use the configured binary path instead of hard-coding `codex`.
- [ ] Read stdout line-by-line as JSONL.
- [ ] Read stderr line-by-line and emit provider log events.
- [ ] Wait for the process to exit after stdout and stderr readers finish.
- [ ] Treat non-zero exit status as a failed run unless cancellation was requested.
- [ ] Include process exit code in failure payloads when available.

### Cancellation

- [ ] Connect Codex execution to the Sprint 6 run context.
- [ ] On cancellation, stop the Codex process.
- [ ] Prefer graceful interrupt first when supported by the platform.
- [ ] Force-kill the process after a short grace period if it does not exit.
- [ ] Do not emit successful completion after cancellation.
- [ ] Ensure active run cleanup still happens through the run manager.

### JSONL Parser

- [ ] Add a parser that accepts one JSON object per line.
- [ ] Ignore blank lines.
- [ ] Return structured parse errors that include the line number.
- [ ] Preserve raw JSON for unknown event types.
- [ ] Keep parser tests independent from spawning Codex.
- [ ] Store representative JSONL fixtures in testdata.
- [ ] Include fixtures for success, failure, command execution, agent messages, and unknown event types.

### Event Normalization

- [ ] Normalize `thread.started` to `agent.run.started` with Codex thread ID in the payload.
- [ ] Normalize `turn.started` to `agent.status.started` unless a run-start event has already been emitted.
- [ ] Normalize completed agent-message items to `agent.message.completed`.
- [ ] Normalize reasoning items to `agent.thinking.completed` when text or summary is available.
- [ ] Normalize command execution start/completion items to `tool.call.started` and `tool.call.completed`.
- [ ] Normalize file change items to `file.change.completed`.
- [ ] Normalize MCP tool call items to `tool.call.started` and `tool.call.completed`.
- [ ] Normalize web search items to `tool.call.started` and `tool.call.completed`.
- [ ] Normalize `turn.completed` to `agent.run.completed`.
- [ ] Normalize `turn.failed` and top-level `error` to `agent.run.failed`.
- [ ] Emit unknown Codex events as `provider.codex.event` with the raw payload.
- [ ] Never emit more than one terminal run event for a single Codex run.

### Payload Rules

- [ ] Include the raw Codex event type in every normalized payload as `provider_event_type`.
- [ ] Include Codex item IDs when present.
- [ ] Include command text, exit code, stdout, and stderr for command execution events when present.
- [ ] Include changed file paths for file change events when present.
- [ ] Do not include environment variables or auth file contents in payloads.
- [ ] Keep payloads JSON-serializable and stable enough for frontend rendering.

### Error Handling

- [ ] Missing Codex binary returns an agent-unavailable error.
- [ ] Codex auth failures become `agent.run.failed` events and failed sessions.
- [ ] Invalid JSONL from Codex becomes `provider.codex.parse_error` and fails the run.
- [ ] Stderr lines are emitted as `agent.log.delta` unless the run has already ended.
- [ ] Process startup failure emits `agent.run.failed`.
- [ ] Cancellation maps to `agent.run.cancelled`, not `agent.run.failed`.

### Tests

- [ ] Test Codex binary availability detection.
- [ ] Test `agent_type: "codex"` is accepted when the adapter is available.
- [ ] Test `agent_type: "codex"` returns HTTP 503 when the adapter is unavailable.
- [ ] Test command construction uses explicit args and configured workdir.
- [ ] Test successful JSONL fixtures normalize into expected Gorchestra events.
- [ ] Test command execution fixtures normalize into tool events.
- [ ] Test unknown JSONL events become `provider.codex.event`.
- [ ] Test invalid JSONL fails with a parse error event.
- [ ] Test fake Codex process non-zero exit marks the session `failed`.
- [ ] Test fake Codex process cancellation marks the session `cancelled`.
- [ ] Test terminal events are not duplicated.
- [ ] Test stderr lines become log events.
- [ ] Test `go test ./...` passes.
- [ ] Test `go test -race ./...` passes or document any race-test limitation.

Use fake Codex binaries or test helper processes for automated tests. Do not require real Codex credentials in default test runs. Real Codex integration tests may exist behind an explicit environment variable such as `GORCHESTRA_CODEX_INTEGRATION=1`.

### Manual Verification

- [ ] Run `<codex-bin> --version` and record the version in test logs or implementation notes.
- [ ] Run a small real Codex command with `--json`, `--ephemeral`, `--sandbox read-only`, and `--ask-for-approval never`.
- [ ] Inspect the JSONL event fields produced by the installed version.
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
- Submitting a message to a Codex session launches `codex exec --json`.
- Codex stdout JSONL is parsed incrementally.
- Known Codex events are normalized into Gorchestra events.
- Unknown Codex events are preserved as raw provider events.
- Codex stderr is visible as log events.
- Codex run success, failure, and cancellation produce the correct terminal events and session statuses.
- Existing fake-agent behavior still works.
- Real Codex integration can be manually verified without changing default tests.
- `go test ./...` passes.
- `go test -race ./...` passes or any limitation is documented.
- No frontend session UI, app-server integration, Codex Cloud integration, or durable job queue has been added.

## Handoff To Sprint 8

Sprint 8 should build the frontend MVP on top of the backend vertical slice:

- Session list.
- Session creation with `fake` or `codex`.
- Prompt submission.
- Live event stream view.
- Reconnect state.
- Cancel button.
- Basic rendering groups for messages, logs, tools, errors, and completion.
