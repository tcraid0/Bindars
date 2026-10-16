const Module = require("node:module");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { mockIPC } = require("@tauri-apps/api/mocks");

function loadApp() {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request.endsWith("welcome.md?raw")) return "# Welcome fixture\n\nSave with {{shortcut:saveFile}}.";
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require("../../.tmp/workspace-tests/src/App.js").default; }
  finally { Module._load = originalLoad; }
}

function createAppView({ ipc, strictMode = false, wrap = app => app, observedHeadings = new Set() }) {
  const originalObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    observe(node) { observedHeadings.add(node); }
    unobserve(node) { observedHeadings.delete(node); }
    disconnect() { observedHeadings.clear(); }
  };
  mockIPC(ipc, { shouldMockEvents: true });
  const App = loadApp();
  const { ToastProvider } = require("../../.tmp/workspace-tests/src/components/ToastProvider.js");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const app = React.createElement(App);
  return {
    host,
    render(...args) {
      const content = React.createElement(ToastProvider, null, wrap(app, ...args));
      flushSync(() => root.render(strictMode ? React.createElement(React.StrictMode, null, content) : content));
    },
    async cleanup() {
      await React.act(async () => {
        root.unmount();
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      host.remove();
      globalThis.IntersectionObserver = originalObserver;
    },
  };
}

module.exports = { createAppView, loadApp };
