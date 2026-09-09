# Claude questions and image input

This implements the first two priorities from the [agent feature audit](agent-feature-matrix-2026-09-09.md).

Claude runs use bidirectional `stream-json` input, including in plan mode. Text and
runtime context travel on stdin. PNG, JPEG, GIF, and WebP attachments become
base64 image content blocks; image-only prompts are supported. Images are never
put into command arguments or interpreted as filesystem paths.

`AskUserQuestion` control requests use the shared `UserInputBroker` and question
card. Single-choice questions retain their existing immediate selection behavior.
Multiple-choice questions let the user toggle several options, add free text, and
confirm explicitly. The server validates cardinality, empty answers, duplicate
selections, and option membership. Answers are mapped back to Claude using its
exact original question text, with selected labels joined by a comma and space;
the original question input and extra metadata are preserved.

The adapter keeps consuming the provider stream while a question or approval is
pending. Waiter goroutines do not emit events or write to the provider; those
operations stay in the main stream loop. Claude withdrawals close the waiter and
persist `agent.input.cancelled`. The card disappears on live updates and replay,
including bounded-history snapshots. A withdrawal racing an already-persisted
answer does not decrement another question's pending count. Stopping the run,
provider exit, and persistence failures also release waiters. Cancellation can
terminate a provider that has stopped reading a large image from stdin.

Opening stdin does not change the selected tool-permission policy. Ordinary
approval cards are offered only under the `ask` policy. Unexpected approval
callbacks under `deny` or `bypass` are denied, rather than overriding Claude's
own checks. Claude's explicit `dontAsk` mode suppresses `AskUserQuestion` before
it reaches the adapter; use the normal interactive policy or plan mode when
clarifying questions are wanted. Explicit provider deny rules remain in effect.

This change does not add Claude steering, background-agent lifecycle management,
or session compaction. The adapter still handles one Gorchestra run through its
first terminal result. Those are separate audit follow-ups.

Protocol references: [Claude user input](https://code.claude.com/docs/en/agent-sdk/user-input),
[streaming image input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
and [permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions).

Validation covers fake CLI round trips, original question and metadata retention,
multi-select and custom answers, permission decisions, plan mode, image blocks,
provider withdrawal/exit, user cancellation, blocked stdin, persistence failure,
pending-count races, and replay. Browser checks exercise desktop, 390px, and 320px
layouts, selection, free text, scrolling, and confirmation. These are synthetic
interaction checks. The installed Claude `2.1.226` binary also successfully
acknowledged a streaming initialization request with plan mode and the stdio
control channel; no user prompt was sent in that check. A real model-driven
question and image-analysis run remains a manual acceptance check.
