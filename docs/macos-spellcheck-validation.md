# macOS spell checking: validation record

**Date:** 2026-09-14

**Result:** The initial packaged-app checks verified document-editor spelling, corrections, undo/redo, and persistence. Two follow-ups addressed automatic changes in other inputs: first the React search/note fields, then CodeMirror's generated Find/Replace fields. The three builds and their separate evidence are recorded below; no run establishes every acceptance scenario or supported macOS version.

The [implementation plan](macos-spellcheck-plan.md) contains the design rationale, preference keys, and full acceptance protocol. The implementation uses the existing CodeMirror editor, macOS checking, and document save path.

## Original build and test environment

| Item | Value |
| --- | --- |
| OS | macOS 26.6.2, build `25G83`, Apple Silicon (`arm64`) |
| Source | HEAD `834b54138cf150fdc59abd9bd184b37bf1d840a6` plus the four feature-file changes below |
| Packaged app | `Bindars Spellcheck Review.app` |
| Isolated bundle identifier | `io.github.tcraid0.bindars.spellcheck-review-20260914` |
| Binary SHA-256 | `94b4eb54120e29ab26b430b0a0f6947cf9843f7dbc64c9e199f3b64aa349d805` |
| Test configuration | Only product name, bundle identifier, and file associations differed from the normal build configuration |
| Initial preferences | The isolated identifier's defaults domain was absent before first launch |
| Text/language coverage | Typed English fixtures; other spelling languages were not tested |
| Theme coverage | Red underlines observed in Dark and Light; the profile also passed through Midnight |

Feature files: [CodeMirrorEditor.tsx](../src/components/CodeMirrorEditor.tsx), [codemirror-editor.test.cjs](../tests/codemirror-editor.test.cjs), [lib.rs](../src-tauri/src/lib.rs), and [Cargo.toml](../src-tauri/Cargo.toml). No lockfile or version change was needed.

The fresh app domain exercises the registration fallback without a previously saved app spelling choice. Targeted global-domain reads also confirmed that all five registered WebKit keys were absent there. General system smart-substitution settings were not controlled, so this does not establish behavior under every inherited system preference.

## Original build: native results

| Scenario | Observed result |
| --- | --- |
| Typed Markdown prose | English `recieve` received a red underline; right-click offered native `receive`; selecting it corrected the word. |
| Typed Markdown heading | Underlining and correction worked in a formatted heading. The saved source retained its `##` marker. |
| Markdown formatting toggle | Switching from styled headings to plain markup preserved the corrected document. |
| Typed Fountain prose | Red underlines, native suggestions, and chosen correction worked. |
| Undo/redo | Cmd-Z restored the misspelling and redo restored the correction. |
| Manual save | A native correction followed by Cmd-S reached disk. The elapsed time was not measured; this does **not** prove a native save within the editor's 200 ms publication delay. |
| Autosave and lifecycle | A Fountain correction autosaved to disk and survived Read/Edit transitions and quit/relaunch. Newly typed misspellings still received underlines after re-entering Edit mode. |
| Literal source typing | Typed straight quotes, dashes, apostrophes, and a URL remained literal on disk in the tested profile. Configured text-shortcut replacement was not exercised. |
| Native autocorrection preference enabled | After quitting, `WebAutomaticSpellingCorrectionEnabled=true` was written only to the isolated app domain. After relaunch, typed `I will recieve teh package tomorow.` remained literal with red underlines and was saved. The editor's native **Correct Spelling Automatically** item was disabled. |
| Loaded, untouched text | Existing words did not immediately receive underlines. This feature must not be described as an immediate whole-document spelling audit. |
| Dark/Light themes | Native red underlines were visible in both themes. |

The explicit autocorrection-preference check changed only the isolated test app domain. After testing, the app was closed and the temporary `WebAutomaticSpellingCorrectionEnabled` key was removed and confirmed absent. The user's global settings and regular Bindars preference domain were never written.

## Original build: automated verification

| Check | Result |
| --- | --- |
| `npm run build` | Passed; existing chunk-size warning remained |
| `npm run test:workspace` | 1,199 passed, 0 failed, 1 skipped; 1,200 total |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed |
| `cargo check --manifest-path src-tauri/Cargo.toml --locked` | Passed |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked` | 163 passed, 0 failed, 2 ignored |
| Packaged Mac app build | Passed |
| `git diff --check` | Passed |

The editor test explicitly checks Mac `spellcheck="true"`, non-Mac `spellcheck="false"`, and `autocorrect="off"`. Native UI results come from the packaged-app checks, not Happy DOM. Linux and Windows native behavior was not rerun; their editor attribute remains disabled and all added native code/dependency features are macOS-only.

## Follow-up: literal search text and manual note corrections

The field fix changes only [SearchBar.tsx](../src/components/SearchBar.tsx), [CommandPalette.tsx](../src/components/CommandPalette.tsx), and [AnnotationsPanel.tsx](../src/components/AnnotationsPanel.tsx). On Mac, both search inputs receive `autoCorrect="off"` and `spellCheck={false}`. Notes receive `autoCorrect="off"` and retain native spelling assistance. The attributes are omitted on non-Mac platforms. The native defaults helper is unchanged; no capitalization attribute or new abstraction was needed.

| Item | Follow-up build |
| --- | --- |
| OS/source | Same macOS 26.6.2 system and HEAD as above, plus the original four feature files and the three field changes |
| Packaged app | `Bindars Spellcheck Fields.app` |
| Isolated identifier | `io.github.tcraid0.bindars.spellcheck-fields-20260914` |
| Binary SHA-256 | `52b3bcdb3ec73e0feb4b2989b15e6eb70b867cabfdbbd0929f11af670cb57fd1` |
| Preferences | The identifier's domain was initially absent. `WebAutomaticSpellingCorrectionEnabled=true` was then set only in that isolated domain; the app was cold-relaunched and the key was confirmed as `1` before the controlled checks. |

| Controlled native check | Observed result |
| --- | --- |
| Read-mode search | Typed `"teh "` remained exact after Tab blurred the input, with no underline or capitalization. Removing the trailing space found 1 of 1 matches in the fixture. |
| Quick switcher | Typed `"teh recieve "` remained literal without underlines. No workspace was selected, so workspace search results were not tested. |
| Highlight note | Typed `"teh recieve "` remained literal; `recieve` had a red underline. Its native menu offered `receive` and `relieve`, while **Correct Spelling Automatically** was disabled. Choosing `receive` produced `"teh receive "`; blur saved and displayed `"teh receive"`, following the existing note trim behavior. |
| Note persistence | After quit/relaunch, reopening Highlights & notes displayed the saved `"teh receive"` note. |
| Capitalization | The reported casing change was not reproduced with these attributes; no separate `autoCapitalize` change was made. |

After the follow-up, the test app was closed and confirmed not running. Its temporary `WebAutomaticSpellingCorrectionEnabled` key was removed and confirmed absent. The normal Bindars profile and global preferences were not changed.

The follow-up frontend and packaged-app builds passed, with the existing chunk-size warning. The workspace suite passed again: 1,199 passed, 0 failed, 1 skipped out of 1,200. Component review and `git diff --check` passed. Rust checks were **not rerun** for this follow-up because native source and dependencies were unchanged; the Rust results above belong to the original build. The original document-editor scenarios also remain evidence from the original binary, rather than a claimed full rerun on this one.

## Final follow-up: generated Edit-mode Find/Replace inputs

A later review identified an uncovered input: on the Fields binary above, opening Edit-mode Find, typing `"teh "`, then pressing Tab changed it to `"Teh "`. That exact behavior was independently reproduced. Replace remained literal in the same pre-fix trial; its identical missing attributes justified applying the same input policy without claiming a reproduced rewrite there.

The fix adds a Mac-only closed-to-open check to CodeMirror's existing update listener. Once the generated panel has mounted, both text inputs receive `autocorrect="off"` and `spellcheck="false"`. The existing platform test now checks initial opening and fresh inputs after reopening. Native source/dependencies, capitalization attributes, and the other fields are unchanged; no observer, timer, or custom panel was added.

| Item | Final build |
| --- | --- |
| OS/source | Same macOS 26.6.2 system and HEAD as above, with all preceding changes plus the listener and test updates |
| Packaged app | `Bindars Spellcheck Find.app` |
| Isolated identifier | `io.github.tcraid0.bindars.spellcheck-find-20260914` |
| Binary SHA-256 | `0dbd962fa69fb04fb74a8586caa127c1efa6cd06d55257110c33f7ad14aeb26f` |
| Preferences | The new domain was absent. Only its `WebAutomaticSpellingCorrectionEnabled` key was set to true before launch and confirmed as `1`. |

| Controlled native check | Observed result |
| --- | --- |
| Literal Find and case-sensitive matching | `"teh "` remained exact after Tab. With **match case** enabled, Next selected the lowercase match on fixture line 3 (`teh lowercase`); the uppercase `Teh uppercase` line was not selected. |
| Literal Replace and saving | Find targeted `replace-me`; Replace retained `"teh "`. Replacing the selected target produced a standalone `"teh "` on line 7. Cmd-S saved it, and disk inspection verified the trailing space. |
| Replacement undo/redo | With the document editor explicitly focused, Cmd-Z restored `replace-me`; redo restored `"teh "`, which was saved. |
| Close/reopen panel | Newly created fields retained freshly typed Find `"teh "` and Replace `"teh recieve "` after Tab, without underlines. |
| Document spelling retained | After closing the panel, newly typed `recieve` stayed misspelled with a red underline and was persisted. |
| Read search and quick-switcher regression checks | Read-mode `"teh "` remained literal after Tab and showed 1 of 2 matches. Quick-switcher `"teh recieve "` also remained literal after Tab; no workspace was selected. |

After this run, the Find test app was confirmed not running. Its temporary app-only `WebAutomaticSpellingCorrectionEnabled` key was removed and confirmed absent. The normal Bindars profile and global preferences were untouched.

The final complete workspace run passed: **1,199 passed, 0 failed, 1 skipped** out of 1,200. Frontend and packaged-app builds passed with the existing chunk-size warning. The earlier test run had one assertion-safety failure in the newly extended test; that assertion was corrected before the clean complete rerun. The final test verifies actual panel mount/reopen attributes and leaves document spelling enabled on Mac; Linux generated fields retain absent attributes. It does not simulate native autocorrection.

The original editor and Fields scenarios above remain historical evidence from those binaries, except for the current-build checks explicitly listed here. Notes were not rerun on the Find binary. No native source or dependency change required another Rust test run.

## Integration check with the newer image changes (September 15, 2026)

This run checks the combined working tree at `fad29a0c4668400b62101b1e9a434f99c05e3574`, including the two image-authorization commits added after the earlier native builds, plus the uncommitted spelling changes. No implementation changes were needed.

| Item | Integration build |
| --- | --- |
| OS | macOS 26.6.2 (25G83), arm64 |
| Packaged app | `Bindars Spellcheck Integration.app` |
| Isolated identifier | `io.github.tcraid0.bindars.spellcheck-integration-20260915` |
| Binary SHA-256 | `eb7b0ef9c56d82e72fa8c2597d1a462c2d7a1cde6526813dd06dbd11401020e1` |
| Fixture | `test-fixtures/spellcheck-integration-20260915/integration.md`, with a relative `image.png` copied from the repository's app icon |
| Preferences | Domain initially absent; app-only `WebAutomaticSpellingCorrectionEnabled=true` set before first launch and confirmed as `1` |

Automated checks passed:

- Complete workspace suite: **1,208 passed, 0 failed, 1 skipped** (1,209 total).
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked`: **165 passed, 0 failed, 2 ignored**.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`.
- Frontend TypeScript/Vite build and packaged Mac app build; the existing chunk-size warning remains.
- `npm run licenses:check`: 305 npm and 573 Rust packages, no human follow-up required.
- `git diff --check`.

Native checks on this binary passed:

- The relative image rendered when opening the document in Read mode.
- In Edit mode, typed `recieve ` stayed literal and received a red underline. Its native menu offered `receive` and `relieve`; automatic spelling correction was disabled for the editor.
- Choosing `receive` and then pressing Cmd-S saved `receive ` to disk. This was not a measured sub-200 ms save test.
- Edit-mode Find retained `teh ` after Tab. Replace retained `teh ` after Tab, replaced the selected `replace-me` target, and saved the exact trailing space to disk.
- Returning to Read mode rendered the relative image and corrected/replaced text correctly.
- Read-mode search retained `teh ` after Tab and found 1 of 2 matches.

The isolated app was closed and confirmed not running. Its temporary autocorrection key was removed and confirmed absent. Normal Bindars and global preferences were untouched. This was a focused integration smoke test; the broader native scenarios above remain evidence from their recorded binaries, and the coverage limits below still apply.

## Remaining release coverage

- macOS 15, the declared minimum, and other untested OS versions.
- Controlled system smart-quote/dash settings and a configured text-shortcut trigger; literal typing passed only under the recorded test environment.
- A saved checking opt-out and explicit substitution preference surviving restart. Registration precedence is supported by the API/source review, but those native cases were not exercised.
- Workspace search results during the controlled quick-switcher check; that run verified literal input without a selected workspace.
- Paste/scroll marking behavior.
- Native correction followed by a save confirmed to occur before 200 ms. Existing automated flush tests passed, but that native timing boundary was not measured.

These are coverage limits, not observed defects. Do not describe the entire acceptance matrix as passed. The lack of immediate marks on untouched loaded text is an observed native limitation; do not add document scanning or a custom checker to conceal it.

## Repeat the focused native checks

1. Build the final source as a packaged app with a temporary product name and unique bundle identifier. Restrict test configuration changes to product name, identifier, and file associations. Record the binary hash and confirm that the new identifier has no saved defaults domain before launch; never delete the normal Bindars domain to obtain a fresh profile.
2. Use temporary Markdown and Fountain files. Type `recieve`, finish the word, and move the caret away. Choose native `receive`, undo/redo, save, and inspect the file on disk. Repeat with a `##` heading and allow a separate correction to autosave.
3. Type straight quotes, apostrophes, dashes, and a URL; inspect saved literal text. Record the system substitution settings and separately exercise a configured text shortcut if extending coverage.
4. Quit the isolated app. Set `WebAutomaticSpellingCorrectionEnabled` to true **only in its test defaults domain**, relaunch, and type `I will recieve teh package tomorow.`. Verify the text remains literal until a suggestion is selected. Keep the normal app and global preferences untouched.
5. With that preference still enabled, type in Read-mode search and the quick switcher, then blur: text must remain literal and have no spelling underlines. In a note, verify literal typing, native underlines, a chosen suggestion, and saved text. Record whether a workspace was available for checking quick-switcher results.
6. Open Edit-mode Find/Replace. Type `"teh "` in Find, blur, and use case-sensitive matching against lowercase/uppercase fixtures. Type a literal replacement including a trailing space, replace a selected target, focus the document for undo/redo, save, and inspect disk contents. Close/reopen the panel and repeat literal typing in its fresh fields; confirm document spelling still works after closing it.
7. Check Read/Edit transitions, quit/relaunch, newly typed underlines, and the intended themes. Record untouched-text behavior and remaining gaps explicitly. Close the test app and remove its temporary autocorrection preference afterward.
