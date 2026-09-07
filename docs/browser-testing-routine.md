# Browser reliability testing routine

Status: proposed durable routine; initial production exploration and extended synthetic failure-injection sweep completed. No application fixes implemented. See the dated report for observed results versus remaining coverage.

Created: 2026-09-06. Initial findings and implementation order: [2026-09-06 report](browser-testing-report-2026-09-06.md).

## What a reliable client must do

- A session link must open that session. An event link must keep the requested event visible until the user deliberately moves away.
- Server events remain canonical. Cached history, selected session, drafts, and scroll position must survive the transitions that the UI promises to support.
- Losing connectivity must preserve user work and clearly distinguish saved content, unavailable content, stale status, and uncertain message delivery.
- Reconnection must reconcile missed activity without missing or duplicating durable events, replacing newer state with older responses, or sending an unsent draft.
- A warmed installed app must open offline. A failed update must leave the previous usable application available.
- Every essential control must remain visible and operable on supported screen sizes and with keyboard navigation.

Offline access is bounded by what the device has saved. Unvisited sessions, uncached older pages, full tool outputs, attachments, workspace files, and server search cannot be assumed available. Make each boundary understandable; never imply that missing cached content has been deleted from the server.

## Execution lanes and cadence

| Lane | When | Environment | Scope |
| --- | --- | --- | --- |
| Production smoke | After a promoted build; before calling a release verified | Separate browser tab on the human built-frontend URL | Read/navigate, warm offline/reconnect, temporary unsent drafts, visual inspection |
| Deterministic regression | Every change affecting client state, routing, storage, or streaming | Isolated server with synthetic fixtures and a fake agent | Sends, queues, cancellation, edits, failure injection, sequence assertions |
| Release durability pass | Before release; include upgrade from previous release | Persistent browser profile against isolated built application | Cold/warm caches, interrupted updates, offline launches, storage failures, multiple tabs |
| Device and soak pass | Before declaring mobile/PWA reliability; then periodically and after relevant changes | Physical devices plus isolated active sessions | Keyboard, backgrounding, app termination, network handoffs, long-running activity |

Suggested cadence: a short smoke on every promotion, the automated regression lane in CI, and a 30–60 minute device/soak pass for release candidates. These are proposed jobs, not installed automation or scheduled tasks.

## Preparation and cleanup

1. Read `AGENTS.md`. Run `bun run dev:human:status`; use the healthy existing stack.
2. Record source commit, deployed HTML hash, browser-loaded entry asset, service-worker control, browser engine, viewport, and cache state. The release tag alone does not prove which code a cached client is executing.
3. Use `https://gorchestra.coin-triceratops.ts.net` for embedded-asset and PWA checks. Vite/HMR is not a substitute for the production caching path.
4. Open a separate QA tab. Record the original DevTools network/device settings and whether the selected session has a draft. Preserve pre-existing user drafts.
5. Production allows browsing and temporary unsaved markers. Avoid sending prompts, cancelling real runs, changing settings/pins, saving files, altering schedules, triggering notifications, clearing site data, or restarting the human stack. Ordinary navigation may update the application's read/attention state.
6. Inject failures at the QA browser/isolated-server boundary. Do not disconnect the host network or stop production. For physical device network changes, keep the device and test scope explicit.
7. Use a fresh synthetic database for isolated tests. Never start another server on `.tmp/human/sessions.db`, and do not boot a copied production database: copied running rows, push subscriptions, schedules, and credentials can cause real side effects. Use fake adapters, disposable workspace files, and a local notification sink with outbound actions disabled.
8. Restore throttling/device settings, remove only QA-created draft text, and close QA tabs. Verify the repository has no unintended source/file edits. Redact transcript contents, cookies, authorization data, and private paths from any exported evidence.

## Repeatable scenario matrix

Use a fresh profile for cold-cache cases and an intentionally retained profile for warm/upgrade cases. Do not clear caches between steps of a persistence test. Mark every case PASS, FAIL, BLOCKED, or NOT RUN with a build identifier.

| ID | Scenario and actions | Required observation | Lane |
| --- | --- | --- | --- |
| BOOT-01 | Load root and a session URL from a fresh profile online | Useful shell, correct session, readable history, no uncaught startup error | Regression/release |
| BOOT-02 | Reload a warmed session | Saved content appears promptly; current server state reconciles; no history rollback | Smoke |
| BOOT-03 | Open root offline after visiting two sessions | Shell opens; last saved selection, session list, and available history remain usable | Smoke |
| BOOT-04 | First-ever visit with no network | Honest browser/app unavailability; do not claim an uninstalled shell can work offline | Release |
| NAV-01 | Switch idle → running → idle session repeatedly | Correct title, transcript, workspace, controls, and draft for every selection | Smoke |
| NAV-02 | Choose an old search result in the same and in another session | Correct event remains visible/highlighted, including after more stream activity | Smoke/regression |
| NAV-03 | Load/reload `?event_seq=N`; use Back/Forward | Target and URL survive mounting/hydration; explicit Jump to latest alone clears event focus | Smoke/regression |
| NAV-04 | Invalid, renamed, archived, and duplicate-title session links | Resolve unambiguously or show an explicit unavailable state; never silently select another workspace | Regression/release |
| HIST-01 | Scroll backward through multiple pages, then forward | No missing/duplicate messages or large anchor jumps; older and live windows remain distinct | Smoke/regression |
| HIST-02 | Stop at an uncached older-history boundary offline | Explain the local limit; no endless loading or repeated no-op cache reads | Smoke |
| HIST-03 | Receive activity in an unselected session; select it | Saved history plus new activity, not only the most recent turn | Regression |
| HIST-04 | Exceed memory/cache limits, switch away and return | Rehydrate/reconcile correctly; bounded storage does not masquerade as complete history | Regression/release |
| DRAFT-01 | Type, switch sessions, return, reload offline | Exact text preserved; draft stays associated with the correct session | Smoke |
| DRAFT-02 | Edit one session from two tabs; close/reopen one | Defined conflict behavior; no silent replacement of the newer draft | Regression/release |
| DRAFT-03 | Paste multiline text, compose with IME, hold Enter | Correct newline/composition behavior; no accidental or duplicate sends | Regression/device |
| EDIT-01 | Edit a disposable file; lose/recover connectivity | Editor buffer and dirty state survive; no automatic save or silent discard | Regression; unsaved-only production probe |
| EDIT-02 | Dirty file → session switch, search jump, Back, close, reload | Explicit preservation/discard policy; recovery after app termination where promised | Regression/release |
| SEND-01 | Submit normally and double-submit with keyboard/button | Immediate optimistic feedback; exactly one durable message per intended send | Regression |
| SEND-02 | Server accepts message but response is lost | Show uncertain delivery and reconcile by a stable request identity; no blind resend | Regression |
| SEND-03 | Disconnect before acceptance; reconnect | Preserve recoverable text; no unsolicited send on reconnect | Regression |
| SEND-04 | Queue while running; remove queue item; cancel while events race | Accurate queue/status; no resurrected item, duplicate run, or hidden failure | Regression |
| NET-01 | Tab offline → reload → online | Saved history/draft usable; sending unavailable; recovery without manual reload | Smoke |
| NET-02 | Browser reports online while server requests fail, hang, return 502, or return HTML | Bounded waiting, accurate unavailable state, readable cache, understandable recovery | Regression/release |
| NET-03 | Break only SSE, then restore; overflow replay window | Cursor-based recovery/resync; correct durable sequence set; one current SSE connection per client | Regression |
| NET-04 | Repeated network flaps with delayed/out-of-order responses | No old response overwrites newer state; bounded retries/connections and stable drafts | Regression/soak |
| PWA-01 | Warm installed PWA, close/terminate, reopen offline | Shell and saved history work without relying on an already open page | Physical device/release |
| PWA-02 | Warm release A; deploy B; visit/reload | Update is discoverable and reaches a coherent new bundle without reload guessing | Release |
| PWA-03 | Interrupt upgrade after HTML but before JS/CSS; then open offline | Previous complete shell still works; no cached HTML pointing to missing entry assets | Release |
| PWA-04 | Cold-open lazy editor/diagram/tool content with CDN or asset unavailable | Usable local feature or bounded error/fallback; no indefinite blank/loading pane | Release |
| STORE-01 | Deny/quota-limit storage or interrupt IndexedDB writes | UI reports inability to save locally; server history still recoverable; no false “saved” promise | Regression/release |
| STORE-02 | Upgrade IndexedDB with another old-version tab open | No indefinite startup block; clear prompt or safe compatibility path | Release |
| UI-01 | Chat at 320, 390, 430, 768, 1024 px and narrow desktop panes | No essential control outside its usable container; titles/drafts remain readable | Regression/device |
| UI-02 | Mobile drawer, search, composer options, files, schedules, settings | Close/Save/Send remain reachable; pins need no hover; menus stay within viewport | Smoke/device |
| UI-03 | Real keyboard open/close, rotation, safe-area changes, text enlargement | Composer and active controls remain visible; no accidental jump/send | Physical device |
| A11Y-01 | Keyboard-only navigation, focus restore, Escape, screen reader dialogs | Named controls/dialogs; focus stays usable; no orphaned focus after view changes | Regression/device |
| SOAK-01 | Background 30 s, 5 min, 30 min during deterministic activity; resume | Full correct projection, catch-up completed, sensible stale/live status | Soak/device |
| SOAK-02 | Two clients watch different sessions for 30–60 min, switch and reconnect | No dropped/duplicate durable events; bounded heap/listeners/cache; no sustained retry storm | Soak |

## Evidence and measurement

For a failure, record: scenario ID; build/entry asset; browser/cache/network state; exact actions; expected/actual result; reproduction count; sanitized screenshot or trace reference; likely source location; impact; proposed fix; and an acceptance test. Keep browser-confirmed observations separate from code-review hypotheses.

Measure the interactions users feel: time to visible cached history, time to editable composer, Enter-to-optimistic-message, reconnect-to-current-history, and preservation of the visible event while scrolling. `DOMContentLoaded` alone is not an interaction or durability result.

Inspect API requests by endpoint/method/status/duration/bytes, and concurrent open SSE connections. Historical completed streams in a preserved network log are not concurrent connections. When sharing measurements, omit session payloads and private query text.

Read-only DevTools examples:

```js
// Which bundle is this tab actually running?
console.log({
  entry: document.querySelector('script[type="module"]')?.getAttribute('src'),
  worker: navigator.serviceWorker.controller?.scriptURL,
  browserOnline: navigator.onLine,
  viewport: [innerWidth, innerHeight],
});

// A valid outer page width does not prove every nested toolbar fits.
console.table([...document.querySelectorAll('[role="region"] header button')].map(b => ({
  name: b.getAttribute('aria-label') || b.textContent.trim(),
  left: Math.round(b.getBoundingClientRect().left),
  right: Math.round(b.getBoundingClientRect().right),
  viewport: innerWidth,
})));
```

Suggested acceptance budgets, to calibrate on fixed hardware/fixtures before enforcing in CI:

- Warm cached history visible within 1 s on the desktop fixture and 2 s on the reference mobile device.
- Optimistic submitted text appears within 100 ms of the completed user action; network acknowledgment is measured separately.
- Known-good connectivity recovery reconciles within 10 s without losing the draft or historical anchor.
- Zero unexplained duplicate history requests for one navigation; at most one open global SSE per tab after settling.
- Zero unhandled application exceptions in supported flows. Expected injected network errors are tagged separately.
- Memory/storage remain within configured bounds; compare start/end and intermediate samples rather than assuming no leaks from a single heap snapshot.

These are proposed gates. The first exploratory run did not establish p95 latency or long-duration memory behavior.

## Local diagnostic fixture used in the initial investigation

The extended September 6 sweep used `.tmp/browser-qa-20260906/fixture.ts` with the unchanged embedded release assets on `127.0.0.1:18181`. This is an ignored, disposable prototype—not committed automation or a substitute for the real Go API. It holds two synthetic sessions in memory and has no database, agents, schedules, push delivery, or upstream proxy.

Start it only after checking that its port is unused:

```sh
lsof -nP -iTCP:18181 -sTCP:LISTEN
bun .tmp/browser-qa-20260906/fixture.ts
```

Read `/__qa/state` for the request/delivery ledger. POST JSON to `/__qa/control` for these bounded fault cases:

| Control | Use |
| --- | --- |
| `{"api":"hang","disconnect":true}` | Hold API requests without accepting messages; terminate current fixture streams. Reload while a synthetic send is pending. |
| `{"api":"502","disconnect":true}` | Return gateway HTML from all API calls; reload and check initial synchronization recovery. |
| `{"api":"normal"}` | Restore normal API behavior and release held responses as explicit 503 errors. |
| `{"send":"accept-502"}` | Accept and emit a synthetic message, but lose its success acknowledgment; inspect retry identity and canonical reconciliation. |
| `{"send":"normal"}` | Restore ordinary synthetic submission behavior. |
| `{"disconnect":true,"emit":{"session":"sess_qa_a","text":"QA replay cycle 1"}}` | Emit while streams are disconnected; inspect cursor-based catch-up from another selected session. |
| `{"shell":"b","blockB":true}` | Serve HTML pointing to a new entry URL whose asset fails. Warm A first, refresh online, then reload the QA tab offline without clearing caches. |
| `{"shell":"a","blockB":false}` | Restore original HTML and asset availability for online recovery. |

Do not send these controls to a production origin. The prototype deduplicates identical submission IDs for diagnostic clarity, but the current real API does not establish equivalent idempotency. A same-ID prototype pass would therefore not prove safe production retries. Record that distinction in every result. Stop only the fixture's own process when done; do not stop or restart the human stack.

The script is not portable durable test infrastructure yet. Stage 0 in the report promotes its useful cases into a checked-in, deterministic harness with explicit isolation and reproducible browser traces. No automated/scheduled execution has been installed.

## Proposed automation implementation

Start with a Playwright suite using Chromium and WebKit against the embedded production build. Use a synthetic Go test server/fake adapter with deterministic event sequences and disposable workspaces. Preserve one browser profile across upgrade tests, while keeping ordinary cases isolated. Add a separate restricted production smoke lane that cannot invoke prompt/file/schedule/notification mutations.

Fixtures should cover empty/short/large histories, a running background session, queued work and permissions, long output with deferred blobs, images/Markdown/diagrams, overlapping session titles, renamed/archived sessions, and dirty files. Pin expected durable sequence IDs and explicit cache coverage; do not assert that every event must exist in a virtualized DOM simultaneously.

Use browser/context failure injection plus a controlled proxy for dropped responses, hanging requests, intermittent 502s, and mid-stream disconnects. Preserve the real service worker for PWA tests: routing/mocking must not accidentally bypass it. Use deterministic fake-agent activity for race/soak tests, never real maintenance prompts or copied production sessions.

Capture traces/screenshots and a sanitized request ledger on failure. Keep service-worker upgrade, IndexedDB persistence, and physical mobile tests as explicit jobs; a jsdom suite or a resized Chromium viewport cannot validate those promises alone.

## Completion and release gate

1. Re-read this routine and the current findings after compaction or a handoff.
2. Record exactly which scenarios ran on which build; retain NOT RUN/BLOCKED entries.
3. Prioritize loss of unsaved work, wrong-session navigation, missing durable events, duplicate sends, and unusable offline launches as release blockers for a reliability release.
4. Reproduce each fix with the original steps and a focused regression before broader smoke testing.
5. Require physical installed-PWA evidence before claiming mobile cold-offline, keyboard, or background-termination coverage.
6. Save a dated report and update finding statuses; do not turn an isolated passing test into a blanket “all good.”
