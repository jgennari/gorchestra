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

This repository is in initial setup. The implementation has not been scaffolded yet.
