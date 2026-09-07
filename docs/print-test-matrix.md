# Print Test Matrix

Use this checklist when validating Bindars printing and PDF export changes,
and run the relevant platform checks on a release candidate. Record the app
commit/build, OS version, architecture, and results separately. An unchecked
entry is unverified; this checklist is not a record of passing tests.

## Review follow-up — 2026-09-06

Removed the remaining `body[data-printing]` conditions from the neutral surface
rules inside `@media print`. White backgrounds, black text, and reading-surface
texture removal now apply even after the temporary print session is cleared,
including by the 30-second fallback. The separate chrome-hiding rule outside
print media remains in place for WebKit2GTK.

Updated the CSS contract test to check declarations on the unconditional root
and reading-surface selectors, including texture removal on the reading surface
itself. This verifies the stylesheet contract, not native dialog timing or PDF
appearance. The subsequent macOS smoke test below found remaining failures.

Validation for this follow-up: all 21 tests in
`node --test tests/print-css-contract.test.cjs` passed; `npm run build` passed
with the existing large-chunk warning; `git diff --check` passed.

## macOS packaged smoke test — 2026-09-06

Tested the current uncommitted changes on top of `955cb17fb4f0e0b4d896ce02c43cd3cf26446c4f`,
version 1.4.3, on macOS 26.6.2 (25G83), arm64, using WKWebView. Built a release
app with a separate test identifier and no file associations; used only synthetic
documents. No physical print job was submitted (no printer was selected).

**Result: failed overall. Do not treat the automated checks as print-output sign-off.**

| Check | Observed result |
| --- | --- |
| Native dialog and cancel | Passed. Controls were restored at the first observation after cancellation, about 15 seconds after the print request, before the 30-second fallback. |
| Dark Markdown, delayed save | Failed. Save sheet held about 48 seconds. White background and readable Mermaid diagram, but the app toolbar appears on page 1. The 9-page PDF ends partway through section 24 of 30. |
| Sepia Markdown, delayed save | Failed. Save sheet held about 38 seconds. Same toolbar and truncation failures; the page remains white without the sepia texture. |
| Sepia Markdown, prompt save | Failed. Save clicked about 26 seconds after the print request. Toolbar absent, but the 9-page PDF still ends in section 24. Truncation is not limited to the long-wait case. |
| Image near the end of the unscrolled Markdown document | Not verified independently. The PDF omits the final image and end marker along with the document tail; this does not establish whether lazy-image loading itself failed. |
| Dark Fountain, prompt save | Passed for this fixture. Three pages: title alone, first scene, then second scene after the explicit break. Final marker present, white background, readable text, no toolbar. |
| Recovery after PDF saves | Passed for the tested saves. Reader controls returned. |

Inspected rendered PDF pages and extracted text. The Markdown fixture has 30
numbered sections, a Mermaid diagram, formatting/table/code samples, and a final
image and end marker. Both long-wait PDFs include toolbar text; all three
Markdown PDFs omit sections 25–30 and the final marker. These are observed
failures in this build; the investigation below isolates their triggers. Whether
they predate the simplification has not been established. Fix and repeat these cases before
sign-off. Linux, Windows, other macOS versions, physical printing, and the
remaining checklist cases are unverified.

Local evidence is retained in the ignored `test-fixtures/print-20260906-o0gx0tqp/`
directory (`dark-held.pdf`, `sepia-held.pdf`, `sepia-quick.pdf`,
`fountain-dark.pdf`, and input files). Build details and executable hash are in
the ignored `.tmp/print-native-evidence.json`; build output is in
`.tmp/print-native-build.log`.

## Native investigation — 2026-09-06

Used temporary diagnostic assets and an isolated app; production source and
dependency configuration were not changed by these experiments.

**Truncation:** the standard Wry macOS path initializes native print margins to
zero, while the stylesheet requests `@page { margin: 2cm; }`. Changing only the
CSS margin to zero preserved all 30 sections and the final image in nine pages.
Keeping the original CSS and initializing native margins to the matching 2 cm
before creating the print operation produced twelve complete pages with normal
page margins. This isolates a native/CSS margin mismatch in pagination. The
image was already fully loaded during the failing run; it was omitted with the
truncated document tail.

**Toolbar:** diagnostics recorded print media still active when the 30-second
timeout cleared the session. The header then remounted with computed display
`block` and appeared in the PDF. An always-mounted header also printed despite
the CSS hide rules, so removing the React unmount is not a validated solution.
Skipping timeout cleanup while print media remains active kept the header
absent; the existing `afterprint` handler restored controls when saving finished.

| Diagnostic experiment | Result |
| --- | --- |
| Original behavior plus layout/event logging | Reproduced nine-page truncation and toolbar after timeout. |
| CSS page margin changed only to zero | Complete document and image, but unsuitable as the final fix because page margins are lost. |
| Root padding with cloned decorations; header kept mounted | Complete document, but vertical margins did not repeat on every page and toolbar still printed. Rejected. |
| Native margins initialized to 2 cm; original CSS and header unmount; timeout guarded by active print media | Passed the targeted long-document reproduction: 12 complete pages, image/end marker present, readable diagram, normal page margins, no toolbar after about 50 seconds in the save sheet, controls restored afterward. |

The successful experiment used a private copy of Wry solely to test initial
native margin values. It is not a dependency change to ship. A production fix
still needs an appropriately scoped native print implementation, cleanup
handling through the end of print media, and renewed native/regression checks.
Do not mark the production build as passing based on this diagnostic prototype.

The retained PDFs use the `probe-` filename prefix in the fixture directory
above. Event traces are in `.tmp/print-probe-*-events.md`; the final diagnostic
binary hash and scope are in `.tmp/print-investigation-result.json`.

## Implemented fix and renewed native verification — 2026-09-06

**Result: the targeted macOS regressions now pass in a fresh release build.**
This result supersedes the failed smoke-test cases above only for the tested
platform and fixtures; the historical failure and private prototype remain
separate evidence.

### Implementation

The macOS app command `print_current_webview` receives and validates the invoking
local main webview. It uses Tauri's public `with_webview` and public AppKit /
WKWebView APIs, copies `NSPrintInfo`, and sets all four margins to
`2 / 2.54 * 72` points before creating the print operation. CSS retains its
2 cm page margins. No Cargo registry or Wry source was modified, and no HTML,
path, destination, or window-selection arguments were added. Linux, Windows,
and browser development retain `window.print()`.

The command waits for the native sheet's completion callback. A stateless
Objective-C delegate can receive AppKit's worker-thread callback and dispatches
only its boolean result to the main queue. The main queue releases the retained
webview, window, print info, operation, and delegate; the callback holds its own
references to the delegate and operation until it returns, so that release
order does not depend on what AppKit retains.
Cancellation and operational failure share AppKit's false result; invocation
success is never presented as proof of successful printing or PDF creation.

The frontend preserves the header unmount and refuses cleanup while either the
native command is pending or print media is active. The 30-second timer is now a
repeating recovery checkpoint. Print events, media changes, focus, errors, and
native completion all use the same cleanup guard. Preparation ownership checks,
resource deadlines, eager image loading, and cancellation remain in place.
Invoked printing blocks document/editor/presentation changes, defers watcher
reconciliation and settings/theme hydration, and prevents window close from
invalidating the reader. Guarded quit is admitted during invoked printing so
the user can exit without waiting for print completion. Unmount does not release
an active native operation.

### Implementation-stage failure caught by PDF inspection

The first fresh implementation build used `canSpawnSeparateThread(false)` to
simplify callback ownership. It produced twelve **blank** pages despite passing
its automated tests and showing a twelve-page native preview. Both prompt and
held dark saves failed. That choice was removed. The final implementation uses
`canSpawnSeparateThread(true)`, matching Wry's asynchronous print behavior, with
a delegate that safely dispatches completion to the main thread.

The failed implementation build has identifier
`io.github.tcraid0.bindars.print-fixed-20260907`; its binary hash and failure are
recorded in `.tmp/print-fixed-first-build.json`. Its `fixed-dark-*.pdf` outputs
are retained as failed evidence, not passing results.

### Final build and native results

Built version 1.4.3 from the uncommitted production source on
`955cb17fb4f0e0b4d896ce02c43cd3cf26446c4f`, using the locked registry dependencies,
a separate Cargo target directory, a fresh app bundle, identifier
`io.github.tcraid0.bindars.print-verified-20260907`, and no file associations.
Tested on macOS 26.6.2 (25G83), arm64. The `20260907` artifact identifiers use the
UTC date; this test was performed on September 6 local time.

Executable SHA-256:
`be81ed81c43c7dc80f892767a390e7e26a1ce8c6f7decc16fab003fbb0efcbd3`.

| Case | Result in the final build |
| --- | --- |
| Long dark Markdown, prompt save | Passed: 12 pages, all 30 sections, final image and end marker. |
| Long dark Markdown, save sheet held 64 seconds | Passed: complete 12 pages, white surface, normal margins, readable diagram, no toolbar. |
| Watcher update during that dark hold | Passed: the added `WATCHER AFTER PRINT` section did not enter the PDF; it appeared in the reader after saving. Used a disposable fixture copy and restored its original synthetic contents afterward. |
| Long sepia Markdown, save sheet held 73 seconds | Passed: complete 12 pages, final image and end marker, white surface without texture or toolbar, readable diagram. |
| Long sepia Markdown, prompt save | Passed: same complete output as its held save. |
| Cancel in the PDF save sheet | Passed: returned to the native print panel, with the operation still active. |
| Cancel the native print operation, then retry | Passed: controls returned promptly, and retry opened another dialog. |
| Native output error and retry | Passed: a temporary directory with no write permission produced AppKit's “Print Error while printing.” alert. Dismissing it restored the reader. A subsequent save into the writable fixture directory succeeded. Directory permissions were restored after the test. |
| Dark Fountain title page and explicit break | Passed: 3 pages, title alone, first scene on page 2, second scene and final marker on page 3; no toolbar or clipping. |
| Recovery after successful saves | Passed: controls returned at the first observation after saving, without waiting for the fallback. Both isolated test apps were quit after their tests. |

Extracted text and rendered every page of all five final PDFs. Every Markdown
PDF contains sections 01–30 in order and one embedded image on the final page.
Rendered held/prompt pages are pixel-identical within each theme at the same
900-pixel render size. Visual inspection confirms repeated page margins, white
paper, readable text and diagrams, no chrome, and complete tails. Measured dark
PDF text begins at a 56.69-point left margin; all text stays within the page's
printable bounds. The image was never scrolled into view before printing.

Final PDFs and extracted text are in the ignored
`test-fixtures/print-fixed-20260907/` directory:
`verified-dark-quick.pdf`, `verified-dark-held.pdf`,
`verified-sepia-quick.pdf`, `verified-sepia-held.pdf`, and
`verified-fountain-dark.pdf`. Source/configuration hashes are retained in
`.tmp/print-verified-evidence.json`; PDF hashes and extraction assertions are in
`.tmp/print-verified-pdf-results.json`. Rendered pages are in
`.tmp/print-fixed-pages/`; the build log is `.tmp/print-verified-build.log`.

Automated validation: **836 passed**, one skip, one todo in the workspace suite;
**149 passed**, one ignored in Rust tests. Production build, locked Cargo check,
formatting, license checks, and `git diff --check` passed. New regressions cover
active-media checkpoints, pending native invocation, missing/reordered browser
signals, preparation ownership, settings hydration, in-flight watcher results,
native opens/close, unmount, scoped invocation, and setup-error retry.

Still unverified: Linux/Windows native output, other macOS versions or
architectures, physical printers, and checklist cases not represented by these
fixtures. Missing browser events and native setup rejection were covered in
automated tests; unsupported-system/nil-native-view failures were not induced
in a packaged app. The actual native output-error path was exercised as above.
No physical print job was submitted, no personal document was opened, and the
normal app's settings and file associations were not changed.

## Post-review packaged verification — 2026-09-06

Rebuilt and exercised the current source after removing the unused print
permission, narrowing keyboard suppression, adding callback-local retains,
and admitting guarded quit during invoked printing. This is the native evidence
for those review changes; the earlier `verified-*` PDFs remain historical.

The isolated release app was **Bindars Print Reviewed**, version 1.4.3,
identifier `io.github.tcraid0.bindars.print-reviewed-20260907`, on macOS 26.6.2
(25G83), arm64. It used locked/offline dependencies, a separate Cargo target,
and no file associations. Executable SHA-256:
`17a4f9200cce2a3b01f3611b584b9414769d65bc1b6d2995e8b42370fd6fe20c`.
All twelve recorded production-source/configuration hashes still matched the
working tree at the end of testing. No production code was changed during this
run. A shell launch initially returned a LaunchServices executable error;
launch through the native app-control interface succeeded, as did two relaunches.

| Actual GUI flow | Result |
| --- | --- |
| Cmd-P, Dark Markdown, PDF save | Passed: 12 complete pages; controls restored immediately. |
| Toolbar Export → Print to PDF | Passed: opened the native 12-page print sheet. |
| Repeat Cmd-P with print sheet open | No second operation or dialog appeared. |
| Cancel PDF save sheet, then cancel print sheet | Passed: save cancellation returned to print options; operation cancellation restored controls. |
| Retry in Sepia, hold PDF save sheet 76.613 seconds | Passed: 12 complete pages, no toolbar or page texture. Controls returned within the next observation after saving. |
| Modify disposable Markdown during held save | Passed: added heading was absent from the PDF and appeared in the reader after completion. Original fixture restored afterward. |
| Save to a temporary unwritable directory | AppKit showed “Print Error while printing.” Dismissal restored controls; immediate retry worked. Directory permissions restored afterward. |
| Dark Fountain save after native error | Passed: title alone on page 1, first scene on page 2, explicit-break scene and end marker on page 3. |
| Cmd-Q while main print sheet open | Passed: app exited; relaunch restored the fixture and printing worked again. |
| Quit menu while nested PDF save sheet open | Passed: app exited directly without Force Quit. |
| Cmd-Q while nested PDF save sheet open | **Keyboard limitation:** no action, reproduced twice. Escape returned to the main print sheet, where Cmd-Q exited. The Quit menu also exited directly. Cause was not established; do not claim Cmd-Q works in every native sheet. |

All 27 pages of the three PDFs were rendered and visually inspected. Text
extraction confirmed all Markdown sections 01–30 in order, the final embedded
image, and the end marker; no print-status/toolbar text or deferred watcher
content leaked. Fountain's three-page structure passed extraction checks.
Margins, diagrams, and white page surfaces were visually checked.

Evidence: `test-fixtures/print-reviewed-20260907/reviewed-dark.pdf`,
`reviewed-sepia-held.pdf`, and `reviewed-fountain.pdf`, with extracted `.txt`
files. Build/source provenance is in `.tmp/print-reviewed-evidence.json`;
PDF hashes, text assertions, and measured text bounds are in
`.tmp/print-reviewed-pdf-results.json`. Renders use `.tmp/reviewed-*.png`.

The production build and full workspace suite passed (**837 passed**, one skip,
one todo), as did Rust tests (**149 passed**, one ignored) and `git diff --check`.
Logs use `.tmp/print-reviewed-*.log`. All test app processes were quit normally.
No physical job was submitted and no personal document or normal app settings
were changed. A permanently hung native operation was not artificially induced;
quit was tested during real pending operations. Other platforms and OS versions
remain unverified. No additional output or recovery defect was observed in these
flows; the save-sheet keyboard limitation above remains documented.

PR CI subsequently caught a Linux-only dead-code lint: the macOS print outcome
variants were compiled but never constructed on Linux. The enum is now scoped
to macOS, with a unit result type for the error-only command on other platforms.
This changes no macOS runtime code or printing behavior. The recorded GUI-build
source hash predates this conditional-compilation correction; CI verifies the
updated source on Linux and macOS.

## Platforms

| Platform | Webview | Status |
| --- | --- | --- |
| Linux | WebKit2GTK | [ ] |
| Windows | WebView2 | [ ] |
| macOS | WKWebView | Targeted regressions passed on 26.6.2 arm64 in the final isolated release build; remaining cases unverified |

## Reader themes

For each platform, verify:

Printing uses one continuous layout with a white page and readable text.
Reader themes do not change the page background. Images and diagrams retain
their colors; diagrams keep the backdrop that matches their rendered palette.

- [ ] Markdown printed from light, dark, and sepia reader themes; no page texture appears
- [ ] Fountain printed from light and dark reader themes
- [ ] Existing saved Book/themed-print preferences have no effect

## Sample Content

Use at least one document that includes:

- [ ] Long prose with multiple `h1`/`h2` sections
- [ ] Markdown images
- [ ] Mermaid diagrams
- [ ] KaTeX math
- [ ] Tables
- [ ] Syntax-highlighted code blocks
- [ ] Footnotes
- [ ] Links

Use one Fountain document that includes:

- [ ] Title page
- [ ] Dialogue
- [ ] Parentheticals
- [ ] Scene breaks
- [ ] Dual dialogue

## Validation Checklist

- [ ] Print action opens the native print dialog
- [ ] Cancel returns to a usable document without changing its content; record the control-recovery interval and whether a recovery checkpoint was needed
- [ ] Cancel during preparation prevents a later print dialog; a new attempt works
- [ ] Repeated commands during preparation open only one dialog
- [ ] Changing documents or entering edit mode during preparation cancels that attempt
- [ ] Save as PDF creates a readable PDF at the chosen destination
- [ ] On macOS, verify both printing to an available printer and Save as PDF; record an unavailable printer as untested
- [ ] Completing printing returns to the normal document view
- [ ] Header, sidebar, overlays, and controls do not appear in the PDF
- [ ] Fonts look correct in the exported PDF
- [ ] Slow or broken images do not block print for more than a few seconds
- [ ] Images near the end of a long, unscrolled document appear in the PDF
- [ ] Mermaid diagrams render as SVG in the PDF when they finished loading onscreen
- [ ] Markdown reads continuously without forced section or frontmatter page breaks
- [ ] Tables do not overflow page width and keep headers readable
- [ ] Code blocks, blockquotes, images, and diagrams avoid awkward page splits where possible
- [ ] Fountain output remains readable and uses screenplay-style spacing
- [ ] Fountain title pages and explicit page breaks are preserved
- [ ] Hold Save as PDF open beyond 30 seconds in dark and sepia themes, then save; the page stays white with no reader texture or app chrome
