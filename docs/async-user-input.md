# Asynchronous agent questions

Codex can emit `item/completed` with an `agentMessage` whose `delivery` is
`async` and whose `questions` contain titles and optional string choices.
Gorchestra normalizes this to `agent.input.requested`, reusing `UserInputCard`
and the existing answer endpoint. These questions do not pause activity indicators
or replace the composer's draft/Queue action. Free-text answers remain available.

The optional provider-agnostic `AsyncUserInputBroker` registers a delivery
callback. The Codex callback sends `turn/steer` with the original `threadId` and
`expectedTurnId`; the normal event reader routes its acknowledgement while tools
and messages continue streaming. A finished or cancelled run closes its requests.

Answer lifecycle:

- Claim the request so competing clients cannot submit it twice.
- Persist `agent.input.submitted` before delivering an asynchronous answer.
- Persist `agent.input.answered` only after provider acknowledgement.
- On unconfirmed delivery, persist `agent.input.failed`; do not automatically
  resend, because the provider may already have received the answer.
- The older blocking question flow keeps its existing wait-and-answer behavior.

History responses include a separate `input_events` control snapshot, at the
page's server sequence watermark. This lets a new client restore unanswered
questions from long turns without downloading the entire transcript. The client
retains controls independently of bounded history and keeps resolution tombstones
to prevent a racing history response from resurrecting answered questions.

Coverage includes fake app-server steering, ongoing streaming, stale turns,
competing answers, persistence failures, cancellation, bounded-history replay,
existing card choices/free text, and composer draft preservation. Browser QA uses
synthetic sessions; physical iOS and a live model round-trip remain manual checks.
