# Remaining print fixes: implementation plan

Status: implemented, with the native-threading revision described below. Prepared from the
current uncommitted workspace on `955cb17fb4f0e0b4d896ce02c43cd3cf26446c4f`.
The initial review made no production changes. No applicable `AGENTS.md` was
found in the repository or its ancestor directories.

Implementation follow-up: the initial `canSpawnSeparateThread(false)` choice
produced twelve blank PDF pages in a fresh release build. The implementation now
uses `true`, matching Wry's asynchronous printing path. Its stateless Objective-C
delegate accepts a worker-thread callback and dispatches only the result to the
main queue; the callback retains the delegate and operation itself until it
returns, so the main-queue release does not depend on AppKit's own retention.
A review on 2026-09-06 also removed the unused `core:webview:allow-print`
grant (macOS never calls `window.print` now), narrowed the keydown guard
during invoked printing to app shortcuts, and admitted the guarded quit action
while a print is invoked: Cmd-Q is a native menu item that reaches
`guardAction`, not the keydown handler. Window close stays blocked while invoked.
Post-review packaged tests passed saving, cancellation, output-error recovery,
and quitting during real pending prints. Cmd-Q worked in the main print sheet;
inside the nested PDF save sheet the Quit menu worked, while Cmd-Q alone did
nothing in two attempts (Escape then Cmd-Q worked). This limitation is recorded
in the test matrix; a permanently hung native operation was not induced.
See `print-test-matrix.md` for actual validation; the proposal below is retained
as the reasoning that preceded implementation.

## Assessment

The proposed direction is sound, with two additions: native completion must be
observable, and an invoked operation must protect the reader from application
changes until cleanup is safe.

The production smoke test in `print-test-matrix.md` failed. The twelve-page
result belongs to an experimental dependency patch and cannot sign off the
production implementation. Its controlled comparisons support initializing
native margins before creating the operation and retaining the existing header
unmount throughout print media. They do not support removing margins, moving
spacing into document padding, or keeping the header mounted.

Current code has three independent ways to restore chrome too early:

- `createPrintCleanupController` unconditionally clears state after 30 seconds.
- The layout effect in `App.tsx` clears state on document, settings, theme,
  loading, editing, presentation, and transition changes, even after invocation.
- `afterprint` and the invocation error handler clear state without checking
  whether print media or a native operation remains active.

Changing only the timer is therefore insufficient. Merely retaining the session
also leaves the printable DOM vulnerable to a watcher reload or settings update.

## 1. Add a narrow macOS print command

Add `src-tauri/src/printing.rs`, register `print_current_webview` in `lib.rs`, and
use it only for macOS Tauri printing. Receive the invoking webview through Tauri's
injected command argument, validate that it is the local main app webview, and
operate on that same view. Accept no HTML, URL, path, webview label, margin, or
destination arguments. Retain the current `window.print()` path on Linux,
Windows, and browser development. Do not fall back to the broken macOS path
after a native error.

The locked Wry 0.55.1 already exposes `PrintOptions` and
`WebViewExtDarwin::print_with_options`. However, Tauri 2.11.5 exposes only a
parameterless print method and a native WKWebView pointer, not the owning Wry
`WebView`. Use Tauri's public `with_webview` and Apple's public APIs rather than
reconstructing Wry internals or modifying dependencies.

On the main thread:

1. Check availability, the native view/window, and an existing active operation.
   Reject duplicate native requests as well as duplicates in React.
2. Copy the shared `NSPrintInfo` into a per-operation object. Set all four margins
   to `2.0 / 2.54 * 72.0` points, approximately `56.69291338582677`, **before**
   calling `WKWebView.printOperationWithPrintInfo`. Keep `@page { margin: 2cm; }`.
   Avoid changing shared print defaults or introducing new paper settings.
3. Present the operation as a sheet on its own window with
   `runOperationModalForWindow:delegate:didRunSelector:contextInfo:`. Install a
   small completion delegate. Initially keep `canSpawnSeparateThread` false so
   operation callbacks and Objective-C ownership remain on the main thread;
   validate sheet responsiveness in the packaged smoke test. Do not use the
   application-blocking `runOperation` alternative.
4. Complete the async command through a one-shot result when the native delegate
   reports termination. Successful command dispatch alone must not resolve it.

Use target-specific `objc2`, `objc2-foundation`, `objc2-app-kit`, and
`objc2-web-kit` dependencies matching the already locked versions (0.6.4 and
0.3.2). Enable only required features, retain the existing Tauri minor series,
and avoid a dependency upgrade. Update the lockfile deliberately and check
third-party notices if the direct dependency declarations affect them.

Keep native view, window, print info, operation, and delegate ownership explicit
in a main-thread operation holder. Install the holder before presenting the
sheet; handle completion during presentation as well as later completion. Do
not send raw Objective-C pointers across threads, block the main thread waiting
for a channel, or release the delegate while its callback is executing. Release
the holder after the callback returns. Release the native busy guard on every
terminal path; dropping the frontend receiver must not drop an active delegate.

Return actionable setup errors for unavailable printing, missing window,
duplicate operations, dispatch failure, or failed operation creation. Keep any
nullable Objective-C result handling inside the small native boundary; avoid
`unwrap` on native handles. Handle expected failures as results, not panics.

The completion delegate's boolean combines cancellation and failure. Represent
it honestly as `completed` or `cancelled-or-failed`; do not announce an ordinary
Cancel as an error, and do not claim a PDF was saved or paper printed. AppKit
reports operational errors through its normal UI; the app can report definite
setup/IPC failures separately.

No new filesystem, shell, remote-origin, or general printing capability is
needed. Retain the existing scoped permissions unless an actual unused grant is
removed deliberately. Test the new custom command's caller validation directly;
the current `core:webview:allow-print` assertion covers only Tauri's built-in
bridge, not the new command.

## 2. Give every cleanup path the same lifecycle rules

Keep one session owner and the existing preparation checks. Refactor the cleanup
controller in `src/lib/print-export.ts` to distinguish preparation cancellation,
completion requests, and disposal. Wire it into `App.tsx`; add a small print
invocation adapter if needed to keep platform branching testable.

| State or signal | Required behavior |
| --- | --- |
| Preparing | Keep resource deadlines, layout settling, eager images, exact root/document ownership, duplicate protection, and the preparation Cancel button. Changes invalidate preparation immediately. |
| Native invocation pending | Keep the header unmounted and `data-printing` set. An initially false print-media query does not establish that the queued native request has ended. |
| Print media active | No timer, event, settings change, or error may restore chrome. |
| Native callback completed | Mark the operation ended; restore only once current print media is inactive. |
| `afterprint` or media-query exit | Request cleanup and recheck live state. On the macOS command path, also wait for native termination. |
| Setup/preparation failure | Announce the definite error and release the owned session once no operation/media remains active. Permit retry. |
| Stale completion or error | Ignore it; it cannot clear a newer session or show an obsolete toast. |

Subscribe once to `matchMedia("print")` changes. Preserve handling of
browser-initiated `beforeprint`, including superseding pending preparation, and
ensure the header unmount is committed before native pagination starts.

Keep 30 seconds as a recovery checkpoint, not a maximum dialog lifetime. When
cleanup is unsafe, schedule another session-owned check rather than abandoning
recovery. Recheck on media changes and return to the foreground as well. Disarm
timers and listeners after final cleanup.

Missing browser events are handled by the native completion result plus reading
the media query directly; a missed media-change event is covered by a subsequent
check. On the unchanged non-macOS invocation path, retain guarded event/media
recovery and the existing fallback when print media is inactive. A void return
or the old Tauri promise is never recorded as successful printing.

There is no safe time-based proof of completion if both native completion and
media state are unavailable or contradictory. Preserve chrome isolation in that
case; do not invent a second timeout that restores it anyway. Specifically, if
print media remains true after native completion, continue waiting for it to
clear and record any reproducible stuck state as a failed recovery test.

On unmount, invalidate preparation and remove React callbacks so late results
cannot update state or affect another mount. An already invoked native operation
retains its own lifetime until completion. Do not use component effect teardown
to declare that operation finished or clear its active-print marker. Normal
app-controlled close/quit follows the busy rules below; an OS/process teardown
cannot promise successful output.

## 3. Keep the reader stable during the invoked operation

Keep preparation cancellable by document/settings changes. After invocation,
hold the rendered reader stable through native completion and print-media exit:

- Add the active print session to file-action admission and close/quit guards.
  Block editor/presentation transitions and render-changing keyboard actions as
  well as toolbar actions. Keep native sheet Save/Cancel interaction available.
- Reuse the existing deferred reconciliation machinery for watcher, focus, and
  wake signals. Check print activity both before probing and immediately before
  adopting a probe result, including probes already running when printing began.
  Resume deferred reconciliation after safe cleanup.
- For native file opens, use the existing busy response rather than silently
  consuming an open request as though it had succeeded. A print-specific message
  should explain that the user can retry after closing the print dialog.
- Defer application of reader settings and theme changes, including late store
  hydration, until cleanup. This may require small pause/resume additions in
  `useReaderSettings` and `useTheme`; preserve their persistence and hydration
  ownership rules. Theme application must include the document-root attribute,
  since it also affects Mermaid colors.

Change the current invalidation layout effect so it cancels preparation only.
The lifecycle controller owns completion of an invoked session. Keep the same
reader and rendering engines; do not create a second print document or snapshot
renderer.

## 4. Add regressions, preserving existing safeguards

- `tests/print-export.test.cjs`: use controlled timers and media state to prove
  no cleanup while active, continued recovery after a skipped checkpoint,
  missing-event recovery, pending-invocation protection, and listener disposal.
  Retain image/font/Mermaid deadlines and animation-frame tests. Replace the
  unconditional-timeout expectation with the new conditional behavior.
- `tests/app-new-file.test.cjs`: test the actual header's absence beyond 30
  seconds; prompt completion, cancel, error and retry; missing/reordered browser
  events; old completions; document/settings changes during preparation and
  printing; an in-flight watcher result; native open, close/quit, and unmount.
  Exercise both the macOS adapter and existing browser path.
- `tests/print-css-contract.test.cjs`: retain neutral surfaces, continuous
  Markdown, Fountain breaks, and diagram colors. Add a focused check that the
  native margin constant agrees with CSS's 2 cm. Treat this only as a contract.
- `tests/tauri-capabilities.test.cjs` and Rust tests: cover command registration,
  current-webview scope, native duplicate guard release, setup failure,
  completion ownership, and no expanded capabilities. Exercise native errors
  through an injected test seam without exposing fault injection in production.
- Extend reconciliation and settings-hook tests only for the new deferral
  behavior. Preserve existing file safety, preparation cancellation, stale
  ownership, and retired print-settings regressions.

Run the focused tests during development, then `npm run test:workspace`,
`npm run build`, Rust tests, locked Cargo check, formatting/diff checks, and
applicable license checks. Do not replace native validation with those results.

## 5. Rebuild and verify native output

Build a fresh release app from the resulting production source and lockfile,
using a new isolated identifier, separate build output, synthetic documents, and
no file associations. Record source/diff identity, configuration, executable
hash, OS, and architecture. Verify that no private Wry patch or probe asset is
selected; old probe binaries and PDFs remain historical evidence.

Repeat dark and sepia 30-section Markdown with prompt saves and saves held well
beyond 30 seconds (target 50–60 seconds). Check every section, final image, end
marker, repeated page margins, diagram readability, and absence of toolbar or
texture. Inspect extracted text and rendered pages, including every page for
clipping and the final page/image. Twelve pages is the diagnostic reference for
the same fixture/settings, not a substitute for completeness checks.

Repeat native Cancel, Cancel in the PDF save sheet, retry, normal reader/focus
recovery, and Fountain title page/explicit breaks. Exercise a watcher change
during the held dialog and verify it applies only afterward. Verify definite
native setup-error recovery with the isolated test seam; record any end-to-end
error case that cannot be safely induced as unverified. Use temporary PDF saves
only; do not select physical hardware or access personal documents/settings.

Append actual implementation details and fresh results to
`docs/print-test-matrix.md`, retaining the failed production test and diagnostic
history. Update the platform status only after the new build passes. Keep
Linux, Windows, other macOS versions/architectures, physical printing, and any
unrun cases explicitly unverified.

## API references checked

- [Tauri Webview: print and with_webview](https://docs.rs/tauri/2.11.5/tauri/webview/struct.Webview.html): public native handle access runs on the main thread; native crate compatibility warrants minor-version pinning.
- [Apple WKWebView print operation](https://developer.apple.com/documentation/webkit/wkwebview/printoperation(with:)): constructs an operation from supplied print information.
- [Apple NSPrintInfo margins](https://developer.apple.com/documentation/appkit/nsprintinfo/topmargin): native margins use points.
- [Apple sheet completion callback](https://developer.apple.com/documentation/appkit/nsprintoperation/runmodal(for:delegate:didrun:contextinfo:)): reports completion, combines cancellation and failure in its boolean, and documents callback threading when separate-thread printing is enabled.
