# Agent feature audit — September 9, 2026

Gorchestra already has most of the reusable infrastructure needed to close several agent gaps. The highest-value work is to extend Claude's bidirectional input path, generalize context controls, and expose capabilities through the adapter interface. Codex remains the most complete integration, but OpenCode's plan events and Claude's cost reporting also provide patterns worth carrying into the other adapters.

This is a source and protocol audit, not a live-model certification. It covers the current workspace at commit `f293b075b4d7571d456cfa8f261de6043b138017`, including pre-existing uncommitted steering changes. No application implementation or installed runtime was changed. “Recent” below means the August–September releases reviewed; older capabilities are included separately when they offer useful parity work.

## Runtime baseline

| Agent | Local PATH version | Integration used by Gorchestra | Upstream comparison |
| --- | --- | --- | --- |
| Codex | `0.153.4` | App-server JSON-RPC over stdio | Matches the latest CLI release listed in the [official changelog](https://developers.openai.com/codex/changelog), September 4. |
| Claude Code | `2.1.226` | CLI `stream-json`; control input enabled only for interactive permissions | Official changelog lists [2.1.266, September 8](https://code.claude.com/docs/en/changelog). Review an upgrade alongside adapter compatibility checks. |
| OpenCode | `1.17.13` | ACP over stdio | Implementation audited; no full upstream release audit. |
| Pi | `0.85.0` | RPC over stdio | Implementation audited; selected parity opportunities checked against official RPC documentation. |

Versions came from local `--version`, not an inspection of binaries already executing in the human stack. Codex's stable and experimental schemas were generated from the installed binary into a temporary directory. Claude's installed `--help` was also checked. Neither agent was asked to execute a task.

## Implementation matrix

**Yes** means explicitly wired into Gorchestra. **Partial** means limited handling or generic event visibility. **No** means no dedicated Gorchestra implementation; it does not assert that the underlying agent lacks the feature. **Workspace** means implemented in the pre-existing uncommitted changes. Provider configuration can enable tools, hooks, or plugins independently of the UI; that is not counted as dedicated integration.

| Feature | Codex | Claude | OpenCode | Pi | Evidence / qualification |
| --- | --- | --- | --- | --- | --- |
| Start, resume, cancel runs | Yes | Yes | Yes | Yes | Adapter `Run` paths; Claude cancellation terminates its subprocess rather than sending an interrupt control request. OpenCode uses `session/resume`. |
| Durable history, SSE replay, queue, schedules | Yes | Yes | Yes | Yes | Shared server orchestration, not provider-native queues or schedulers. |
| Choose model | Yes | Partial | Yes | Yes | Claude UI lists only Default, Opus, Sonnet; backend accepts model strings. |
| Discover available models | Yes | No | Yes | Yes | Codex `model/list`, OpenCode `models`, Pi `get_available_models`; Claude has no `OptionsProvider`. |
| Reasoning / effort control | Yes | Yes | No | Yes | Claude already exposes low through max, including xhigh. Pi uses thinking levels. |
| Plan mode | Yes | Partial | Yes | No | Claude passes plan permission mode, but disables its interactive input channel in that mode. |
| Explicit fast-mode control | Yes | No | No | No | Codex maps to service tiers. No Claude fast setting in submitted options. |
| Tool approval cards | Yes | Yes | Yes | No | Shared `PermissionBroker`; provider-specific decisions remain distinct. Pi runs with `--no-approve`. |
| Structured clarifying-question cards | Yes | No | No | No | Only Codex calls `OpenUserInput`; OpenCode's stored broker field is not an implemented question handler. |
| Questions while work continues | Yes | No | No | No | Codex `agentMessage.delivery=async`, with acknowledged answer delivery through `turn/steer`. Committed in `f293b07`. |
| User-initiated “Send now” | Workspace | No | No | No | Only Codex registers `SteeringBroker`; the composer explicitly checks for Codex. |
| Image attachments in prompts | Yes | No | Yes | Yes | Claude `Run` explicitly rejects attachments. The other three adapters encode image input. |
| Discover and select skills in composer | Yes | No | No | No | Only Codex implements `SkillProvider`; API validation is already interface-based. |
| Clear context, retaining Gorchestra history | Yes | No | No | No | HTTP action clears the provider session ID but is restricted to Codex. |
| Manual compaction action | Yes | No | No | No | Codex `thread/compact/start`; other adapters reject non-message actions. |
| Assistant and thinking streams | Yes | Yes | Yes | Yes | Explicit normalization in each adapter. |
| Tool calls and command results | Yes | Yes | Yes | Yes | Claude returns command output at tool-result completion; this is not live stdout streaming. |
| Dedicated plan display | Yes | No | Yes | No | Codex plan items; OpenCode ACP plan entries. Claude task tools remain generic tool calls. |
| Provider file-change / diff events | Yes | Partial | Yes | Partial | Claude/Pi expose edit tools; Codex and ACP have richer dedicated change data. Shared workspace diff browsing is separate. |
| Session context meter | Yes | Partial | Yes | No | Claude uses usage events and result metadata, with a hard-coded 1M fallback; it is not an authoritative live context snapshot. |
| Reported monetary cost in dashboard | No | Yes | Yes | Partial | Claude `total_cost_usd`; OpenCode cost amount/currency. Pi preserves usage but lacks a complete mapping of its native usage/cost shape. |
| Native subagent visibility / control | Partial | Partial | Partial | Partial | Generic tool/event visibility, with Codex/Claude subagent counts; no common child-agent tree, message routing, or per-child stop controls. |
| Hook / MCP health / rate-limit UI | Partial | Partial | Partial | Partial | Some metadata and generic provider events; no complete dedicated operational surface. Some Claude system fields are dropped. |
| Fork / rewind conversation controls | No | No | No | No | Provider resume exists; branching is a separate operation. |
| Structured-output schema option | No | No | No | No | No shared request contract or result view for schema-constrained output. |
| Native persistent-goal / budget controls | No | No | No | No | Schedules and ordinary runs do not implement native goals or provider budgets. |

Source map for the matrix:

- [Shared adapter interfaces](../internal/agents/agents.go): `Agent`, `OptionsProvider`, `SkillProvider`, input/permission/steering brokers.
- [Codex adapter](../internal/agents/codex/agent.go), [normalizer](../internal/agents/codex/normalizer.go), and [async input](../internal/agents/codex/async_input.go).
- [Claude adapter](../internal/agents/claude/agent.go): `Run`, `commandWithOptions`, `interactivePermissions`, `handleControlRequest`, `execute`; [normalizer](../internal/agents/claude/normalizer.go): `normalizeSystem`, `normalizeResult`, `basePayload`.
- [OpenCode adapter](../internal/agents/opencode/agent.go) and [normalizer](../internal/agents/opencode/normalizer.go); [Pi adapter](../internal/agents/pi/agent.go) and [normalizer](../internal/agents/pi/normalizer.go).
- [HTTP session actions/options](../internal/httpapi/sessions.go), [options discovery](../internal/httpapi/agent_options.go), [skill validation](../internal/httpapi/skills.go), and [schedules](../internal/httpapi/schedules.go).
- [Composer](../web/src/components/prompt-composer.tsx), [event projection and context meters](../web/src/lib/events.ts), [question card](../web/src/components/user-input-card.tsx), and [dashboard projection](../internal/store/dashboard_projection.go).

## Recent upstream changes worth acting on

### Codex

| Release / surface | What changed | Gorchestra assessment |
| --- | --- | --- |
| 0.153.0, September 3 | Structured asynchronous questions and thread model/settings metadata | Async questions are already integrated. Reconcile effective provider settings with requested settings; current option storage alone does not show provider-side changes. |
| 0.153.1–0.153.4, September 3–4 | Astra catalog and async-question guidance updates | Dynamic model discovery and existing effort/tier controls cover much of this automatically. Verify metadata handling instead of adding another static model list. |
| 0.152.0, September 1 | Planning tool now requires explicit enablement; per-MCP-tool output limits | If we want structured task plans, deliberately configure `tools.update_plan.enabled`. Existing plan rendering does not ensure the tool is offered. Output limits are a configuration opportunity. |
| 0.150.0–0.151.0 | Cross-task mentions/messaging, interrupt hooks, MCP discovery and error improvements | Cross-task controls are a larger orchestration addition. Surface useful hook/MCP status; some underlying fixes arrive with the runtime. |
| 0.148.0, August 18 | Asynchronous/MCP hooks, session export/fork, estimated usage displays | Hooks need operational visibility; session export/fork are useful product ideas. Estimated usage should not be conflated with actual billed dollars. |

These release-specific findings come from the [official Codex changelog](https://developers.openai.com/codex/changelog). Much of the remaining work is consuming protocol features already present in the installed runtime:

| Protocol capability, checked against generated 0.153.4 schemas | Current gap | Suggested treatment |
| --- | --- | --- |
| `mcpServer/elicitation/request` | Unrecognized server requests receive `-32601` | High priority: form/URL requests need an input handler, not just a debug event. Reuse input/permission presentation, with schema-aware responses. |
| `turn/plan/updated`, `turn/diff/updated` | Saved as generic events; only item-level equivalents are normalized | Reuse OpenCode's structured plan mapping and existing change displays. |
| `item/mcpToolCall/progress`, `hook/started`, `hook/completed`, auth-recovery and review notifications | No dedicated activity mapping | Improve “what is it doing?” visibility through common status events. |
| `model/list.inputModalities`, `thread/settings/updated`, `model/rerouted` | Model structs/UI omit some capability/effective-state data | Gate attachment controls and show the model/settings actually used. |
| `account/rateLimits/read`, `account/rateLimits/updated`, `account/usage/read` | No dedicated account-capacity view | Separate account limits from per-run token/cost reporting. |
| `thread/fork`, `review/start`, turn `outputSchema` | No exposed controls | Feasible additions with shared UI/contracts; not existing cross-agent parity yet. |
| `thread/goal/*`, background-terminal list/terminate | No lifecycle/control integration | Larger work: the current adapter starts and stops a provider process per run. Goal continuation and background work must survive beyond a single result. |

The [app-server reference](https://developers.openai.com/codex/app-server) documents these surfaces. Background-terminal APIs and some fields require experimental opt-in. Plugin management RPCs are explicitly marked under development; defer a production plugin-management UI. Presence in a generated schema establishes the wire contract, not account access or successful end-to-end behavior.

### Claude

| Release / surface | What changed | Gorchestra assessment |
| --- | --- | --- |
| SDK 0.3.232 / Code 2.1.232 | Structured `context_usage` on `/context` results | Replace the approximate context meter with a proper context snapshot. |
| SDK 0.3.238–0.3.247 | Task depth/background flags, queue counts, reply correlation, ambient-task metadata | Useful for child-work tracking and reliable message attribution; current parsing does not model them. |
| SDK 0.3.257 | MCP resource links, Agent heartbeats, cheaper context-summary query | Render returned artifacts and live progress; reuse the existing event feed. |
| SDK 0.3.259–0.3.265 | More complete user-message UUID correlation and rate-limit updates | Useful prerequisites for Claude steering; a write to stdin alone must not count as confirmed delivery. |

These are versioned changes from the [official Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md). Gorchestra does not import that SDK: its Go adapter speaks the underlying CLI protocol, so SDK method availability still needs a matching wire-level implementation and contract fixture.

Claude Code [2.1.260–2.1.265](https://code.claude.com/docs/en/changelog) also adds headless plugin reload/advisor commands and fixes early interrupts, resumed tools, and working-directory persistence. Updating the runtime can supply those fixes; it does not add the missing Gorchestra controls. The local binary already advertises `--forward-subagent-text`, `--include-hook-events`, `--replay-user-messages`, `--json-schema`, `--max-budget-usd`, and `--fork-session`, none of which this adapter passes.

Current [model configuration](https://code.claude.com/docs/en/model-config) extends beyond Gorchestra's Opus/Sonnet menu. Add runtime-backed discovery where the installed protocol supports it, and allow a validated custom model ID as a fallback. Do not assume every listed upstream model is available to this account.

## Ranked opportunities to reuse existing work

Sizes describe implementation scope, not delivery estimates: **S** is a contained mapping/control change, **M** spans adapter and UI contracts, **L** changes run lifecycle. The ordering reflects user impact and confidence from this audit.

| Priority | Opportunity | Existing implementation to reuse | Size / confidence |
| --- | --- | --- | --- |
| 1 | Claude structured questions, including plan mode | Codex `UserInputBroker`, durable input events, question card, answer endpoint | M / high |
| 2 | Claude image attachments | Codex/OpenCode/Pi attachment validation, composer, persistence | M / high |
| 3 | Clear context for Claude, OpenCode, Pi | Existing provider-ID reset and preserved event history | S / high |
| 4 | Claude and Pi manual compaction | Codex action endpoint and activity lifecycle | M / high |
| 5 | Pi “Send now”; then Claude live input | Workspace `SteeringBroker`, durable receipts, composer | Pi M / high; Claude L / conditional |
| 6 | Claude skill selection and model discovery | Codex `SkillProvider` / `OptionsProvider`, generic API validation, menus | M / medium |
| 7 | Better plans and usage across agents | OpenCode plan entries; Codex context UI; Claude/OpenCode cost display | M / high |
| 8 | Claude fast mode | Codex fast-toggle UX and persisted runtime options | S–M / conditional on runtime/account support |
| 9 | Pi extension questions | Codex question UI and input lifecycle | M / high for simple dialogs |

### 1. Claude questions

Claude exposes `AskUserQuestion` through the permission callback, returning answers via `updatedInput`; it supports multiple selections. This is a confirmed capability in the [user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input).

Today `handleControlRequest` treats every `can_use_tool` request as an approval. It has no question-specific parsing or answer injection, and `streamRun` does not retain `input.UserInput`. Moreover, `interactivePermissions()` returns false in plan mode. Add question handling independently of the tool approval policy, keep tool denials intact, and extend the shared question schema/card for multi-select rather than flattening selections into one answer. Persist open/submitted/answered/failed state with the existing replay behavior.

### 2. Claude images

The [streaming-input guide](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) documents image content blocks. Enable JSON input for ordinary and plan runs, encode text plus base64 image blocks, and remove the explicit attachment rejection. Reuse validation and durable storage. Test resume plus image input and the deny/ask/bypass policies independently; images should not depend on choosing interactive approvals.

### 3–4. Context controls

Clear is mainly an application restriction: `clearSessionActionHandler` already clears the provider ID without invoking Codex. Generalize it while retaining idle-run checks and the event marker. Each adapter's next message can begin a new provider conversation. Confirm that provider-ID reset and its history marker cannot diverge on a persistence failure.

For compaction, Claude accepts `/compact` through its [headless command surface](https://code.claude.com/docs/en/agent-sdk/skills#commands-in-agent-sdk-sessions); Pi exposes an explicit [`compact` RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#compact). Make compaction an adapter action. Send a literal Claude command rather than allowing `ProviderMessage()` to prepend runtime context ahead of the slash command. Persist completion only after the provider's result/boundary confirms it. OpenCode compaction remains an ACP compatibility investigation, not a promised mapping from its separate HTTP API.

### 5. Steering

Pi's [`steer` RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#steer) accepts text/images and delivers between tool execution and the next model call. Reuse the broker and receipt state machine, but distinguish provider acceptance into a steering queue from actual model consumption. Check the installed 0.85.0 wire shape before implementing against upstream main.

Claude streaming input supports additional messages, but equivalence to Codex's active-turn steering needs a protocol test. The existing loop marks the first `result` terminal and shuts down; it must handle queued/merged turns and trailing events first. The [agent-loop guide](https://code.claude.com/docs/en/agent-sdk/agent-loop#message-types) explicitly notes events can follow a result. Scope response correlation by run/message IDs, preserve delivery uncertainty, and prevent a late message from reaching a successor run. Do not substitute stop-and-resume silently.

### 6. Skills and discovery

Claude's init metadata includes `skills` and `slash_commands`, and named skills can be invoked through commands, as documented in the [skills guide](https://code.claude.com/docs/en/agent-sdk/skills). The current parser drops those fields. Reuse the picker, but introduce a provider-owned invocation identifier: Codex's required filesystem `path` plus `$name` input is not a universal skill contract. Distinguish skills from built-in commands; respect user-invocable flags, plugin namespaces, and working-directory scope. Probe model discovery against the installed protocol before promising a no-SDK implementation.

### 7. Plans and usage

Normalize Codex `turn/plan/updated` using the existing ACP plan structure. Claude task-tool inputs could feed the same display when those tools are enabled. Plan mode and a task checklist are separate capabilities.

Claude usage/cost is already partly integrated. The current meter uses the same usage object for both `total` and `last` and falls back to a 1M context window; neither guarantees actual context occupancy. The [cost guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking) distinguishes per-turn main-loop `usage` from broader cumulative `modelUsage`. Keep current context, token consumption, monetary cost, and account allowance as separate measurements. Map Pi's preserved native usage fields before claiming dashboard parity. Codex currently has no mapped cost amount; reuse the display only when a supported source provides a monetary value, not by treating tokens or credits as dollars.

### 8–9. Fast mode and Pi questions

Claude [fast mode](https://code.claude.com/docs/en/fast-mode) can be enabled for headless sessions through `--settings` with `fastMode`. Reuse the toggle design but persist an explicit Claude option and reflect availability/cooldown. It is a research preview with provider/account restrictions and different billing semantics from Codex; do not map Codex's `priority` tier directly to Claude.

Pi's [extension UI protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md#extension-ui-protocol) supports select, confirm, input, and editor requests. Gorchestra currently logs `extension_ui_request` without responding. Start with simple dialogs through the question broker, explicitly cancel unsupported dialogs, and leave rich editors as a separate capability. A notification/widget event does not require a response.

## Useful additions that are not existing parity

| Addition | Feasibility and boundary |
| --- | --- |
| Conversation forks | Codex has `thread/fork`; Claude has [`forkSession` / `--fork-session`](https://code.claude.com/docs/en/agent-sdk/sessions#fork-to-explore-alternatives). Add parent-session lineage and a clear policy for shared versus separate workspaces. A conversation fork does not isolate files. |
| Schema-constrained results | Codex turn `outputSchema`; Claude [`outputFormat` / `--json-schema`](https://code.claude.com/docs/en/agent-sdk/structured-outputs). Add schema validation, structured result persistence, and explicit failure display as shared features. |
| File checkpoint/rewind | Claude has [file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing). Codex 0.153.4 `thread/revert` explicitly changes conversation history only. Do not present these as equivalent filesystem undo. |
| Goal/budget execution | Codex native goals and Claude [turn/spend limits](https://code.claude.com/docs/en/agent-sdk/agent-loop#turns-and-budget) solve different problems. Goal continuation requires a long-lived orchestration design; a budget is a bound on work, not a persistent objective. |
| Background-agent operations | Build one child-work model for identity, parentage, state, usage, and stop semantics. Provider events can populate it; existing top-level run completion must not discard still-running work. |
| MCP and hook operations | Start with status, progress, elicitation, and useful errors. Generic tool execution already inherits runtime configuration; installation, authentication management, and editing configuration are additional product features. |

## Implementation direction and verification

Introduce a small optional capability descriptor on adapters for images, questions, steering semantics, context actions, skills, and option discovery. Return it through the API and use it to replace provider-name checks in the composer and session actions. Keep protocol details inside adapters; retain typed events, sequence ordering, persistence before broadcast, and server-owned state.

Implement Claude input parity first, then context actions, then steering and richer monitoring. Add focused fixtures for installed and upgrade-target protocols: multi-select questions in plan mode, image resume, delayed control replies, duplicate/stale submissions, compaction without an assistant answer, merged user messages, and events arriving after a result. Preserve visible failures and no automatic resend on uncertain delivery.

This audit inspected source paths, local CLI help, and generated Codex schemas but did not run live model calls or change backend/frontend code. Documentation checks cover local links and whitespace. Full `go test ./...` plus frontend tests/build belong to the subsequent implementation changes. Reassess the matrix after the uncommitted steering work lands and after any Claude runtime upgrade.
