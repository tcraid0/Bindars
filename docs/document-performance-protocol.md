# Document performance verification

This protocol measures Markdown policy behavior through the optimized Tauri app, its native file-open command, and the system WebKitGTK process. It is intentionally narrow: it calibrates the emergency source backstop, smartypants, and Markdown render counts. It does not establish table, heading, Fountain, or general responsiveness ceilings.

Detailed results and corrections belong in private notes outside the repository. Do not commit generated fixtures, raw JSON, screenshots, profiles, binaries, or machine-specific output.

## Prerequisites

- Linux with WebKitGTK 4.1, GTK 3, and a working X11 or Wayland display.
- The repository's Node and Rust dependencies already installed.
- `WEBKIT_INSPECTOR_HTTP_SERVER` support in the installed WebKitGTK.
- Enough free memory for fresh-process trials.

The harness uses a localhost-only WebKit inspector endpoint and isolated temporary XDG data/config/cache directories. It does not read or modify the user's normal Bindars profile.

## Build identity

Build an optimized binary with the compile-time measurement probe enabled:

```sh
BINDARS_DOCUMENT_PERFORMANCE_PROBE=1 npx tauri build --no-bundle
```

The probe records one bounded in-memory event per Markdown pipeline execution, including the exact mdast input measured by the existing smartypants gate and the transform duration. A normal build sets the probe to false and Vite removes the enabled branch.

The verifier records:

- Binary path, size, modification time, and SHA-256.
- Git branch and HEAD; a SHA-256 of the complete tracked delta against HEAD; and a sorted path, type, byte-size, and SHA-256 manifest for every nonignored untracked file.
- OS, kernel, architecture, CPU, logical CPU count, RAM, WebKitGTK, session type, display backend, and renderer flags.

Never compare results from binaries with different hashes without labelling them as different builds.

## Generate fixtures

Fixtures are normally generated into a temporary directory automatically. To inspect or reuse them:

```sh
node scripts/generate-document-performance-fixtures.mjs /tmp/bindars-document-fixtures
```

The manifest pins source code units, UTF-8 bytes, SHA-256, expected behavior, end markers, fixture shape, and exact assembled smartypants characters. Generated data is ASCII so its source code-unit and UTF-8 byte counts intentionally coincide; source-unit boundary tests for BMP, astral, LF, and CRLF live in the automated test suite instead.

## Run the assembled-app sweep

```sh
node scripts/verify-document-performance.mjs \
  --binary src-tauri/target/release/bindars \
  --trials 3 \
  --timeout-ms 5000 \
  --seed 20260806 \
  --output /tmp/bindars-document-performance.json
```

Environment overrides:

- `BINDARS_PERFORMANCE_GDK_BACKEND`: defaults to `x11` for repeatability.
- `BINDARS_PERFORMANCE_DISABLE_DMABUF`: defaults to `1` and is passed as `WEBKIT_DISABLE_DMABUF_RENDERER`.

Record any override with the results. The five-second default is a harness safety bound, not a product responsiveness target. Use a larger explicit timeout only when the additional stall and memory growth are justified by the question being measured.
Timed-out trials are retained as failures with their last DOM snapshot, last inspector error, process output, observed/live web-process PIDs, and memory sample; the verifier continues to the remaining randomized trials and exits non-zero after writing the result file. If no completed pipeline-event set is available, the summary reports the execution count and total transform time as `null`. A separate field reports how many events were visible in the last pre-timeout snapshot, when one exists; this is an observation before timeout, not a completed-execution count.

## Routes and assertions

### Cold direct-open

Every cold trial starts a fresh optimized Tauri process with the fixture path as the real CLI/file-association argument. Case order is deterministically shuffled from the recorded seed.

Accepted smartypants fixtures cover 8,000, 9,000, 10,000, 11,000, and 12,000 assembled UTF-16 code units across four shapes: punctuation-dense text, realistic quoted prose, formatting-split text, and inline-code-heavy text. Additional punctuation cases pin the current inclusive 65,536-unit limit and verify readable straight-quote degradation at 65,537 units.

Accepted source-volume fixtures cover 524,288, 786,432, and 1,048,576 source code units across whitespace-separated word soup, ordinary paragraphs, and a fenced code block. A word-soup fixture at exactly 1,048,577 units must be refused before any Markdown pipeline event. These synthetic shapes expose policy differences; they do not substitute for compatibility testing against legitimate large documents.

Each accepted or degraded result requires:

- A non-empty reader article.
- Its unique end marker in the DOM.
- At least one heading.
- No loading state or React root error boundary.
- An exact-character probe event.
- Curly quotes when smartypants applies or straight quotes when it degrades.

The refused result requires:

- The “too large or complex” alert.
- Zero Markdown pipeline events.
- No presentation overlay after F5.
- Printing to retain the notice rather than expose a reader tree.
- Entry into CodeMirror and visibility of the exact end marker after moving to the document end.
- An unchanged SHA-256 for the source file after the interactions.

These DOM, role, content, editor, and presentation checks are the retained accessibility/interaction evidence. Screenshots may be collected manually for a release record, but are not generated or committed by the harness.

### Warm navigation and remounts

A fresh process directly opens a small control document. The verifier follows real relative Markdown links through the application's navigation route, returns with the app's Back control, and resets probe events only after each quiet-window control render.

For each trial it records:

- Warm Markdown-to-Markdown navigation pipeline events observed within the quiet window, plus timings for 8,000–12,000 characters.
- The pipeline events observed within the quiet window after entering and leaving edit mode at 10,000 characters.
- The pipeline events observed within the quiet window when presentation mounts its separate Markdown renderer.

This distinguishes a one-time mount/remount effect from ordinary warm navigation. Do not generalize a count from one lifecycle to the others.

## Timing and memory definitions

- **Commit/open time:** wall time from process launch or in-app action until the first valid, non-empty, end-marked DOM or truthful refusal alert is observed.
- **Settled time (bounded quiet-window timing):** wall time until the valid DOM remains unchanged across four 100 ms polls after forced layout. The signature includes DOM size, article extent, headings, TOC links, presentation state, notice state, and pipeline-event count. Work that arrives during this window resets it; work that arrives later is not captured. Therefore this timing and its pipeline count do not prove that all delayed heading, observer, annotation, or asset-scope work has finished.
- **Smartypants transform time:** `performance.now()` duration around the real `remark-smartypants` transformer in the instrumented optimized bundle. Measurement and transformation durations are recorded separately. The result summary reports the per-execution range, total transform time per cold open, pipeline executions per open, and individual trial rows; never present a per-execution median as total work for the open.
- **Web-process peak:** PID-scoped `/proc/<pid>/status` `VmHWM` for each WebKit web process observed under that fresh app process. The result also records all observed web-process PIDs, which remain live at trial finish, and whether a replacement PID was observed between samples. Sampling cannot exclude a termination and replacement entirely between polls.
- **End-of-trial process-tree PSS:** a separately labelled, one-time sum from `smaps_rollup`, sampled after a settled DOM or at timeout. It is not a peak and must not be compared or described as `VmHWM`.

The remote inspector and probe add measurement overhead. Use transform durations to choose the smartypants threshold, and use assembled-app wall times to detect regressions or delayed work. Before publishing a final product claim, repeat critical total-time cases with an ordinary uninstrumented release build and an equivalent manual/end-marker check.

## Interpretation

- Choose a smartypants threshold only after a product time budget is adopted. Select the highest measured point that meets it across repeated trials; do not call the chosen value a proven ceiling outside the recorded host and build.
- The 1,048,576-code-unit source policy is an emergency upper backstop. Passing below it does not imply a fast render.
- A successful refusal does not validate table, repeated-block, giant-paragraph, or Fountain performance.
- Retain failed trials and later corrections in private notes outside the repository instead of replacing them with only the successful rerun.
