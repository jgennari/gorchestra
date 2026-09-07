# Browser reliability report — 2026-09-06

Status: initial production pass plus extended isolated-browser sweep completed. Eleven confirmed findings; report and proposed plan only. Application source was not changed.

Routine: [browser-testing-routine.md](browser-testing-routine.md).

## Environment and limits

- Target: `https://gorchestra.coin-triceratops.ts.net`, the persistent human server's embedded frontend.
- Repository: `5b1b84f` (`v0.8.2` versioned assets); application changes at `19873f5`.
- Served HTML SHA-256: `445e296d611a3a8c218bf0990c398a00b05e4777bfaf12756052a54992276376`, matching the assets in `19873f5`. Working-tree release HTML SHA-256: `6527dbe2c18c3b7cbaa1c98eeb6fca164e8ccc72388ebf9368dd3e71577b96d2`.
- The first production browser visit used cached `/assets/index-DSMRkKKj.js`. A subsequent ordinary reload used `/assets/index-BEl0KTB7.js`, matching the human server. B01–B06 were reproduced on that latter bundle; B07–B11 used the unchanged release frontend described below.
- Browser: real Arc on macOS, Chromium DevTools 152; existing warm profile. Desktop viewport measured 1251 px wide with DevTools docked; mobile emulation used iPhone 12 Pro dimensions, 390 × 844 CSS px.
- Native computer use drove navigation and DevTools. Console probes read DOM/layout/resource information and editor state. No Playwright suite, trace, HAR, or physical-device run was executed in this pass.
- DevTools Offline was scoped to the QA tab. In this setup `navigator.onLine` remained `true`, so the test exercised failed requests with a browser still reporting online. It did not simulate a hanging black-hole connection or an actual mobile network handoff.
- Human stack stayed healthy; no production server restart, database copy, production prompt submission, file save, release, or deployment was performed. Normal navigation can clear session attention through existing application behavior.

### Continued sweep: isolated failure injection

After the initial report, testing continued in real Arc against `http://127.0.0.1:18181`, serving the unchanged embedded release frontend (`/assets/index-D99OXKsm.js`) with synthetic API responses. The disposable fixture is `.tmp/browser-qa-20260906/fixture.ts`. It has two in-memory sessions, a request/delivery ledger, controllable stalled/502 responses and SSE disconnects, and a switchable entry-asset URL for interrupted-update testing. It never opens a database, invokes an agent, proxies to production, or sends notifications.

These tests validate browser/client behavior under controlled responses, **not** end-to-end behavior of the real Go backend. Only synthetic prompts were submitted. The fixture's same-ID deduplication is deliberately stronger than the actual API's observed metadata-only handling; it is not evidence that production supports idempotent retries.

Native Safari on macOS was also exercised against the fixture for normal load/reload and a warmed, fresh-tab launch with the fixture server stopped. This is WebKit browser evidence, not physical iOS or installed-PWA evidence. The fixture was stopped after testing; no persistent service was installed.

## Confirmed findings

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| B01 | P1 | Unsaved file edits are discarded on network loss | Dirty editor → offline chat fallback → clean original file on reconnect |
| B02 | P1 | Historical search/event links jump to the live tail | Cross-session search reproduced 2/2; direct event URL also lost its query target |
| B03 | P2 | Mobile file viewer clips Save and hides Close | At 390 px: Save extends to x=401; Close occupies x=459–491 |
| B04 | P2 | Invalid session slug silently selects another session | `/sessions/qa-session-does-not-exist` became `/sessions/life` with a usable composer |
| B05 | P2 | Offline older-history limit has no explanation | Scroller reached top=0 at a cached boundary; no unavailable-older-history notice |
| B06 | P3 | Mobile session dialog emits accessibility warning | Repeated missing-description warning when opening Sessions |
| B07 | P1 | Two tabs can silently overwrite a newer composer draft | Tab A retains old text after tab B edits; editing A and reloading loses B's text |
| B08 | P1 | Lost send acknowledgment restores an already accepted message for resubmission | Synthetic API accepted/emitted message, returned 502; retry used a new ID and accepted the same text again |
| B09 | P1 | Reload during an unaccepted pending send loses the submitted text | Saved draft immediately empty; pending row is memory-only; reload leaves neither draft nor message |
| B10 | P1 | Initial 502 leaves live updates disconnected after server recovery | Bootstrap fails before the cursor is ready; no retry/SSE until manual reload |
| B11 | P1 | Interrupted bundle update breaks the next offline launch | Cached HTML references missing new entry; offline reload produces an empty root |

P1 means fix before calling the next release a reliability release. P2 covers broken or misleading interactions; P3 is lower-impact polish/accessibility debt. No server-side loss of existing session history was established by this pass.

### B01 — unsaved editor content lost during offline transition

Reproduction (`EDIT-01`):

1. Open `/sessions/gorchestra-ui/files/README.md` online.
2. Enter Edit and add a temporary unsaved marker. Confirm Save becomes enabled and the footer says “Unsaved changes.”
3. Set the QA tab's network to Offline. The app switches from Files to Chat without asking or retaining the editor view.
4. Restore No throttling. The file returns in Preview with Save disabled and the original content.

Browser evidence: before the transition the Monaco buffer contained QA marker text and the UI was dirty. After reconnect, the rendered file had no QA marker, Monaco had zero retained models, and `saveDisabled` was `true`. Native typing split the test marker across lines; only its presence and dirty state are evidence here, not keyboard-input fidelity. The test never clicked Save.

Cause supported by source: `App.tsx:1590` forces all offline session views to `session`, unmounting Files. `workspace-files.tsx:464` keeps the draft in component state, and its cleanup at line 473 clears the dirty flag. Mounting again initializes from `file.content`.

Proposed fix: retain the editor/buffer through network transitions; disable unavailable server actions while preserving local edits. Store recoverable drafts by session + file path with a base revision, and surface conflicts if the server file changes. Define the same preservation policy for tab closure, refresh, session switching, search, and Back/Forward.

Acceptance: exact unsaved text and dirty state survive disconnect/reconnect and view transitions; server file is unchanged until an explicit save; conflicts never silently overwrite local or server content.

### B02 — event navigation overridden by automatic tail following

Reproduction (`NAV-02`, `NAV-03`):

1. Start in Jupiter and search for `offline`.
2. Choose the historical tool result in Gorchestra UI (event 137242 in this dataset).
3. Observe the historical request succeed, followed by a return to the current live turn.
4. Repeat from Jupiter: same result. Also open `/sessions/gorchestra-ui?event_seq=137242` directly; after settling the URL loses the query and the historical target is gone.

Evidence: final route `/sessions/gorchestra-ui`; `scrollTop=11380`, `scrollHeight=12224`, viewport `844`, distance from end `0`. The second search issued one `around_seq=137242` response (165,385 transfer bytes) and two identical live-tail responses (294,087 transfer bytes each). The first attempt likewise fetched the live tail twice (289,541 bytes each). This is both a navigation bug and redundant network work.

Cause supported by source: `session-detail.tsx:309` unconditionally passes `pinToLatestOnMount`. `chat-transcript.tsx:137`/`:139` initializes tail-following despite an event target; its mount effect at line 498 calls `resumeFollowing`. That function can call `onJumpToLatest` when newer history exists, and `App.tsx:832` clears the event focus and query. The focus-scroll effect competes with tail-following.

Proposed fix: make historical focus an explicit navigation intent that takes precedence over initial tail pinning. Keep it stable during hydration and incoming events. Only explicit Jump to latest or the intended submit behavior should switch modes. Avoid fetching a second live tail when one is already available or in flight.

Acceptance: same-session/cross-session search, direct links, reload, and Back/Forward retain the target; live events do not steal the viewport; each transition issues only the necessary history requests.

### B03 — mobile file controls exceed available width

Reproduction (`UI-02`): use a 390 × 844 viewport and open an editable Markdown file such as `README.md`.

Measured button bounds in CSS pixels:

| Control | Left | Right | Viewport width |
| --- | ---: | ---: | ---: |
| Preview | 164 | 252 | 390 |
| Edit | 252 | 316 | 390 |
| Save | 327 | 401 | 390 |
| Close file viewer | 459 | 491 | 390 |

The screenshot showed Save clipped and Close outside the visible panel; the filename was squeezed away. Chat's outer document width was correctly 390, so a page-level horizontal-overflow check alone would miss this.

Cause supported by source: `workspace-files.tsx:536` uses one header row; the action group at line 543 cannot shrink and contains Raw, Download, Preview/Edit, Save, size text, and Close.

Proposed fix: keep filename, Save, and Close visible; move secondary actions into a compact menu or another row at narrow widths. Preserve accessible labels and usable touch targets.

Acceptance: all essential controls fit within the actual panel at 320/390/430 px, landscape, and increased text size; each is operable without horizontal panning.

### B04 — invalid session link opens a different workspace

Reproduction (`NAV-04`): navigate to `/sessions/qa-session-does-not-exist` online.

Actual result: URL replaced with `/sessions/life`, heading “Life,” editable composer; no missing-session explanation. No message was sent. The risk is a user acting in the wrong session after following a stale or mistyped link.

Cause supported by source: `App.tsx:898` falls back to the first session when an explicit slug cannot be resolved and replaces the route at line 918.

Proposed fix: distinguish an explicit unresolved destination from an unselected root route. Show a not-found/unavailable state with deliberate navigation choices. Handle renamed aliases, archived sessions, and ambiguous slugs explicitly.

Acceptance: invalid links never enable a composer for an unrelated session; valid cached links still work offline; root fallback remains intentional.

### B05 — offline history boundary looks like the beginning of the conversation

Reproduction (`HIST-02`): warm a long session, go offline, scroll through locally available history until no older page can be loaded.

Actual result: the scroller reached top=0 with more history known to exist, but supplied no boundary-specific explanation or recovery action. The general “Showing saved history” banner remained near the composer. This can feel like the earlier history disappeared.

Cause supported by source: `use-session-events.ts:503` silently returns when an older page is absent from IndexedDB and the network is unavailable. The transcript has no distinct presentation for that state. Repeated-load churn is a risk from this control flow, not a measured CPU finding in this pass.

Proposed fix: distinguish end-of-session, end-of-local-cache, loading, and load failure. Show “Older messages aren't saved on this device” with reconnection behavior, and stop no-op load attempts until conditions change. Consider explicit per-session offline downloads separately from the normal bounded cache.

Acceptance: users can tell which boundary they reached; reconnect loads older content without a full reset; no repetitive cache-load loop at an unavailable boundary.

### B06 — mobile Sessions dialog warning

Observed console warning repeated three times during mobile drawer use:

```text
Warning: Missing `Description` or `aria-describedby={undefined}` for {DialogContent}.
```

The Sessions dialog in `App.tsx:2255` has a title but no description or explicit omission. This is a confirmed library accessibility warning, not proof that the entire dialog is unusable with a screen reader.

Proposed fix: give the dialog appropriate description semantics or explicitly omit the association; audit sibling dialogs and focus restoration.

Acceptance: no warning on repeated opening; manual keyboard and screen-reader checks still pass.

### B07 — cross-tab draft silently overwritten

Reproduction (`DRAFT-02`, release frontend + synthetic API):

1. In tab A, enter `QA draft A revision 1` for QA A.
2. Open the same session in tab B; it correctly loads that draft.
3. Replace it with `QA draft B revision 2`, reload B to verify that exact text was persisted, then close B.
4. Return to A: it still shows the older draft, without a conflict or update notice.
5. Append ` stale addition` in A and reload. The saved draft is now `QA draft A revision 1 stale addition`; B's newer draft is gone.

This was repeated after the first exploratory cross-tab attempt, with native AX observations verifying each complete input and the newer draft's own reload before the stale overwrite.

Source: `prompt-composer.tsx:184` loads the draft into component state, and line 572 saves every content change. Storage helpers at lines 2864–2896 offer no revision/conflict check; the component has no cross-tab storage listener for draft changes.

Proposed fix: define draft ownership/concurrency. Synchronize clean tabs, but preserve separate recoverable versions when two tabs edit concurrently. Do not blindly replace an actively edited draft with a storage event either.

Acceptance: the above sequence cannot silently lose either edited version; recovery works after closing/reopening tabs. This concerns tabs sharing one browser origin, not server-side draft sync across devices.

### B08 — ambiguous send can become a duplicate

Reproduction (`SEND-02`, isolated fixture only): the API appends a canonical user event carrying `client_submission_id`, broadcasts it, then responds HTTP 502 instead of a success acknowledgment. The user message is visible in history, but the composer also restores the same text with a chat error. Pressing Enter again creates a second accepted user message.

Ledger: requests at `2026-09-06T23:59:16.287Z` and `23:59:21.801Z` carried identical text, but IDs `6c1d45d7-c400-4b96-b048-6d6d02166cb9` and `74f8798c-5ae5-4fa2-8fbf-0d16d2d1eaa8`. The fixture recorded two deliveries despite deduplicating repeated IDs. Native text entry truncated the intended marker; the exact identical request bodies and visible duplicate rows, not typing fidelity, establish this finding.

Source: `session-detail.tsx:173` allocates a fresh ID on every invocation. `prompt-composer.tsx:733` restores the draft on any submit error without considering canonical acceptance. `internal/httpapi/sessions.go:1377` attaches the ID as source metadata; the handler does not use it to reject a repeated submission, and its queue path does not propagate it. Production duplicate execution was **not** induced in this audit.

Proposed fix: durable submission records with stable identity and explicit pending/accepted/rejected/unknown states. Reconcile canonical acceptance before restoring a retryable draft. Backend idempotency must cover immediate and queued submissions; merely reusing a client ID is not sufficient with the current handler.

Acceptance: lose the response before/after persistence and before/after SSE delivery; retry/reload/reconnect from each state results in exactly one intended durable submission and an understandable UI. No automatic sending of ordinary drafts.

### B09 — pending, unaccepted send disappears on reload

Reproduction (`SEND-03`, `NET-02`, isolated fixture): keep the browser online, hold API requests without a response, close SSE, enter `QA blackhole draft 001`, and submit. The fixture logs the request but deliberately does not accept or emit it.

Evidence: POST entered at `2026-09-07T00:00:31.910Z`. At `00:01:11.089Z` (39.2 seconds later), the composer remained disabled and local storage contained `{"draft":"","selectedSkills":[]}`. Reload then removed the memory-only pending row. At `00:01:29.906Z`, the marker was absent from the DOM, the composer was empty, and storage was still empty. The delivery ledger contained only B08's two earlier messages, never this one. The screenshot-free native AX and console observations were made against synthetic data.

Cause: submit clears the component draft before awaiting the request (`prompt-composer.tsx:709–717`), and the save effect persists that empty draft. The optimistic message lives only in `SessionDetail` state. Error restoration cannot recover a component destroyed by reload, and ordinary requests have no application deadline.

Proposed fix: persist an outbox/pending-submission record before clearing the draft; retain its text, options, attachments policy, identity, and uncertain status across reloads. Bound waiting and expose recovery without assuming the server rejected an unacknowledged request. Implement with B08 rather than independently adding blind retries.

Acceptance: refresh, switch session, close tab, or terminate after Enter but before acknowledgment; text remains recoverable, no phantom success is shown, and reconnect never duplicates or silently sends it.

### B10 — gateway failure at startup prevents automatic recovery

Reproduction (`NET-02`, release frontend + synthetic API): warm history, make all API endpoints return HTTP 502 HTML, then reload. The app shows cached history and `Chat issue HTTP 502`; its activity indicator says Disconnected. Entering a draft still enables Submit rather than putting the app in its offline/read-only state. Restore healthy API responses without reloading.

Evidence: bootstrap requests at `2026-09-07T00:01:57.498Z–00:01:57.500Z` all received 502. At `00:03:09.549Z`, after the server had already been restored, the browser still had only those three API requests and zero live SSE connections. Switching to QA B successfully fetched its history, including `QA background recovery marker 001`, but did not restart global activity. Manual reload restored Live. The ordinary draft survived this sequence.

Source: `fetchWithServerConnectivity` reports reachable on any HTTP response. `loadSessions` only marks unreachable for network `TypeError`, not 5xx. A failed initial snapshot leaves `activityCursorReady=false`; the SSE effect at `App.tsx:993` cannot start, while the recovery effect at line 1098 returns early because `serverReachable` is still true.

Proposed fix: give initial synchronization a recoverable failure state independent of browser-online and transport-reachable. Retry/resume safely with bounded backoff, distinguish gateway/API health from reachability, and clear stale errors when reconciliation succeeds. Define whether to disable sends or show a deliberate unavailable/uncertain action while the API is failing.

Acceptance: startup 502, HTML/non-JSON success responses, network rejection, and a hung snapshot all recover after the server becomes healthy, without reload; cache/draft remain readable and the global stream resumes exactly once.

### B11 — incomplete update replaces a working offline shell

Reproduction (`PWA-03`, real service worker + release frontend + isolated HTTP fixture):

1. Warm shell A with `/assets/index-D99OXKsm.js` fully cached.
2. Serve shell B, identical except its module URL becomes `/assets/qa-entry-b.js`; return HTTP 503 for that entry asset.
3. Reload online. The current navigation correctly runs cached A, while the worker refreshes HTML in the background.
4. Read Cache Storage: `cachedShellB=true`, `cachedEntryB=false`, while the currently running script is still A.
5. Set only this QA tab Offline and reload.

Result: blank application. Screenshot showed an empty page; console reported a rejected FetchEvent and `net::ERR_FAILED` for `/assets/qa-entry-b.js`. Read-only DOM probe returned `{"entry":"/assets/qa-entry-b.js","rootChildren":0,"bodyText":0}`. Existing A assets/history were still cached, but the worker did not use them as a fallback. No broken upgrade was induced on production.

Cause confirmed: `service-worker.js:210` writes the new cached HTML before `cacheAppShellAssets` finishes, and asset failures are swallowed. The shell pointer therefore advances even when the required entry is unavailable.

Proposed fix: stage and validate the complete required asset set before activating the shell; retain the last complete version until successful activation. Validate transitive/lazy-asset policy separately, and provide a controlled update/recovery path. Avoid deleting the last usable cache during an incomplete install.

Acceptance: interrupt each HTML/JS/CSS update boundary and offline-launch repeatedly; either A or complete B boots, never partial B. Verify this with the real service worker and a retained profile, then on installed mobile PWAs.

## Observations and risks requiring additional testing

| ID | Evidence level | Concern and proposed test |
| --- | --- | --- |
| R01 | Promoted to confirmed B11 | Interrupted entry-asset upgrade reproduced an empty offline launch on the isolated fixture. Physical mobile update/termination behavior and transitive dependency completeness remain untested. |
| R02 | Partly confirmed as B09/B10; short SSE replay pass | Hanging send and initial 502 recovery failed in the fixture. Five short SSE-only disconnect/replay cycles passed. Long network handoffs, hanging SSE establishment, and out-of-order successes/failures still require separate coverage. Distinguish server availability, synchronization, transport reconnecting, and browser connectivity. |
| R03 | External editor dependency observed; failure behavior untested | Monaco loaded from `cdn.jsdelivr.net`, including `monaco-editor@0.55.1`, despite the self-contained app packaging goal. Test first editor use with CDN blocked but Gorchestra reachable. Plan local editor assets/workers or an explicit usable fallback. |
| R04 | Cross-tab loss confirmed as B07; other storage risks untested | Local caches are bounded (50 session snapshots; persistent per-session event limit 1,000/32 MiB; global event-record budget 64 MiB, plus separate hot-window storage). Storage/persistence failures can be silent, while the offline banner says drafts stay on the device. Test quota denial, eviction, and IndexedDB upgrade blocking; report actual saved coverage and storage status. |

## What passed in this run

- Production shell, session list, existing history, composer, and workspace listing loaded online.
- Warm reload of the current build reused saved transcript data. The completed startup API set contained one provider-options, queue, files, and session-snapshot request, with no tail fetch at that observation. This is one warm case, not a proof of all request paths.
- Current-build warm navigation recorded `DOMContentLoaded` at 101 ms. Earlier cached-bundle navigation recorded 144 ms and load at 227 ms. These are local navigation timings, not p95 interaction measurements.
- Tab offline preserved visible history and disabled Send/Queue and relevant server actions.
- A temporary unsent composer draft survived offline reload, switching to another cached session and back, and navigating to the offline root URL.
- Root offline startup restored Jupiter and the cached session list; automatic reconnect returned to Live and enabled sending without submitting the draft.
- Mobile chat fit 390 px without outer-document horizontal overflow. Session drawer pins were visible without hover, and the drawer/search opened.
- Search returned results; observed request durations were approximately 986 ms then 228 ms for the repeated query. Navigation to the selected result failed as B02 describes.

### Extended fixture passes

- Background activity: with QA B selected, a new QA A event was received; returning to QA A showed both prior history and the new marker, preserving its draft.
- Five forced SSE disconnects, each followed by an event while disconnected and a 3-second observation interval, recovered. Reconnection URLs advanced `after_cursor` through 244, 245, 246, 247, and 248. Returning to the background session displayed `QA replay cycle 1` through `5` once each and in order, alongside older history. This is a short replay check, not a long soak or a byte-for-byte IndexedDB audit.
- Connection ledger showed one active stream after the first four cycles. The fifth showed two because a Safari client was opened during that interval; subsequent inspection showed two streams for two clients, not duplicate streams in one client.
- Safari loaded the release frontend, history, and Live state; its exact `QA Safari persisted draft` survived reload.
- With only the disposable fixture process stopped, Safari reload retained history and draft, displayed the offline banner, and disabled Send/Queue. Closing that QA tab and opening the root URL in a new tab still restored QA A, older history plus all replay markers, and the exact draft. The browser itself was not terminated.
- After the interrupted-update test, restoring asset availability and normal networking allowed online reload to recover. A later Arc reload with the fixture stopped booted the now-complete saved shell/history successfully. This recovery does not excuse B11's unusable interval.

### Coverage ledger for this sweep

| Scenario group | Result and limits |
| --- | --- |
| BOOT-01/02/03, NET-01 | Warm production Arc passed; fixture Safari load/reload and fresh-tab warm-offline root passed. No fresh browser profile or OS process termination. |
| NAV-01/02/03/04 | Basic switching passed; historical focus and invalid-slug cases failed B02/B04. Renamed/archived/ambiguous route variants and exhaustive Back/Forward remain open. |
| HIST-01/02/03 | History visible across switching and short replay; offline boundary failed B05. Full sequence/anchor audit and cache-pressure cases remain open. |
| DRAFT-01/02 | Ordinary per-session draft persistence passed; cross-tab conflict failed B07. |
| EDIT-01 | Offline transition failed B01. Other dirty-navigation, termination, and save-conflict cases remain open. |
| SEND-02/03 | Lost acknowledgment and unaccepted pending reload failed B08/B09, isolated fixture only. |
| NET-02/03 | Initial 502 recovery failed B10; hanging send failed B09; five SSE-only replay cycles passed. |
| PWA-02/03 | Old/current cached builds observed; interrupted entry-asset update failed B11; online recovery verified. |
| UI-01/02, A11Y-01 | Limited 390-px smoke; file toolbar failed B03 and session-dialog warning B06. Not a complete keyboard/screen-reader audit. |

## Coverage not completed

Physical installed iOS/Android PWA launches, actual mobile keyboards/IME, OS termination/storage eviction, fresh-profile behavior, long-duration background/soak tests, storage quota/upgrade failures, CDN-blocked editor startup, and queue/cancel/double-send races remain NOT RUN. Safari coverage is limited to the fixture smoke above. Out-of-order HTTP completion and the complete sequence/virtual-scroll anchor matrix remain open. Existing frontend/Go tests were not rerun because this task changed no application source; prior release checks do not count as browser evidence for these cases.

A disposable, manually driven synthetic HTTP fixture was implemented locally for the extended investigation. No permanent fake-agent Go server, Playwright suite, CI job, or scheduled browser automation was added. The routine documents how to build those without depending on production sessions or copied notification state.

## Proposed implementation order

### Stage 0 — durable reproduction foundation

- [x] Prototype a disposable synthetic HTTP fixture and request ledger for safe manual failure injection.
- [ ] Turn the prototype into a reproducible test fixture using actual Go API/storage plus fake adapters and no external notifications/schedules.
- [ ] Add browser regression coverage for B01/B02/B04 and B07–B11 before implementation; preserve failure traces with sanitized fixture data.
- [ ] Add a request ledger, event-sequence assertions, and separate persistent-profile service-worker tests.

Exit: the important failures reproduce deterministically against the embedded build; test runs cannot invoke real agents or send production notifications.

### Stage 1 — preserve work and navigation intent

- [ ] Fix B01: durable file drafts and explicit conflict handling; prevent offline fallback from destroying unsaved state.
- [ ] Fix B08/B09 together: recoverable pending submissions, canonical-acceptance reconciliation, and server-backed idempotency including queues.
- [ ] Fix B07: cross-tab draft versioning/ownership and explicit conflict recovery.
- [ ] Fix B02: historical navigation wins over initial tail-following; remove the redundant tail request.
- [ ] Fix B04: unavailable session routes cannot silently select another workspace.
- [ ] Extend tests to dirty-file search/session/Back transitions and direct historical links during streaming.

Exit: no lost drafts/pending submissions, duplicate intended sends, or silent wrong-destination navigation in the tested transitions; historical event focus and request counts pass in Chromium and WebKit.

### Stage 2 — strengthen offline and upgrade behavior

- [x] Reproduce incomplete shell activation (B11) and failed initial synchronization recovery (B10) under controlled failures.
- [ ] Fix B11: atomic complete-shell activation with a known-good fallback.
- [ ] Fix B10 and remaining R02 cases: bounded waiting, recoverable bootstrap/synchronization, and accurate connectivity state.
- [ ] Fix B05 with explicit cache-boundary state and recovery.
- [ ] Address R03 external editor loading and R04 storage/coverage visibility as confirmed by regression tests.
- [ ] Extend the B08/B09 acceptance-loss regression to backend persistence/queue races, attachment recovery, tab closure, and app termination.

Exit: interruption at each upgrade stage leaves a usable shell; cached work survives server hangs/flaps; missing local data is clearly explained; no unexpected send on reconnect.

### Stage 3 — mobile polish and ongoing gates

- [ ] Fix B03/B06 and audit mobile options, dialogs, focus, and nested overflow.
- [ ] Run the physical PWA/keyboard/background suite and a 30–60 minute multi-client soak.
- [ ] Integrate deterministic regression and read-only production smoke as separate CI/release jobs.
- [ ] Publish a follow-up report marking each finding fixed/remaining with the exact deployed and browser-loaded build.

Exit: supported mobile sizes and physical-device flows pass; no missing/duplicate durable events, unbounded resource growth, or unresolved P1 findings in the reliability suite.

## Cleanup

The temporary composer draft was removed and verified absent from stored composer drafts. The file test was never saved; the observed bug discarded its unsaved buffer. Network throttling was restored to No throttling and mobile emulation was returned to the original scale and disabled. Only report/routine documentation is intended to remain in the repository.

Extended sweep cleanup: both Arc and Safari QA drafts were cleared through their composers, and only QA tabs were closed. Arc's normal-network setting was restored before testing server stoppage. The disposable fixture process was terminated (exit 130), not the human stack. Its ignored diagnostic script remains locally for reference; synthetic messages existed only in fixture memory and local browser caches. No user site data or caches were cleared. The human LaunchAgent was rechecked healthy, and the only tracked-scope additions are these two documentation files.
