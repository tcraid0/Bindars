# Print Test Matrix

Use this checklist when validating Binder PDF export changes.

## Platforms

| Platform | Webview | Status |
| --- | --- | --- |
| Linux | WebKit2GTK | [ ] |
| Windows | WebView2 | [ ] |

## Modes

For each platform, verify:

- [ ] Standard layout, theme off
- [ ] Standard layout, theme on
- [ ] Book layout, theme off
- [ ] Book layout, theme on

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

- [ ] Print dialog opens without leaving Binder stuck in print mode afterward
- [ ] Header, sidebar, overlays, and controls do not appear in the PDF
- [ ] Fonts look correct in the exported PDF
- [ ] Slow or broken images do not block print for more than a few seconds
- [ ] Mermaid diagrams render as SVG in the PDF when they finished loading onscreen
- [ ] Standard layout reads continuously without unnecessary section breaks
- [ ] Book layout starts major sections on new pages
- [ ] Tables do not overflow page width and keep headers readable
- [ ] Code blocks, blockquotes, images, and diagrams avoid awkward page splits where possible
- [ ] Fountain output remains readable and uses screenplay-style spacing
