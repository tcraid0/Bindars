const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { mockIPC, clearMocks } = require('@tauri-apps/api/mocks');
const { ConfirmDialog } = require('../.tmp/workspace-tests/src/components/ConfirmDialog.js');
const { ToastProvider, useToast } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
const { AnnotationsPanel } = require('../.tmp/workspace-tests/src/components/AnnotationsPanel.js');
const noop = () => {};

test('modal isolation preserves prior inertness and puts toast controls inside the active dialog', async t => {
  const host = document.createElement('div'); host.id = 'root'; host.setAttribute('inert', ''); document.body.append(host);
  const root = createRoot(host); let hide;
  function Probe() {
    const [open, setOpen] = React.useState(true); hide = () => setOpen(false);
    const { toast } = useToast();
    return React.createElement(ConfirmDialog, { visible: open, title: 'Save', message: 'Keep your file', confirmLabel: 'Try', cancelLabel: 'Cancel',
      onConfirm: () => toast('Could not save', 'error'), onCancel: hide, onDismiss: hide });
  }
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(ToastProvider, null, React.createElement(Probe)))));
  const dialog = document.querySelector('#dialog-root [role=dialog]');
  assert.ok(dialog); assert.equal(host.contains(dialog), false); assert.ok(host.hasAttribute('inert'));
  await act(async () => [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Try').click());
  assert.match(dialog.textContent, /Could not save/);
  assert.ok(dialog.querySelector('button[aria-label="Dismiss notification"]'));
  await act(async () => hide());
  assert.ok(host.hasAttribute('inert'), 'an existing inert state must survive modal cleanup');
  assert.ok(document.querySelector('#dialog-root [role=dialog]') === null);
});

test('the annotations panel restore confirmation is portalled outside its inert background', async t => {
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host);
  const root = createRoot(host); const path = '/synthetic/document.md';
  mockIPC(command => {
    if (command === 'plugin:dialog|open') return '/synthetic/recovery.json';
    if (command === 'read_annotation_recovery') return { documents: { [path]: { version: 3, highlights: [], bookmarks: [] } } };
    throw Error(command);
  });
  t.after(async () => { await act(async () => root.unmount()); host.remove(); clearMocks(); });
  const props = { visible: true, filePath: path, onRestoreRecord: noop, annotationStatus: 'ready', annotationsReady: true,
    loadError: null, saveError: null, canRetrySave: false, highlights: [], bookmarks: [], onRetryLoad: noop, onRetrySave: noop,
    onRemoveHighlight: noop, onUpdateHighlight: noop, onClickHighlight: noop, onClickBookmark: noop, onClose: noop, fileName: 'document.md', headings: [] };
  await act(async () => root.render(React.createElement(ToastProvider, null, React.createElement(AnnotationsPanel, props))));
  const opener = [...host.querySelectorAll('button')].find(b => b.textContent === 'Restore recovery copy'); opener.focus();
  await act(async () => { opener.click(); await new Promise(setImmediate); });
  const dialog = document.querySelector('#dialog-root [role=dialog]');
  assert.ok(dialog); assert.ok(host.hasAttribute('inert')); assert.equal(host.contains(dialog), false);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(host.hasAttribute('inert'), false); assert.ok(document.activeElement === opener);
});
