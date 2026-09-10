# Codex follow-up suggestions

Assistant messages can render the inline syntax observed in Codex output:

```markdown
:codex-followup[Check status]{prompt="Check the sample job status."}
```

The label becomes a button. Clicking appends the prompt to the current composer
draft, focuses the composer at the end, and retains selected skills and images.
The user can edit and submit, queue, or steer through the usual composer actions.
Clicking a suggestion does not itself send a message.

Rendering is derived from message text, so saved history gains the same buttons
on replay. User messages and code examples stay literal. Unknown directives,
missing/empty prompts, extra attributes, and suggestions inside links are not
activated. Quoted attributes use Markdown directive syntax, including character
references such as `&quot;`. This supports the observed format; it is not a claim
that Codex has published a stable directive protocol.

Validation: renderer and session/composer regression tests cover parsing,
streaming completion, inert examples, draft preservation, active runs, and
session switching. A real Codex response was checked in Chrome at desktop and
390px widths, including click-to-draft, focus, reload persistence, and confirming
that clicks neither submitted nor queued another message. All 649 frontend
tests and the production frontend build passed.
