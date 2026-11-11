const { EditorSelection, EditorState } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { history } = require("@codemirror/commands");
const { forceParsing } = require("@codemirror/language");
const { markdownFormattingExtensions } = require("../../.tmp/workspace-tests/src/components/markdown-decorations.js");

function notation(spec) {
  const caret = spec.indexOf("|");
  const open = spec.indexOf("[[");
  const close = spec.indexOf("]]");
  if (open >= 0 && close > open) {
    const doc = spec.slice(0, open) + spec.slice(open + 2, close) + spec.slice(close + 2);
    return {
      doc,
      selection: EditorSelection.single(open, close - 2),
    };
  }
  if (caret >= 0) {
    return {
      doc: spec.slice(0, caret) + spec.slice(caret + 1),
      selection: EditorSelection.cursor(caret),
    };
  }
  throw new Error(`Missing selection in ${spec}`);
}

function createView(doc, selection, { lineSeparator = "\n", markdown = true, readOnly = false, language, parse = true } = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const extensions = [
    EditorState.lineSeparator.of(lineSeparator),
    EditorState.allowMultipleSelections.of(true),
    history(),
  ];
  if (readOnly) extensions.push(EditorState.readOnly.of(true));
  if (language) extensions.push(language);
  else if (markdown) extensions.push(markdownFormattingExtensions(true));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection, extensions }),
  });
  if (markdown && parse) forceParsing(view, view.state.doc.length, 2000);
  return {
    view,
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

function withView(doc, selection, options, run) {
  const host = createView(doc, selection, options);
  try {
    return run(host.view);
  } finally {
    host.destroy();
  }
}

function useSpec(spec, options, run) {
  const parsed = notation(spec);
  return withView(parsed.doc, parsed.selection, options, run);
}

function selected(view) {
  const range = view.state.selection.main;
  return view.state.sliceDoc(range.from, range.to);
}

module.exports = { notation, createView, withView, useSpec, selected };
