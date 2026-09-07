# Browser reliability implementation

Scope: fix confirmed B01–B11 from [the audit](browser-testing-report-2026-09-06.md). No production restaging, commit, push, or release requested. Preserve the original audit as evidence; record implementation and validation here.

## Work sequence

- [x] B11: atomic service-worker shell promotion; failed assets retain the working shell; regression tests.
- [x] B10: bounded requests and recoverable bootstrap/502 state; regression tests.
- [x] B02/B04/B05/B06: historical navigation intent, unresolved destinations, offline history boundary, accessible mobile dialog.
- [x] B01/B03: preserve file edits across network/view changes and make mobile file actions fit.
- [x] B07: recoverable cross-tab drafts with explicit conflict handling.
- [x] B08/B09: persist pending sends before clearing composer; stable identity and canonical reconciliation; server deduplication for immediate and queued submissions; no automatic send retries.
- [x] Run focused regressions, full frontend tests/lint/build, and `go test ./...`.
- [x] Repeat safe browser fault cases against an isolated build/fixture; update validation notes.

Physical installed-PWA, OS termination, and long soak coverage remain distinct from desktop browser/automated checks. Do not mark those complete without running them. Keep fixture traffic away from human data and agents.

## Progress / handoff

Implementation started from `5b1b84f`; only the two audit documents were untracked. No pre-existing application changes.

Implementation and the scoped validation pass are complete. Full frontend suite: 493 tests passed across 44 files. Frontend lint and build passed (existing large-chunk build warning remains). `go test ./...` and `go test -race ./internal/httpapi ./internal/store` passed. Focused tests include concurrent duplicate immediate/queued requests, persisted reservations across reopening SQLite, canonical acceptance reconciliation, storage failure before composer clearing, exact-ID recovery/retry, cross-tab draft recovery, offline file retention, initial 502 recovery, historical focus, unavailable slugs, offline history boundaries, and interrupted shell updates.

New migration 024 stores submission identities/receipts. Unknown reservations deliberately block retransmission if a handler crashes in the acceptance window; a canonical event/queue row can resolve acceptance. This prevents automatic duplicate work but is not a guarantee of exactly-once execution across arbitrary provider failures. Requests without an identity keep the legacy API behavior. No automatic message retry was added.

File drafts use a saved base and compare-before-write check. The Go mutex coordinates app-originated writes, not external editors/processes. Cross-tab composer versions are recoverable copies, not collaborative editing; users can explicitly choose or discard a copy. Offline support remains bounded to cached history/assets, not every unvisited session, attachment, or lazy feature.

Browser recheck uses `.tmp/browser-qa-20260906/fixture.ts` on localhost 18182, serving `web/dist`; it does not access human data or invoke agents. Production assets have not been staged.

## Real-browser recheck (Arc / Chromium, September 6)

| Case | Observed result |
| --- | --- |
| B02 historical link | Initial recheck exposed a second native `scroll`/`scrollend` path that still snapped to the tail. Fixed it and added native-event regression coverage. Retest retained `?event_seq=40` and response 20 through an incoming live event. Request ledger showed one around-target and one live-tail request, not the previous duplicate tail. |
| B08 lost acknowledgment | Fixture emitted/persisted a synthetic message, then returned 502. Browser showed one canonical message, blank composer, and no lingering recovery entry. Ledger: one POST and one delivery. |
| B09 unreceived pending send | Fixture held requests before acceptance. Reload restored the exact pending request in the recovery panel, with no automatic resend. After recovery, explicit Retry safely used the same ID observed in the earlier status-check URL. Only one delivery occurred. |
| B10 unavailable bootstrap/recovery | Reload under API 502 preserved saved content and disabled server actions. Restoring normal responses recovered the live connection and Save without another reload. A stalled request/reload also recovered without a manual reload. The 30-second deadline is covered directly by automated tests. |
| B01 file edit | Dirty file remained mounted on failed requests; reload under API 502 restored the local draft and Unsaved changes, with Save disabled. Reconnect enabled Save without discarding it. Native typing produced a shortened marker; browser evidence is retention of that actual stored marker, while automated tests verify exact text preservation. No file save was performed. |
| B03 mobile actions | At 390 px, Save x=278–353, Close x=337–373 on a separate row. At 320 px, Save wrapped to x=21–95, Close x=267–303; all controls remained inside the viewport. |
| B06 mobile dialog | Opened Sessions in the narrow offline view; no missing-description warning. Expected connection-refused messages were present. |
| B11 interrupted shell update | Fixture advertised a new entry and returned 503 for that entry. Cached HTML stayed on the complete `/assets/index-CGslHHOs.js`, not the unavailable replacement. Stopped the fixture entirely, then reloaded: app and local file draft rendered, offline notice appeared, Save stayed disabled. |

B04/B05/B07 were regression-tested automatically; their full manual audit routines were not repeated in this pass. Browser-tested bundle was `index-CGslHHOs.js`; the final build is `index-B0DFKioe.js` after preserving cancellation errors/causes in the API wrapper. All final application changes passed build/lint; the full frontend suite was rerun after cancellation handling, with only error-cause metadata added afterward.

Monaco emitted clipboard-focus/cancellation errors during native automated typing with DevTools focused. Treat these as a separate automation/Monaco follow-up, not evidence of a successful clean-console run. No physical phone, installed PWA, process-kill stress test, or long-duration soak was run. Monaco/lazy assets not already cached can still require network access.

Cleanup: fixture stopped; localhost 18182 has no listener. Device preset restored to iPhone 12 Pro, emulation turned off, throttling unchanged at No throttling, DevTools and only the QA tab closed. Human stack health checked afterward; healthy, no manual restart/restage. No commit/push/release performed.
