const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const {
  AppErrorBoundary,
} = require("../.tmp/workspace-tests/src/components/AppErrorBoundary.js");

test("app error boundary exposes a stable diagnostic selector", () => {
  const boundary = new AppErrorBoundary({ children: React.createElement("main") });
  boundary.state = { error: new Error("render failed") };

  const markup = renderToStaticMarkup(boundary.render());

  assert.match(markup, /data-testid="app-error-boundary"/);
  assert.match(markup, /Bindars hit an unexpected error/);
});

for (const initiallyCrashed of [false, true]) for (const event of ["bindars://quit-requested", "tauri://close-requested"]) {
  test(`the crash screen answers ${event} in Strict Mode (initial crash=${initiallyCrashed})`, async (context) => {
    const { installDom } = require("./_helpers/dom.cjs");
    const { flushSync } = require("./_helpers/react.cjs");
    const { createRoot } = require("react-dom/client");
    const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
    const { emit } = require("@tauri-apps/api/event");
    const { useNativeQuit } = require("../.tmp/workspace-tests/src/hooks/useNativeQuit.js");
    await installDom();
    mockWindows("main");
    let exits = 0;
    let oldRequests = 0;
    mockIPC(command => {
      assert.equal(command, "exit_after_guarded_quit");
      exits += 1;
    }, { shouldMockEvents: true });
    context.mock.method(console, "error", () => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function Child({ crash }) {
      useNativeQuit({ onQuitRequested: () => { oldRequests += 1; } });
      if (crash) throw new Error("render failed");
      return React.createElement("main", null, "Healthy view");
    }
    const render = crash => flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(AppErrorBoundary, null, React.createElement(Child, { crash })))));
    try {
      await React.act(async () => render(initiallyCrashed));
      if (!initiallyCrashed) await React.act(async () => render(true));
      assert.ok(host.querySelector('[data-testid="app-error-boundary"]'));
      await React.act(async () => emit(event));
      assert.equal(oldRequests, 0, "the old tree's quit listener must be gone");
      assert.equal(exits, 1, "the crash screen must use the normal native exit command");
      await React.act(async () => root.unmount());
      await React.act(async () => emit(event));
      assert.equal(exits, 1, "unmount must detach the crash listener");
    } finally {
      await React.act(async () => root.unmount());
      host.remove();
      clearMocks();
    }
  });
}
