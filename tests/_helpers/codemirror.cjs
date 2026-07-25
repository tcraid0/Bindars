const { EditorView } = require("@codemirror/view");

function findEditorView(host) {
  const editorDom = host.querySelector(".cm-editor");
  if (!editorDom) throw new Error("Expected a mounted CodeMirror editor.");
  const view = EditorView.findFromDOM(editorDom);
  if (!view) throw new Error("Expected CodeMirror to own the editor DOM.");
  return view;
}

function replaceEditorDocument(view, content) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: content },
  });
}

module.exports = { findEditorView, replaceEditorDocument };
