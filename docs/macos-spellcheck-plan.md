# macOS native spell checking: implementation and review plan

**Status:** Implemented and tested in packaged Mac apps on 2026-09-14. The original build verified document-editor spelling and persistence; follow-ups added explicit Mac-only attributes to React search/note fields and CodeMirror's generated Find/Replace inputs. See [validation results by build and remaining coverage](macos-spellcheck-validation.md); not every acceptance scenario or supported OS version has been tested.

**Prepared:** 2026-09-14, initially against commit `c07bb54a0792ab99c7bb3d6ea8d56a3a27d68c2b`. Implementation and native validation used commit `834b54138cf150fdc59abd9bd184b37bf1d840a6` plus the original four feature-file changes, three field-component changes, and the final editor listener/test updates. The validation record distinguishes those three binaries and the September 15 integration build against `fad29a0c4668400b62101b1e9a434f99c05e3574`. This document retains the design rationale and acceptance protocol. Preserve unrelated working-tree changes.

**Reviewed implementation:** The editor attribute and native initialization were implemented together, with fallback defaults against automatic source-text substitutions and explicit Mac/non-Mac editor tests. Follow-ups disable automatic corrections in Mac search and note fields, retain spelling assistance in notes, and disable it in Read search, the quick switcher, and Edit-mode Find/Replace. No custom checker, menu, or save path was added.

## 1. Objective and priorities

Add native spelling assistance to Bindars' document editor on **macOS only**:

- Underline misspelled words in red while editing.
- Offer the system's spelling suggestions when the user right-clicks a misspelled word.
- Replace a word only when the user chooses a suggestion; keep automatic correction off.
- Keep quotes, dashes, text shortcuts, and URLs literal by default. Respect explicit native user preferences rather than resetting them at every launch.
- Keep ordinary editing, undo/redo, autosave, manual save, and reopening reliable.
- Keep Mac search queries and Edit-mode replacement text literal without spelling underlines; allow native underlines and chosen corrections in notes while disabling automatic correction there.
- Leave Linux behavior and dependencies unchanged. Keep Windows' current behavior too.

**The main design priority is reducing unnecessary complexity. Prefer boring, functional code.** Reuse the existing editor, platform detection, native menu, dictionaries, and save path. A small change with verified native behavior is the intended outcome.

The implementation combines the editor attribute and one small native defaults helper. The source review supports both: native checking needs an enabled fallback for new users, and enabling checking can also admit automatic text substitutions. Do not add infrastructure beyond those concrete requirements.

### Initial scope limits

This version covers the shared Markdown/Fountain document editor in Edit mode, its generated Find/Replace inputs, and explicit input attributes for the three React-owned text fields. It does not add a spelling panel, grammar product, custom dictionary, language picker, app settings toggle, AI service, downloaded dictionaries, syntax-aware exclusions, or a whole-document spelling audit. Native menu commands such as Ignore/Learn may remain available if WebKit supplies them; Bindars does not implement or manage them.

Accept normal native limitations initially: proper names, code, URLs, and Markdown source may be flagged; dictionary contents and suggestion ordering belong to macOS. We should document observed behavior, rather than promise identical behavior to Word or Obsidian.

## 2. Relevant existing code

| Area | Current behavior and implementation relevance |
| --- | --- |
| [CodeMirrorEditor.tsx:364](../src/components/CodeMirrorEditor.tsx#L364) | One state factory builds editor extensions and is also used when adopting an external baseline. The attribute lives here so it survives those transitions. |
| [CodeMirrorEditor.tsx:380](../src/components/CodeMirrorEditor.tsx#L380) | `EditorView.contentAttributes.of(...)` enables spelling on Mac and explicitly keeps `autocorrect: "off"`. |
| [CodeMirrorEditor.tsx:389](../src/components/CodeMirrorEditor.tsx#L389) | The existing update listener configures generated Find/Replace fields only when their panel opens on Mac. |
| [shortcut-labels.ts:140](../src/lib/shortcut-labels.ts#L140) | `detectShortcutPlatform()` returns `"macos"` or `"windows-linux"`, with a non-Mac fallback. Reuse it despite the shortcut-oriented name. |
| [print-invocation.ts:5](../src/lib/print-invocation.ts#L5) | Existing precedent for using that platform helper outside shortcut labels. Printing also needs `isTauri()` because it invokes native IPC; the HTML attribute does not. |
| [MarkdownEditor.tsx:72](../src/components/MarkdownEditor.tsx#L72) | Markdown and Fountain use the same CodeMirror component. No extra props through this wrapper should be needed. |
| [CodeMirrorEditor.tsx:344](../src/components/CodeMirrorEditor.tsx#L344) | Edits normally publish after 200 ms; publication reads `view.state.sliceDoc()`. |
| [App.tsx:259](../src/App.tsx#L259) and [useEditor.ts:325](../src/hooks/useEditor.ts#L325) | The existing editor flush/save path must receive native corrections. No second spelling-specific save path. |
| [native_lifecycle.rs:450](../src-tauri/src/native_lifecycle.rs#L450) | The Mac menu starts from Tauri's default menu and replaces Quit to preserve the unsaved-change guard. No spelling menu rewrite is proposed. |
| [lib.rs:58](../src-tauri/src/lib.rs#L58) | Register the Mac text-checking defaults at app startup, before constructing the Tauri builder/webview. |
| [codemirror-editor.test.cjs:119](../tests/codemirror-editor.test.cjs#L119) | Explicit Mac/non-Mac cases check document attributes and both generated search fields immediately after opening and after reopening with fresh DOM. |
| [SearchBar.tsx](../src/components/SearchBar.tsx) and [CommandPalette.tsx](../src/components/CommandPalette.tsx) | Mac search inputs explicitly disable autocorrection and spell checking. Non-Mac attributes remain absent. |
| [AnnotationsPanel.tsx](../src/components/AnnotationsPanel.tsx) | The Mac note textarea disables autocorrection and leaves spelling assistance available. Non-Mac attributes remain absent. |

Inspected versions: CodeMirror view 6.43.6, Tauri 2.11.5, Wry 0.55.1, and objc2 Foundation bindings 0.3.2. The Mac bundle declares macOS 15.0 as its minimum. No app-owned `contextmenu` interception was found in the inspected source.

## 3. What the research establishes—and what it does not

### CodeMirror supports setting the attribute

The CodeMirror maintainer identifies `EditorView.contentAttributes.of({ spellcheck: "true" })` as the appropriate configuration. The installed dependency defaults to `spellcheck="false"`, `autocorrect="off"`, `autocapitalize="off"`, and `writingsuggestions="false"`; the app's content-attribute extension can override these defaults. [CodeMirror maintainer guidance](https://discuss.codemirror.net/t/inputstyle-contenteditable-we-may-hope-for-browser-spell-checking/608)

This requests browser spelling assistance. It does not itself guarantee painted underlines or a native menu. The HTML standard allows user preferences and browser behavior to affect checking. [HTML spelling specification](https://html.spec.whatwg.org/multipage/interaction.html#spelling-and-grammar-checking)

### macOS WebKit already supplies the underlying functionality

WebKit's Mac text checker uses `NSSpellChecker`. Its initial continuous-checking state reads `WebContinuousSpellCheckingEnabled` and respects `NSAllowContinuousSpellChecking`. With no effective value for the first key, this source initializes checking as disabled. Include an enabled registration default in the first implementation instead of relying on a developer's previously saved preference. [WebKit Mac text checker](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/TextCheckerMac.mm)

WebKit's editing context menu builds spelling suggestions and applies a selected suggestion as a text replacement. Bindars should use that existing path. [WebKit context-menu implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/ContextMenuController.cpp#L1233-L1261)

The installed Tauri default Mac Edit menu has Undo, Redo, Cut, Copy, Paste, and Select All; it has no spelling item. Leave that menu intact. Use WebKit's context-menu spelling controls where available, with the startup default providing the initial behavior.

### Enabling checking can also enable unwanted source-text changes

The reviewed WebKit editing path can request quote, dash, text-shortcut, and link replacements independently of automatic spelling correction. The root editable element's spelling eligibility affects that path. Therefore changing `spellcheck` can expose substitutions that were previously skipped. `autocorrect="off"` guards automatic spelling correction; it is not a general switch for all substitutions. [WebKit editing logic](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/editing/Editor.cpp), [autocorrection eligibility](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/editing/AlternativeTextController.cpp)

Register the four substitution defaults as false in the same small helper. Quotes, dashes, and text replacement otherwise consult native system preferences. Link detection already defaults to false when its WebKit key is absent; its explicit false entry documents the desired default rather than fixing a system-enabled fallback. [WebKit preference initialization](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/TextCheckerMac.mm)

These are fallback values, not locks. An existing higher-priority value for the same WebKit key wins. Newer WebKit also has a platform/client-driven checking path that can bypass the reviewed routines; verify literal typing in the actual Mac app rather than asserting that these keys guarantee it on every version.

### Avoid confusing two different WebKit APIs

The often-cited `isContinuousSpellCheckingEnabled` property belongs to the older `WebView`. Bindars uses `WKWebView`; its installed public bindings do not expose that property. Do not copy a legacy example, cast a WKWebView to WebView, or invoke a guessed/private selector. [Legacy property documentation](https://developer.apple.com/documentation/webkit/webview-swift.class/iscontinuousspellcheckingenabled?language=objc), [WKWebView documentation](https://developer.apple.com/documentation/webkit/wkwebview/)

### Source evidence and native validation have different limits

A CodeMirror user reported red underlines and context-click corrections in Mac Safari, but that report is from 2022 and is not a test of this app or its current OS. The discussion also highlights problems when editors rewrite their DOM. Treat it as feasibility evidence only. [CodeMirror Mac/iOS discussion](https://discuss.codemirror.net/t/os-level-spellcheck-is-disabled-on-ios-even-after-adding-contentattribute/4128)

Current upstream WebKit source is also evidence of an implementation, not a guarantee about the WebKit version shipped with every supported Mac. The packaged-app checks subsequently verified core editing behavior on macOS 26.6.2; [the validation record](macos-spellcheck-validation.md) identifies the remaining gaps.

## 4. Frontend change

In [CodeMirrorEditor.tsx](../src/components/CodeMirrorEditor.tsx), reuse the existing helper and public search state query:

```ts
import { detectShortcutPlatform } from "../lib/shortcut-labels";
import { search, searchKeymap, searchPanelOpen } from "@codemirror/search";
```

Compute `const isMac = detectShortcutPlatform() === "macos"` inside `createEditorState`, then configure the document surface:

```ts
EditorView.contentAttributes.of({
  "aria-label": "Edit document",
  "aria-multiline": "true",
  spellcheck: isMac ? "true" : "false",
  autocorrect: "off",
}),
```

The explicit `autocorrect` entry documents the requested behavior; it matches CodeMirror's current default. It does not enable another feature or prove native enforcement by itself.

Implementation choices:

- Evaluate platform detection when creating editor state; do not cache it in a new global platform service.
- Use the existing facet rather than assigning `contentDOM.spellcheck` in an effect or editing DOM after every keystroke.
- Keep the editor's existing accessibility attributes.
- Do not add a React prop, state variable, hook, CodeMirror compartment, plugin, or settings-store field for a value that stays fixed for the session.
- Do not force `lang="en-US"`; use the user's native spelling configuration.
- This also requests checking in browser development on a Mac. That browser has its own substitution preferences and does not receive the native defaults below. Use Tauri development mode to verify the intended behavior; a browser-only preview is not equivalent.
- Leave `App.tsx`, document persistence, Markdown parsing, CSS, and context-menu handlers alone unless a demonstrated defect requires a focused fix.

No new package, Tauri command, or permission was added. The native helper below uses additional features on an existing Mac-only dependency.

### Follow-up field attributes

An independent review reported automatic changes in Read-mode search, an area not covered by the initial native checks. The small fix reuses `detectShortcutPlatform()` in each affected component:

```tsx
const isMac = detectShortcutPlatform() === "macos";

// SearchBar and CommandPalette inputs:
autoCorrect={isMac ? "off" : undefined}
spellCheck={isMac ? false : undefined}

// AnnotationsPanel note textarea:
autoCorrect={isMac ? "off" : undefined}
```

Notes leave `spellCheck` untouched so native underlines and chosen suggestions remain available. `undefined` omits the new attributes on Linux and Windows. These are deliberate per-element opt-outs: unlike an overridable `registerDefaults(false)` fallback, `autoCorrect="off"` disables native automatic correction in that field. The controlled Mac check did not reproduce the reported capitalization change, so no separate capitalization setting or native preference was added.

### Generated Edit-mode Find/Replace fields

CodeMirror creates these inputs outside its document `contentDOM`, so the document attributes do not cover them. The final follow-up extends the existing listener:

```ts
EditorView.updateListener.of((update) => {
  if (update.docChanged && !applyingExternalDocument) schedulePublication();
  if (isMac && searchPanelOpen(update.state) && !searchPanelOpen(update.startState)) {
    // CodeMirror mounts its search panel before notifying update listeners.
    for (const input of update.view.dom.querySelectorAll(".cm-search input.cm-textfield")) {
      input.setAttribute("autocorrect", "off");
      input.setAttribute("spellcheck", "false");
    }
  }
}),
```

Only the transition from a closed panel to an open panel queries its fields; normal typing does not scan the DOM. CodeMirror mounts the panel before notifying this listener. Closing and reopening creates fresh inputs and reapplies the attributes. The current initial and externally replaced document states start with search closed. No custom panel, observer, timer, or additional state is needed.

Putting `autocorrect` on the outer editor div would not provide the same input contract: form controls inherit that setting from a form owner, not an arbitrary ancestor. Explicit generated-field attributes also keep the document's Mac `spellcheck="true"` intact. [HTML autocorrection rules](https://html.spec.whatwg.org/multipage/interaction.html#autocorrection)

## 5. Verification protocol

Sections 4 and 6 are implemented together. For verification, run the Mac Tauri app with a temporary document. Type a misspelling appropriate to the active spelling language, finish the word, and move the caret away. For English, `I will recieve the package tomorrow.` is a useful fixture. Also type straight quotes, `--`, a URL, and a known text-replacement shortcut to exercise the substitution checks.

Verify red underlines, a native suggestion, a correct replacement, undo/redo, and saving/reopening. Test a fresh app preference state as well as the developer's usual state: a previously enabled native preference can make an incomplete implementation appear successful. Use a temporary test bundle identifier/profile for that check rather than deleting the user's preferences.

Use this verification order:

1. **Fresh defaults:** confirm checking starts enabled and source-text substitutions stay off without prior developer setup. The test confirms the combined implementation; it does not decide whether to add native initialization.
2. **Existing preferences:** confirm explicit checking opt-outs and substitution choices survive restart. Distinguish those choices from a failed registration default.
3. **Editing integrity:** verify replacement, undo/redo, immediate save, and reopening. Investigate any failure in that existing integration path; do not ship visible-only corrections.
4. **Unexpected native behavior:** if resolving it needs private APIs, repeated DOM manipulation, or a custom spelling subsystem, revise the estimate and return the finding for review. Those approaches exceed this small feature.

## 6. Native defaults in the first implementation

The implementation uses one Mac-only startup helper based on WebKit source and the installed Foundation signatures. The WebKit keys are implementation details, not public WKWebView properties. Compile validation is separate from native behavior testing.

Before integration, the five-default helper passed `cargo check --offline` in an isolated temporary package on Apple Silicon with objc2 0.6.4 and objc2-foundation 0.3.2; that compile-only check changed no user preferences. It is now integrated into Bindars and was exercised by the packaged-app checks in the validation record.

Register five fallbacks at app startup, before WebKit first reads its cached text-checking state. Use the public Foundation `registerDefaults` method. Its registration domain is volatile and falls behind existing preferences, so saved user choices remain effective. [Apple's registration API](https://developer.apple.com/documentation/foundation/userdefaults/register(defaults:)), [defaults search order](https://developer.apple.com/documentation/foundation/userdefaults?language=objc)

| WebKit default | Value |
| --- | --- |
| `WebContinuousSpellCheckingEnabled` | `true` |
| `WebAutomaticQuoteSubstitutionEnabled` | `false` |
| `WebAutomaticDashSubstitutionEnabled` | `false` |
| `WebAutomaticTextReplacementEnabled` | `false` |
| `WebAutomaticLinkDetectionEnabled` | `false` |

Implemented helper in [lib.rs](../src-tauri/src/lib.rs):

```rust
#[cfg(target_os = "macos")]
fn register_macos_text_checking_defaults() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        ns_string, NSDictionary, NSNumber, NSString, NSUserDefaults,
    };

    let enabled = NSNumber::numberWithBool(true);
    let disabled = NSNumber::numberWithBool(false);
    let registration = NSDictionary::<NSString, AnyObject>::from_slices(
        &[
            ns_string!("WebContinuousSpellCheckingEnabled"),
            ns_string!("WebAutomaticQuoteSubstitutionEnabled"),
            ns_string!("WebAutomaticDashSubstitutionEnabled"),
            ns_string!("WebAutomaticTextReplacementEnabled"),
            ns_string!("WebAutomaticLinkDetectionEnabled"),
        ],
        &[&*enabled, &*disabled, &*disabled, &*disabled, &*disabled],
    );

    // SAFETY: The dictionary contains string keys and Boolean NSNumbers,
    // which are valid property-list objects for user defaults.
    unsafe {
        NSUserDefaults::standardUserDefaults().registerDefaults(&registration);
    }
}
```

Call it once at the start of `run()`, before `tauri::Builder::default()`:

```rust
pub fn run() {
    #[cfg(target_os = "macos")]
    register_macos_text_checking_defaults();

    // Existing initialization follows.
}
```

Add only the necessary features to the **existing macOS-only** `objc2-foundation` dependency in [Cargo.toml](../src-tauri/Cargo.toml):

```toml
objc2-foundation = { version = "0.3.2", default-features = false, features = [
  "std", "NSObject", "NSGeometry",
  "NSDictionary", "NSString", "NSUserDefaults", "NSValue",
] }
```

`NSValue` provides the generated NSNumber APIs in this binding version. Preserve the existing version and all unrelated manifest changes. Resolve and review any actual lockfile/notice change; do not upgrade packages as part of this feature.

### Native tradeoffs the reviewer should explicitly assess

- **Implementation-dependent keys:** Foundation's registration method is public; the WebKit preference names are implementation details. No smaller documented WKWebView mechanism was found in this review. Keep that maintenance limitation explicit; do not replace it with custom native menu plumbing.
- **Ordering:** Registration must precede WebKit's first text-checker initialization. The start of `run()` is clearer than a late frontend command or a post-webview callback. Verify with a cold launch.
- **User control:** Register a fallback, not an unconditional persistent `setBool(true, ...)` on every launch. Respect existing opt-outs and system policy. If the native menu offers a checking toggle, let WebKit own it.
- **Scope:** Registration affects this app process, not just CodeMirror. Search inputs have explicit spelling/correction opt-outs and notes an automatic-correction opt-out, all Mac-only. This uses three local React attribute changes plus the existing listener for generated Find/Replace fields. Continue to distinguish app-wide substitution defaults from per-element spelling/correction attributes; no field-policy framework is needed.
- **Automatic correction versus substitution:** Keep editor-level `autocorrect="off"` and the four native substitution fallbacks above. Do not expand this to grammar, capitalization, or additional native preferences without a demonstrated need.
- **Preference precedence:** The registered false values prevent fallback to system substitution settings when the corresponding WebKit keys are otherwise unset. They do not override saved app/global values for those same keys. A user's deliberate native Substitutions choice may re-enable a substitution; document and test that behavior rather than resetting it on launch.
- **Boundaries:** No global defaults writes, shell startup commands, private selectors, WKWebView subclass, delegate replacement, async IPC, or settings synchronization machinery.

## 7. Preserve one document and one save path

The intended flow is:

```text
User chooses a native spelling suggestion
    -> WebKit edits the contenteditable text
    -> CodeMirror observes it and updates its document/history
    -> existing update listener schedules buffer publication
    -> existing editor buffer and dirty state update
    -> existing save/flush path writes the corrected document
```

The installed CodeMirror mutation observer reads DOM changes, computes a document diff, and dispatches ordinary input transactions that can enter history and publication. Source tracing supports the integration without additional replacement code. The packaged-app checks separately verified native corrections, undo/redo, and saved contents; source tracing alone would not establish those results. Undo grouping continues to follow CodeMirror's existing rules.

Bindars publishes from CodeMirror state, not raw HTML. A replacement painted on screen is insufficient if `view.state.sliceDoc()` still contains the misspelling.

Do not implement a second replacement handler that also mutates the DOM or writes a file. Do not synthesize extra input events, double-dispatch the correction, or bypass the 200 ms publication/flush mechanism without a reproduced failure and a justified, narrow change.

## 8. Bounded automated checks

The added test in [codemirror-editor.test.cjs](../tests/codemirror-editor.test.cjs) checks the actual mounted editable surface under controlled navigator values:

| Navigator case | Document spellcheck | Find/Replace spellcheck | Find/Replace autocorrect |
| --- | --- | --- | --- |
| Mac (`platform: "MacIntel"`) | `"true"` | `"false"` | `"off"` |
| Non-Mac (`platform: "Linux x86_64"`) | `"false"` | Absent | Absent |

Use explicit expected values, not the production helper to compute the answer. Set all relevant navigator fields consistently, run cases sequentially, await rendering, and restore the original navigator descriptor in `finally`. The existing platform tests provide a local mocking pattern. Keep the accessibility assertions and check that `autocorrect` is `"off"`.

The inspected Happy DOM reports `platform: "X11; Darwin arm64"` on this Mac, which the detector classifies as non-Mac. Relying on the test host would leave the Mac branch untested. Two explicit editor cases suffice; the existing platform-detector tests already cover Windows and other signals.

The same test opens the real generated Find/Replace panel and checks both fields immediately, then closes/reopens it and asserts fresh DOM nodes with the same attributes. Document spellcheck is rechecked after each opening. This verifies mounting order and panel recreation; it does not simulate the native spelling engine.

The existing suite already covers publication, immediate flush, undoable replacements, remounts, external refreshes, formatting changes, and line endings. Reuse those checks. No new state-recreation assertion is needed: the same factory builds every state.

Avoid a mock spelling engine, source-text assertions, fake underline DOM, new test infrastructure, or a test that calls `view.dispatch(...)` and claims to prove native menu replacement. Happy DOM cannot render or exercise macOS spelling UI. A Rust test of dictionary construction would not prove WebKit behavior either.

Run from the project root after implementation:

```sh
npm run build
npm run test:workspace
git diff --check
```

For the native helper and Cargo feature changes, also run:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
```

Use existing license checks if dependency resolution changes. Report unrelated existing failures without expanding this feature into unrelated cleanup.

## 9. Native acceptance checklist

Test the actual Mac Tauri app using temporary files. Development mode is useful initially; finish with a fresh packaged app built from the final source. The installed CLI supports:

```sh
npm run tauri -- dev
# After the implementation is settled:
npm run tauri -- build --bundles app
```

Record macOS version, app build/source, spelling language, preference state, and actual results. The table below defines the acceptance protocol; it does not assert that every row passed. See [the completed validation record](macos-spellcheck-validation.md) for verified results, observed limitations, and remaining release coverage.

| Check | Expected result |
| --- | --- |
| Cold start with fresh defaults | Checking is available without a developer having previously enabled it. A saved user opt-out is respected in a separate check. |
| Type and finish a misspelled word | Red underline appears through native behavior; the word does not silently change. Also test with native automatic correction enabled in the isolated test profile, so an already-disabled preference cannot mask a failure of `autocorrect="off"`. Preserve the user's global settings and allow normal OS timing. |
| Literal source typing | With fresh app WebKit preferences and native system smart substitutions enabled in a test profile, type straight quotes, apostrophes, `--`, a URL, and a configured text-shortcut trigger. They remain literal in CodeMirror state and in the saved/reopened file. Include ordinary prose and Markdown code; the fix must not depend on code-fence exclusions. |
| Explicit substitution preferences | If a native Substitutions control is available, deliberately enable one in the isolated profile and restart. Its saved choice wins over registration. Restore the test choice; never modify the user's global settings to make this test pass. |
| Right-click and choose a suggestion | Native suggestions appear for a suitable fixture; only the intended word changes. Nearby punctuation and Markdown source survive. Continued typing works. |
| Undo and redo | Cmd-Z restores the misspelling and Cmd-Shift-Z reapplies the correction through normal document history. |
| Correct, then immediately save | The corrected text reaches disk even before the normal publication delay expires. Reopen the actual file to verify. |
| Correct, then allow autosave | Reopening yields the corrected text; no spelling-specific persistence logic is needed. |
| Leave and re-enter Edit mode | Corrected text remains; spelling assistance still works. |
| Markdown and Fountain | Test prose in both formats, a Markdown heading, and a formatting toggle. No loss of content or broken selection. |
| Open existing text, paste, and scroll | Record when existing/pasted/newly visible words receive underlines. Native checking may be incremental; do not claim an immediate complete-document scan. |
| Other Mac editable fields | With native automatic correction enabled in the isolated app profile, Read search and quick-switcher queries remain literal without underlines. Notes remain literal until a native suggestion is chosen, then save through the existing note path. |
| Edit-mode Find/Replace | With that preference enabled, both fields remain literal after blur and after panel close/reopen, without underlines. Case-sensitive Find targets the intended case; Replace preserves its exact text on disk. Focus the document for replacement undo/redo. Document spelling still works after closing the panel. |
| Non-Mac boundary | Linux/Windows document-editor spellcheck remains false; generated search fields are not mutated and new React search/note attributes are omitted. No new Linux native configuration, package, or checker initialization appears in the diff. |

Spot-check underlines in a light and dark theme. Keep the OS underline appearance; do not add CSS drawing code for it. Test on macOS 15 as well as the current development system when available, or explicitly record that the declared minimum remains unverified.

**Required before shipping:** useful red underlines, native suggestions, correct replacement/undo/redo, no automatic spelling correction, literal source typing under the registered substitution defaults, and correct persisted contents in the real Mac app. Slow or inconsistent checking of untouched text must be reported as a limitation; failed core editing, unexpected source rewriting, or saving failure is a blocker. Do not generalize results to macOS versions or newer text-checker paths that were not tested.

## 10. Change size and stopping rule

The implementation changes the editor configuration, its existing test, one Mac-only startup helper/call, features on an existing Mac-only dependency, three field components, and the description of verified behavior. All five native defaults belong in the same helper; they do not justify a preferences framework.

Do not introduce a spell-check service interface, providers, dictionaries, workers, scanning schedules, tokenization, underline decorations, custom menus, telemetry, or a broad platform refactor for this scope. Do not add a settings UI merely because a boolean exists.

If native behavior fails the required checks and the fix would require that infrastructure, stop expanding the implementation. Report the reproduced limitation and a revised proposal. The earlier “small feature” assessment is conditional on the native path working; it is not a commitment to build a custom spelling system.

## 11. Original pre-implementation review prompt

> Review this proposal before implementation. The goal is Mac-only red spelling underlines and native right-click corrections in Bindars' existing CodeMirror editor. Linux must keep its current behavior. Our highest design priority is reducing unnecessary complexity: prefer boring, functional code and the smallest verified change.
>
> Inspect the referenced project files and primary sources. Challenge the plan rather than assuming it is correct. Specifically assess: (1) the platform-gated content attribute; (2) the five native defaults, including suppression of source-text substitutions; (3) the public-API versus implementation-detail distinction for WKWebView and its preference keys; (4) startup ordering, preference precedence, and effects on other fields; and (5) whether native replacements will reach CodeMirror history and the existing save path. Distinguish source tracing from actual native test results.
>
> Recommend the smallest implementation you can defend, identify anything to remove, and distinguish confirmed facts from runtime assumptions. Check whether the proposed automated and Mac acceptance tests prove the required behavior without unnecessary test scaffolding. Do not implement the feature during this review, and do not propose a custom spelling subsystem unless the native approach has been demonstrated to be inadequate.
