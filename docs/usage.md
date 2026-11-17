# Using Bindars

[Back to the README](../README.md) · [Installation](installation.md)

## Try an example

On the first launch, choose **Try an Example…** and save a copy to try
highlighting and notes; an empty Home offers it too. Select a passage and
choose **Note**, or choose **Add note** on an existing highlight.
Reopen your saved copy from Home, **Recent**, **Open**, or your file manager.
Choosing **Try an Example…** again asks where to save a fresh copy;
confirming replacement writes the example text over the file you choose.

## Features

- GFM tables, task lists, footnotes, and smart typography
- Mermaid diagrams and KaTeX math rendering (`$$x^2$$` inline, `$$` blocks for display math; single `$` is reserved for plain text so dollar amounts in prose render as written)
- Syntax-highlighted code blocks (highlight.js)
- Four themes: light, sepia, dark, midnight
- Contents with scroll tracking; it starts open and remembers if you close it
- Highlights & notes, plus bookmarks for returning to headings
  (Shift+Cmd+M on macOS or Ctrl+Shift+M on Linux shows or hides them)
- Recent, Drafts, and an optional folder browser, with Search documents and passage navigation
- Persistent whole-interface zoom, separate from reading typography
- Fountain screenplay rendering with character focus and scene navigation
- Focus mode and presentation mode
- Visible Read/Edit controls that keep your reading position, with undo history and find/replace while editing
- Show the opened file in Finder (macOS) or its folder from either Read or Edit mode
- Autosave within 10 seconds, and new documents saved as ordinary files in a Bindars Drafts folder ([how saving works](recovery-and-privacy.md)), with external-change reconciliation. Save updates an ordinary open file at its current location; the filename and location dialog is used for new documents and drafts, Make a copy, and errors that offer Save As
- A Markdown formatting toolbar, with Styled and Plain writing views
- macOS spelling underlines and native right-click suggestions while editing
- Print the document or save it as PDF; export highlights and notes separately as Markdown
- Keyboard-driven workflow - choose **Help > Keyboard Shortcuts** on macOS or
  press Ctrl+? on Linux for the full shortcut list

See [highlights, notes, and recovery](annotations.md) for location, saving,
and document-path limitations. You can also paste plain text into a new document.
Bindars opens `.md`, `.markdown`, and `.fountain` files; it does not import Word
or PDF documents.

## Formatting while writing

Open a Markdown document and choose **Edit**. The formatting bar stays above
your writing as you scroll. You can use its buttons, type Markdown yourself,
or mix both. The saved file is still ordinary Markdown. Fountain files have
no Markdown formatting bar.

| Control | What it does |
| --- | --- |
| **Paragraph** menu | Choose Paragraph, Heading, Subheading, or Small heading for the current line. |
| **Bold** | Make the selected text, or the word containing the cursor, bold. Choose it again to remove bold. |
| **Bullets** / **Numbered** | Start a list or turn selected ordinary lines into list items. |
| **Checklist** | Turn ordinary lines or list items into a checklist. |
| **More → Divider** | Insert a dividing line after the current block, with space to keep writing below it. |
| **More → Italic** | Make the selected text, or the current word, italic. Choose it again to remove italic. |
| **More → Link** | Enter the link text and put its address in **Link to**, then choose **Add link**. Selected plain text fills in the link text. |
| **More → Quote** | Turn an ordinary paragraph into a quote, or remove a simple quote's markers. |
| **More → Indent more / Indent less** | Move supported list items one level in or out. |
| **More → Mark done / Mark not done** | Mark the task on the cursor's line done, or open it again (Cmd+L). |
| **Styled / Plain** | Change how Markdown looks while writing. This does not change the file's text. |

Type some text before choosing Bold or Italic. You can also select a phrase,
including its punctuation. On an empty line, or where there is no word at the
cursor, these actions leave the text alone and explain that you need to select text. They do not
turn on a style for the next words you type.

To change existing lines, select them first. For a heading, use one ordinary
line. For a list, select the lines and choose Bullets or Numbered. Pasted
bullet symbols such as `•` can be converted with Bullets.

To make a sub-item, put the cursor in a list item after another item, then
choose **More → Indent more**. This also works in numbered lists, including under
`1.` and `10.`. **Indent less** moves a sub-item back. If later sub-items would be left
behind, select those trailing items together. Press Enter to continue a list.
Press Enter again on an empty top-level item to finish it and write a normal
paragraph.

Some selections cannot be converted safely. For example, a link that continues
onto the next source line cannot be split into separate bullets. Bindars leaves
the text unchanged and gives a short explanation.

Styled shows headings, emphasis, list alignment, and dividers while keeping the
Markdown marks visible. Plain uses plain markup. **Read** shows the rendered
document. Document Bold and Italic are separate from your personal
[highlights and notes](annotations.md).

To finish a task in Styled view, click its `[ ]` box; click `[x]` to open it again.
Clicking the words still just places the cursor. In Styled or Plain, you can also
put the cursor on the task's first line and press Cmd+L (Ctrl+L on Linux), or choose
**More → Mark done**. Each change is one Undo step. Plain view has no clickable box.
Checkboxes in Read show the saved state; they are not clickable. **Checklist**
makes or removes a checklist; it does not mark tasks done.

### Formatting shortcuts on macOS

| Shortcut | Action |
| --- | --- |
| Cmd+E | Switch between Read and Edit. |
| Cmd+B / Cmd+I | Bold / Italic in the Markdown editor. |
| Cmd+L | Mark the task on the cursor's line done, or not done. |
| Esc | Leave Edit and go back to Read. Esc closes Find or an open menu first. |
| Cmd+] / Cmd+[ | Indent / outdent a list item. |
| Option+F10 | Move from the editor to the formatting bar. |
| Option+Cmd+M | Switch Styled / Plain. |
| Cmd+Z / Shift+Cmd+Z | Undo / redo. Each formatting change is one step. |
| Cmd+F | Open Find while editing. Escape closes Find first. |
| Cmd+K | Open Search documents. |

In the formatting bar, use Left and Right to move between controls. Enter
opens a menu or applies an action. Up or Down on Paragraph or More opens its
menu. Use Up and Down within a menu. Escape
closes the menu; Escape from the bar returns to writing. Tab continues past
the bar or leaves the editor; it does not indent a list.

To write in Focus mode, enter Focus from Read with Shift+Cmd+F, then switch to
Edit with Cmd+E. The formatting bar stays available. See **Help → Keyboard
Shortcuts** for the full list of keys on your platform.

After revising an annotated document, use Read to check your highlights.
[Highlight location and passage recovery](annotations.md#edits-made-in-bindars)
explain which edits keep a passage located and how to place an uncertain one.

## Spelling on macOS

In Edit mode, macOS can underline misspelled words and offer corrections when
you right-click them. Notes also retain native spelling assistance. Automatic
spelling correction is off in both fields; Find in Document, Search documents,
and Edit-mode Find/Replace disable autocorrection and spelling underlines to keep
search and replacement text literal.
Checking follows native timing, so existing text may not be marked until you
edit it. These field controls apply only on macOS; Linux behavior is unchanged.

Quotes, dashes, text shortcuts, and URLs stay literal by default; saved native
Substitutions choices can override those defaults. See the
[validation notes](macos-spellcheck-validation.md) for tested behavior
and remaining platform coverage.

## Finding documents

**Home** is where you choose what to read next. It lists your five most recent
documents by their own titles, with the section you were in and when you last
opened each; **Continue at** and its section mark the one you were reading.
**Open File…** and **New** sit beside the heading; until Home lists three
documents, ways to start sit below the list instead. Go there with the **Home**
button after Back and Forward,
Shift+Cmd+H on macOS or Alt+Home on Linux, or **File › Home** on macOS. Going
Home from an edited document saves or asks first, as opening another file does.
Bindars reopens where you left off: the document you were reading, at its
section, or Home if you left from Home. A file you open from Finder, the command
line or a drop always comes first. **Back**
and **Forward** include Home, and Back returns from every way of opening a
document.

Bindars opens documents where they already are. **Recent** holds the last 25
opened documents from any location. Its rows keep their order while you use the
sidebar, returning to most-recent-first when you hide and show it or relaunch.
Resizing the window does not reshuffle it.
New documents enter at the top. Home, Recent, and Search use a document's title
when available, keeping its exact filename alongside it when distinct. While
titles are being prepared, filenames appear immediately. Recent shows folder
context when filenames collide. Hover over a row or focus it with the keyboard
for its full location and **Last opened** details. Page Up / Page Down scroll long
details while the row is focused; Escape dismisses them.
Home and Search keep their richer context visible. **Back** returns to documents
opened from Recent. Locations leave out your own home folder; documents directly
in it say “Home folder”. Other accounts and Shared keep their names.

Removing a document from Recent leaves an untimed **Add Back** notice, shared
with Home. Add Back preserves its previous last-opened time and restores the latest
section, including reading progress made while the document was removed.
The notice stays until you add it back, dismiss it, reopen that document, remove
another entry, or end the session. Files and notes are unchanged.

The sidebar starts hidden and remembers your choice. A one-time note offers
**Show Sidebar** when you open a second distinct document; if the reading hint
is showing, it waits for a later document open. Use the toolbar button or
Cmd+B / Ctrl+B outside the Markdown editor to show or hide it;
on macOS, **View › Show Sidebar / Hide Sidebar** is also available.

**Drafts** lists existing files in Documents › Bindars Drafts, including drafts
no longer in Recent, using a heading or opening text alongside the filename.
New documents are saved here until you save them somewhere else. The shared
Drafts location is disclosed once above the list, with full file paths retained
for recovery notices. The header and folder browser keep filenames.

On macOS, Drafts isn't listed at first, so a first launch doesn't ask for access
to your Documents folder. Choose **Show earlier drafts** to list it; your Mac
may ask first. Once Bindars has saved a draft or found existing ones, later
launches list Drafts automatically.

In **Folders**, choose **Add Folder…** to browse one folder's supported files and
subfolders that contain documents. Your files stay where they are. The picker starts in the folder of the
document you are reading. Opening another file does not add or scan its parent
folder, and saving a document keeps its place in the folder list. Browsing does
not change where new documents autosave. Choose an ancestor in the breadcrumb
path to navigate up. Browsing stays in your chosen directory when you open a
document elsewhere. **Folder options** contains **Choose another folder…**, full
folder and current locations, and **Remove from Sidebar**. Removal affects only
this folder reference; the inline, untimed **Add Back** action restores it.
Neither action moves or deletes documents or notes. Tabs, Search, and compact
folder context stay visible while browsing; at short window heights or high
interface zoom, the whole sidebar scrolls so every control remains reachable.

**Search documents** (Cmd+K / Ctrl+K) searches Recent, Drafts, and the added folder.
Its **Search in** menu can narrow results to that folder. Unquoted words may occur in
any order; double quotes request a phrase within a text block. Results group by
document, with separate passage counts. Filename/title matches rank first, then
exact phrases, nearby terms, and scattered terms. Up to 50 documents and five
passages per document are shown, with totals when results are truncated.

Choose a passage to open it and highlight the requested occurrence, including
in the document already open. Repeated passages keep their occurrence. A changed
or unresolved passage produces an explanation and refreshes search. **Find in
Document** (Cmd+F / Ctrl+F) finds a phrase in the displayed document; only valid
phrase results populate it. Unordered-term results highlight their passage
without putting search operators into Find.

Use Cmd+G / Ctrl+G for the next Find match and Shift+Cmd+G / Ctrl+Shift+G
for the previous match.

Both searches ignore case, ordinary prose whitespace, and soft line breaks.
They equate straight/curly quotes, `--`/en dash, `---`/em dash, and `...`/ellipsis.
Other punctuation stays literal. Find includes displayed code and rendered
math, retaining their literal punctuation and whitespace. Document Search excludes code, math,
diagrams and images, and covers the first 30,000 extracted body characters plus
headings and names. These forgiving search rules do not change how highlights
and notes find their place.

Files appear before text preparation finishes and remain findable by filename
when reading or parsing fails. Status and recovery actions distinguish missing,
unreadable, invalid-encoding, oversized and overly complex documents. There is
no promise that every discovered file can be displayed. The folder browser skips
hidden folders, `node_modules`, `target`, `vendor`, and symbolic links. Discovery
is bounded to 5,000 documents per folder/Drafts source, 100,000 visited entries,
20,000 subfolders and 32 levels. Folders and Drafts each say when only part of
their list could be shown. Folder problems name the affected place with a short
reason, such as “not allowed”.
Lists initially render 100 entries and provide buttons for more.

Successful saves update Search immediately. Returning to the app reconciles
external changes; unchanged file size and modification time avoid reparsing.
Discovery and text work publish incrementally and discard obsolete results when
the configured folder changes. Continuous folder watching is not enabled.
Actual incoming links live in the collapsed **Linked from** section in Contents;
**Unlinked mentions** remains a separate collapsed section. Each section appears
only when it has entries.

## Interface zoom

Use **View** or Cmd+plus/minus (Ctrl equivalents on Linux) to zoom the entire
interface from 75% to 300%. Cmd+0 / Ctrl+0 chooses **Actual Size** and changes only
interface zoom. Zoom is saved between launches. Reader settings still provides
independent text size, fonts, spacing, Reduced effects, and its explicit Reset.

## Rendering rules

- Raw HTML in Markdown is removed, not rendered: `<br>`, `<details>`, `<img>`,
  and similar tags disappear and only the Markdown around them is shown.
- Images must be relative paths inside the document's folder (or a subfolder).
  Remote images, `data:` URLs, and absolute paths are not loaded. A `../`
  segment is allowed only while the resolved path stays inside that folder.
  Image shortcuts (symbolic links) must also resolve inside that folder.
  Images larger than 20 MiB are not loaded, and images are served only for
  the document currently open in the reader.
- Links to other `.md`, `.markdown`, and `.fountain` files open in the reader,
  including `../` paths. `http(s)` and `mailto` links open in your system
  browser or mail client; other URL schemes are removed.
