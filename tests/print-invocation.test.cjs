const test = require("node:test");
const assert = require("node:assert/strict");
const { mockIPC, clearMocks } = require("@tauri-apps/api/mocks");
const { installDom } = require("./_helpers/dom.cjs");
const { invokePrint } = require("../.tmp/workspace-tests/src/lib/print-invocation.js");

test("native invocation waits for its command result and never falls back on error", async (t) => {
  await installDom();
  const originalPrint = window.print;
  window.print = () => {};
  t.after(() => { window.print = originalPrint; });
  const browserPrint = t.mock.method(window, "print", () => {});
  let settle;
  mockIPC((command, args) => {
    assert.equal(command, "print_current_webview");
    assert.deepEqual(args, {});
    return new Promise((resolve, reject) => { settle = { resolve, reject }; });
  });
  try {
    let finished = false;
    const pending = invokePrint(true).then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    settle.resolve("cancelled-or-failed");
    await pending;
    assert.equal(finished, true);
    const failed = invokePrint(true);
    settle.reject(new Error("native setup failed"));
    await assert.rejects(failed, /native setup failed/);
    assert.equal(browserPrint.mock.callCount(), 0);
  } finally { clearMocks(); }
});

test("the browser path preserves window.print and awaits invocation errors", async (t) => {
  await installDom();
  const originalPrint = window.print;
  window.print = () => {};
  t.after(() => { window.print = originalPrint; });
  const browserPrint = t.mock.method(window, "print", () => {});
  await invokePrint(false);
  assert.equal(browserPrint.mock.callCount(), 1);
  browserPrint.mock.mockImplementation(() => Promise.reject(new Error("bridge failed")));
  await assert.rejects(invokePrint(false), /bridge failed/);
});
