# Sprint 9: Long-Running Session UX Polish

Sprint 9 makes Gorchestra comfortable for monitoring real agent runs over time. The goal is to improve event readability, scrolling behavior, session list ergonomics, reconnect states, and accessibility after the frontend MVP is working end to end.

This sprint should refine the operational console without changing provider behavior or adding orchestration complexity.

## Goal

Improve the frontend experience for long-running fake and Codex sessions:

- Better event grouping.
- Delta coalescing.
- Scroll anchoring.
- Status filters.
- Session title editing.
- Richer event renderers.
- Empty, loading, error, reconnecting, and disconnected states.
- Accessibility and mobile polish.

Sprint 9 should leave the app usable for extended Codex sessions where many logs, tool calls, and partial messages arrive over time.

## Scope

In scope:

- Improve event grouping and rendering.
- Add scroll-follow and jump-to-latest behavior.
- Add session list status filters.
- Add session title editing.
- Add richer renderers for tools, logs, file changes, errors, and unknown provider events.
- Add visible reconnecting and disconnected states.
- Add focused empty/loading/error states.
- Improve keyboard, focus, and screen-reader accessibility.
- Improve mobile session monitoring layout.
- Add frontend tests for grouping, scroll state, filters, title editing, and accessibility-sensitive controls.

Out of scope:

- Codex adapter changes.
- Agent lifecycle changes.
- Multi-agent orchestration.
- Workspace/repo management.
- Auth or multi-user permissions.
- Cost tracking.
- Observability dashboards.
- Prompt templates.
- Durable frontend storage.

## Decisions

- Keep this sprint frontend-heavy.
- Use backend additions only for session title editing and list filtering if missing.
- Keep event stream source of truth unchanged: server history plus SSE.
- Keep `lastSeq` in React state only.
- Keep failed events expanded by default.
- Collapse completed noisy groups by default.
- Auto-follow only when the user is already near the bottom.
- Do not force-scroll when the user has scrolled up.
- Use shadcn components already installed in Sprint 8; add only missing components that are directly needed.
- Maintain the restrained operational visual style.

## Backend Additions

Add these small API capabilities only if they do not already exist.

### Update Session Title

```http
PATCH /api/sessions/{sessionId}
```

Request:

```json
{
  "title": "Refactor auth middleware"
}
```

Response:

```json
{
  "id": "sess_...",
  "title": "Refactor auth middleware",
  "agent_type": "codex",
  "status": "running",
  "created_at": "2026-06-12T16:00:00Z",
  "updated_at": "2026-06-12T16:03:00Z",
  "completed_at": null
}
```

Behavior:

- Trim title before saving.
- Allow empty title only if the existing API already treats titles as optional.
- Update `updated_at`.
- Return HTTP 404 for unknown sessions.
- Return HTTP 400 for malformed JSON.

### Session List Filtering

```http
GET /api/sessions?status=running&limit=50
```

Behavior:

- Support optional `status`.
- Allow `idle`, `running`, `completed`, `failed`, and `cancelled`.
- Return HTTP 400 for unsupported statuses.
- Preserve existing ordering by `updated_at DESC`.
- Preserve existing limit defaults and caps.

## Event Grouping

Add a grouping layer between raw events and rendering.

Required groups:

- User message.
- Agent message.
- Thinking/planning.
- Tool call.
- File change.
- Command/log output.
- Error.
- Completion/cancellation.
- Unknown provider event.

Rules:

- [x] Coalesce consecutive `agent.message.delta` events from the same session into a single visible agent message segment.
- [x] Keep `agent.message.completed` as a clear boundary.
- [x] Group `tool.call.started` and `tool.call.completed` when they share an identifier in the payload.
- [x] If no tool identifier exists, group nearby tool events by type and sequence proximity.
- [x] Group consecutive `agent.log.delta` events into collapsible log blocks.
- [x] Render `file.change.completed` as file path rows when paths are available.
- [x] Render `agent.run.failed` and `provider.codex.parse_error` expanded by default.
- [x] Render `provider.codex.event` in a collapsed raw JSON details row.
- [x] Show terminal events with completed, failed, or cancelled visual treatment.

## Scroll Behavior

- [x] Track whether the user is near the bottom of the event stream.
- [x] Auto-follow new events only when near bottom.
- [x] Stop auto-follow when the user scrolls up.
- [x] Show a `Jump to latest` control when new events arrive while auto-follow is paused.
- [x] Hide `Jump to latest` after the user returns to the bottom.
- [x] Preserve scroll position when older history is re-rendered.
- [x] Keep the prompt composer visible without covering the latest event.
- [x] Avoid layout shifts when event groups expand or collapse.

## Session List UX

- [x] Add status filter controls for `All`, `Running`, `Failed`, `Completed`, and `Cancelled`.
- [x] Show session status badges consistently.
- [x] Show updated time or last event time in each session row.
- [x] Refresh the list when selected session reaches a terminal event.
- [x] Keep the selected session visible after list refresh.
- [x] Show an empty filtered state when no sessions match.
- [x] Keep mobile session list usable inside the sheet from Sprint 8.

## Session Detail UX

- [x] Add inline session title editing.
- [x] Save title changes through `PATCH /api/sessions/{sessionId}`.
- [x] Show optimistic title edits only while save is pending.
- [x] Revert and show an inline error if save fails.
- [x] Show agent type, status, created time, updated time, and terminal time where available.
- [x] Show last received event time.
- [x] Show reconnecting and disconnected states near the stream header.
- [x] Keep cancel action visually available but not dominant.

## State Views

Add explicit views for:

- No sessions yet.
- No session selected.
- Session has no events yet.
- Loading session history.
- Loading sessions.
- Failed to load sessions.
- Failed to load event history.
- SSE reconnecting.
- SSE disconnected.
- Agent run failed.
- Agent run cancelled.

All error states should include enough detail for debugging without exposing secrets.

## Accessibility

- [x] Ensure all icon-only buttons have accessible labels.
- [x] Ensure focus states are visible.
- [x] Ensure session rows are keyboard selectable.
- [x] Ensure dialogs and sheets trap focus correctly through shadcn primitives.
- [x] Mark event stream updates with an appropriate live region that does not spam screen readers.
- [x] Use semantic headings for session list and detail panes.
- [x] Ensure color is not the only signal for status.
- [x] Confirm all interactive controls are reachable by keyboard.
- [x] Keep text contrast acceptable in light and dark modes if dark mode exists.

## Mobile Polish

- [ ] Validate the layout at 375px width.
- [x] Keep top toolbar controls on one or two stable rows without overlap.
- [x] Keep session sheet scrolling independent from the event stream.
- [x] Keep composer reachable when the virtual keyboard is open.
- [x] Ensure event rows wrap long commands and paths cleanly.
- [x] Avoid tiny tap targets.

## Tests And Verification

### Frontend Tests

- [x] Test delta coalescing.
- [x] Test tool start/completion grouping.
- [x] Test log grouping.
- [x] Test failed events render expanded.
- [x] Test unknown provider events render collapsed with raw JSON available.
- [x] Test event reducer preserves sequence order and dedupes.
- [x] Test status filters.
- [x] Test title editing success and failure.
- [x] Test `Jump to latest` state transitions.
- [x] Test cancel button accessibility label.
- [x] Test session row keyboard selection.

### Backend Tests

- [x] Test `PATCH /api/sessions/{sessionId}` updates title if added in this sprint.
- [x] Test title update returns 404 for unknown sessions.
- [x] Test session list status filtering if added in this sprint.
- [x] Test invalid status filter returns HTTP 400.

### Manual Browser Verification

- [x] `cd web && bun run build` passes.
- [x] `cd web && bun run lint` passes if lint remains configured.
- [x] Frontend tests pass.
- [x] `go test ./...` passes.
- [ ] Start a fake session and confirm event grouping.
- [ ] Start a Codex session and confirm logs/tools/errors remain scannable.
- [ ] Scroll up during a run and confirm auto-follow pauses.
- [ ] Use `Jump to latest` and confirm it resumes following.
- [ ] Disconnect/reconnect the backend or network and confirm UI states are visible.
- [ ] Edit a session title and confirm the list and detail update.
- [ ] Test mobile layout at 375px.
- [ ] Navigate core workflows by keyboard.

### Version Control

- [x] Commit Sprint 9 in one dedicated git commit after verification passes.

## Completion Criteria

Sprint 9 is complete when:

- Long-running sessions stay readable as events accumulate.
- Agent deltas, logs, tools, files, errors, and unknown provider events render in distinct groups.
- Auto-follow and `Jump to latest` behave predictably.
- Reconnecting and disconnected stream states are visible.
- Session title editing works.
- Session list filtering works.
- Empty, loading, and error states are explicit.
- Mobile layout remains usable.
- Core controls are keyboard accessible.
- Frontend build and tests pass.
- Backend tests pass.

## Handoff To Sprint 10

Sprint 10 should focus on packaging and release readiness:

- Embed built frontend assets in the Go binary.
- Serve the React app from the backend in production.
- Add production build commands.
- Align README, roadmap, and scripts with Bun.
- Prepare local install/run docs.
- Add release artifact naming and smoke checks.
