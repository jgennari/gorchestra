# Sprint 8: Frontend MVP

Sprint 8 turns the backend vertical slice into a usable browser app. The goal is to create, monitor, stream, and cancel fake or Codex sessions from the React frontend.

This sprint should make Gorchestra feel like an operational console for agent work, not a chatbot or landing page.

## Goal

Add a frontend MVP with:

- Session list.
- Session detail.
- Session creation for `fake` and `codex`.
- Prompt submission.
- Live event stream.
- Event history recovery on refresh.
- Reconnect handling with `after_seq`.
- Run status display.
- Cancel button.
- Mobile-responsive layout.

Sprint 8 should leave the repository ready for Sprint 9, where event rendering can become richer and long-running session UX can be polished.

## Scope

In scope:

- Add shadcn/ui as the frontend component foundation.
- Add Tailwind CSS for frontend styling.
- Add minimal read-only session API endpoints if they do not already exist.
- Replace the health-only frontend with the session console.
- Add API client helpers for sessions, messages, cancellation, history, and streaming.
- Add React state and hooks for event history and SSE updates.
- Add basic event rendering groups.
- Add responsive desktop and mobile layouts.
- Add frontend tests for the API client, event reducer, and stream hook behavior.

Out of scope:

- Backend agent behavior changes.
- Codex adapter changes.
- Workspace/repo management.
- Auth or multi-user permissions.
- Local storage or local database.
- Advanced event filtering/search.
- Cost tracking.
- Charts, metrics dashboards, or observability pages.
- Production frontend embedding if it has not already been implemented.

## Decisions

- UI component foundation: shadcn/ui.
- shadcn style: `new-york`.
- shadcn base color: `neutral`.
- shadcn theming: CSS variables.
- Icon library: `lucide-react`.
- Frontend package manager: Bun.
- Frontend state: React state only.
- Event dedupe key: `seq`.
- `lastSeq` storage: React state only, not `localStorage`.
- Session list sort: most recently updated first.
- Mobile session list: shadcn `Sheet`.
- No landing page, marketing hero, or decorative app shell.
- Keep cards shallow: use cards for repeated session/event rows only, never nested cards.
- Use native `EventSource` for SSE.
- Because the backend uses typed SSE event names, attach listeners for a centralized list of known event types.

## shadcn Setup

Use the existing Vite + React + TypeScript app under `web/`.

Required setup:

- [x] Add Tailwind CSS and the Vite Tailwind plugin.
- [x] Configure `@/*` path aliases in `tsconfig.json`, `tsconfig.app.json`, and `vite.config.ts`.
- [x] Add shadcn-compatible configuration and components from `web/`.
- [x] Commit `components.json`.
- [x] Add only the components needed for the MVP.

Suggested commands:

```bash
cd web
bun add tailwindcss @tailwindcss/vite lucide-react
bun add -D @types/node
bunx shadcn@latest init
bunx shadcn@latest add button badge input textarea select tabs scroll-area separator sheet tooltip skeleton alert collapsible dropdown-menu
```

If the shadcn CLI prompts for configuration, choose:

- Style: `new-york`
- Base color: `neutral`
- CSS variables: yes
- Components path: `src/components/ui`
- Utils path: `src/lib/utils`
- Import alias: `@/*`

## Backend Read API Additions

The frontend needs session list and detail data. If these endpoints do not already exist, add them in Sprint 8.

### List Sessions

```http
GET /api/sessions?limit=50
```

Behavior:

- Return sessions ordered by `updated_at DESC`.
- Default `limit` to `50`.
- Cap `limit` at `100`.
- Return HTTP 400 for invalid limits.

Response:

```json
{
  "sessions": [
    {
      "id": "sess_...",
      "title": "Refactor auth middleware",
      "agent_type": "codex",
      "status": "running",
      "created_at": "2026-06-12T16:00:00Z",
      "updated_at": "2026-06-12T16:03:00Z",
      "completed_at": null
    }
  ]
}
```

### Get Session

```http
GET /api/sessions/{sessionId}
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

Missing sessions return HTTP 404.

## Frontend Architecture

Add these frontend units or equivalents:

- `src/lib/api.ts` for HTTP calls.
- `src/lib/events.ts` for event typing, dedupe, append, and grouping.
- `src/hooks/use-session-events.ts` for history load and SSE lifecycle.
- `src/components/session-list.tsx`.
- `src/components/session-detail.tsx`.
- `src/components/event-stream.tsx`.
- `src/components/prompt-composer.tsx`.
- `src/components/create-session-dialog.tsx`.

Keep API models explicit:

```ts
type SessionStatus = "idle" | "running" | "completed" | "failed" | "cancelled"

type AgentType = "fake" | "codex"

type Session = {
  id: string
  title: string
  agent_type: AgentType
  status: SessionStatus
  created_at: string
  updated_at: string
  completed_at: string | null
}

type AgentEvent = {
  id: string
  session_id: string
  seq: number
  type: string
  role: string
  status: string
  payload: unknown
  created_at: string
}
```

## Data Flow

### Initial Load

- [x] Fetch `GET /api/sessions`.
- [x] Select the most recently updated session if no session is selected.
- [x] Show an empty state when no sessions exist.
- [x] Keep backend health visible only as a small connection indicator, not the main screen.

### Session Selection

- [x] Fetch `GET /api/sessions/{sessionId}`.
- [x] Fetch `GET /api/sessions/{sessionId}/events?after_seq=0&limit=1000`.
- [x] Store events sorted by `seq`.
- [x] Set `lastSeq` to the highest received sequence.
- [x] Open SSE with `after_seq=lastSeq`.

### SSE Hook

- [x] Open `/api/sessions/{sessionId}/events/stream?after_seq=${lastSeq}`.
- [x] Attach listeners for all known event types.
- [x] Parse each SSE event as an `AgentEvent`.
- [x] Add events through the event reducer.
- [x] Dedupe by `seq`.
- [x] Update `lastSeq` only when a higher `seq` arrives.
- [x] Mark connection state as `connected`, `reconnecting`, or `disconnected`.
- [x] On reconnect, create a new EventSource using the latest `lastSeq`.
- [x] Close the EventSource when switching sessions or unmounting.

Known event types for Sprint 8:

```txt
user.message.completed
agent.run.started
agent.status.started
agent.message.delta
agent.message.completed
agent.thinking.completed
agent.log.delta
tool.call.started
tool.call.completed
file.change.completed
provider.codex.event
provider.codex.parse_error
agent.run.completed
agent.run.failed
agent.run.cancelled
```

### Create Session

- [x] Open a shadcn dialog from the primary toolbar.
- [x] Support `fake` and `codex` agent choices.
- [x] Accept an optional title.
- [x] Call `POST /api/sessions`.
- [x] Add the new session to the list.
- [x] Select the new session.
- [x] Show clear inline errors for unsupported or unavailable agents.

### Submit Prompt

- [x] Show a bottom composer in the session detail view.
- [x] Disable submission when no session is selected.
- [x] Disable submission while the selected session is `running`.
- [x] Call `POST /api/sessions/{sessionId}/messages`.
- [x] Optimistically keep the composer clear only after HTTP success.
- [x] Rely on event stream/history for user message rendering.

### Cancel Run

- [x] Show cancel action only for `running` sessions.
- [x] Call `POST /api/sessions/{sessionId}/cancel`.
- [x] Keep the session visually running until cancellation events or refreshed session data arrive.
- [x] Show a transient notice if cancellation is accepted.
- [x] Surface HTTP 409 as an inline state conflict, then refresh the selected session.

## UI Layout

### Desktop

- [x] Use a two-column app shell.
- [x] Left column: session list, create button, compact status filters.
- [x] Right column: session detail, event stream, prompt composer.
- [x] Keep the event stream as the visual center.
- [x] Pin composer to the bottom of the detail pane.
- [x] Keep latest output visible unless the user has scrolled up.

### Mobile

- [x] Use a top toolbar with current session title and status.
- [x] Put session list in a shadcn `Sheet`.
- [x] Keep prompt composer reachable without covering event output.
- [x] Ensure status badges and action buttons do not wrap awkwardly.
- [x] Test at 375px width.

### Visual Style

- [x] Use a restrained operational palette.
- [x] Avoid large hero typography.
- [x] Avoid decorative gradients, orbs, bokeh, and marketing-style sections.
- [x] Use icons in toolbar buttons where they improve scanning.
- [x] Keep border radius at 8px or less.
- [x] Avoid nested cards.
- [x] Ensure text never overlaps or overflows buttons, badges, or event rows.

## Event Rendering

Render the following groups:

- User message.
- Agent message.
- Thinking/planning.
- Tool call.
- File change.
- Command/log output.
- Error.
- Completion/cancellation.

Rules:

- [x] Coalesce consecutive `agent.message.delta` events visually when possible.
- [x] Render user and agent messages as readable text blocks.
- [x] Render logs and command output in monospace.
- [x] Collapse noisy tool/log groups by default after they complete.
- [x] Keep failed events expanded.
- [x] Show raw payload JSON in a collapsible details area for unknown event types.
- [x] Show exact error payloads for `agent.run.failed` and `provider.codex.parse_error`.
- [x] Show terminal events with clear completed, failed, or cancelled status.

## Tests And Verification

### Frontend Tests

- [x] Add Vitest and React Testing Library if no frontend test setup exists.
- [x] Test event reducer appends events in sequence order.
- [x] Test event reducer dedupes by `seq`.
- [x] Test session API helpers build the correct URLs.
- [x] Test create session form validates agent type and optional title.
- [x] Test prompt composer disables while running.
- [x] Test cancel button is visible only while running.
- [x] Test event renderer handles unknown event types.

### Manual Browser Verification

- [x] `cd web && bun run build` passes.
- [x] `cd web && bun run lint` passes if lint remains configured.
- [x] `go test ./...` passes.
- [x] Start backend and frontend dev servers.
- [x] Create a fake session from the browser.
- [x] Submit a prompt and observe live events.
- [x] Refresh the browser and confirm history reconstructs.
- [x] Create a Codex session if Codex is available.
- [x] Cancel a running session and confirm UI reaches `cancelled`.
- [x] Test mobile layout at 375px and desktop layout at 1440px.

Completion note: The frontend MVP has been exercised through local browser usage and ongoing Gorchestra dogfooding. Automated coverage now backs the critical state transitions for session creation, prompt submission, cancellation controls, event rendering, and refresh/replay behavior.

### Version Control

- [x] Commit Sprint 8 in one dedicated git commit after verification passes.

## Completion Criteria

Sprint 8 is complete when:

- shadcn/ui and Tailwind are configured in the Vite app.
- The browser app opens directly to the Gorchestra console.
- Users can create `fake` and `codex` sessions.
- Users can submit prompts to idle sessions.
- Events render live from SSE.
- Refresh reconstructs event history from the server.
- Reconnect resumes with `after_seq` and does not show duplicate events.
- Users can cancel running sessions.
- Session list and selected session status stay current enough for MVP use.
- Mobile layout is usable.
- Frontend build passes.
- Backend tests still pass.

## Handoff To Sprint 9

Sprint 9 should polish long-running session UX:

- Better event grouping and delta coalescing.
- Scroll anchoring controls.
- Event filters.
- Session title editing.
- Richer tool/file-change renderers.
- Empty, loading, error, and reconnecting states.
- Accessibility pass.
- Production asset embedding if it is still pending.
