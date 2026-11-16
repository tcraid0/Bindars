const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { act } = React;
const { createRoot } = require("react-dom/client");
const { mockIPC, clearMocks } = require("@tauri-apps/api/mocks");
const store = require("../.tmp/workspace-tests/src/lib/store.js");
const {
  shouldAskAboutUpdates,
  downloadPercent,
  installFailureMessage,
} = require("../.tmp/workspace-tests/src/lib/updates.js");
const { useUpdates } = require("../.tmp/workspace-tests/src/hooks/useUpdates.js");
const { UpdateDialog } = require("../.tmp/workspace-tests/src/components/UpdateDialog.js");

const AVAILABLE = { kind: "available", current: "1.6.4", version: "1.6.5", installable: true };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Mounts the hook on macOS with the given native answers. */
async function mountUpdates(t, { ipc = {}, storeGet = async () => null, storeSet = async () => true } = {}) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  const saved = [];
  t.mock.method(store, "storeGet", storeGet);
  t.mock.method(store, "storeSet", async (key, value) => {
    saved.push([key, value]);
    return storeSet(key, value);
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  const commands = [];
  mockIPC((command, args) => {
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten") return null;
    commands.push([command, args]);
    if (command in ipc) return ipc[command](args);
    throw new Error(`Unexpected IPC command: ${command}`);
  });
  t.after(clearMocks);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const mounted = { api: null, restartRequests: 0, errors: [], saved, commands, unmounted: false };
  function Probe() {
    mounted.api = useUpdates({
      requestRestartForUpdate: () => { mounted.restartRequests += 1; return "accepted"; },
      notifyError: (message) => { mounted.errors.push(message); },
    });
    return React.createElement("div");
  }
  mounted.unmount = async () => {
    if (mounted.unmounted) return;
    mounted.unmounted = true;
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(React.createElement(Probe)));
  t.after(mounted.unmount);
  await settle();
  return mounted;
}

const called = (mounted, command) => mounted.commands.filter(([name]) => name === command);

test("the one-time update question is asked from the second launch on and only while unchecked", () => {
  assert.equal(shouldAskAboutUpdates(null, false), false);
  assert.equal(shouldAskAboutUpdates(0, false), false);
  assert.equal(shouldAskAboutUpdates(1, false), true);
  assert.equal(shouldAskAboutUpdates(5, true), false);
});

test("download progress rounds down to whole percent and needs a total", () => {
  assert.equal(downloadPercent(50, 200), 25);
  assert.equal(downloadPercent(300, 200), 100);
  assert.equal(downloadPercent(10, null), null);
  assert.equal(downloadPercent(10, 0), null);
});

test("install failures explain where the previous Bindars went", () => {
  const keptPath = "/Users/a/Bindars (previous version).app";
  assert.match(
    installFailureMessage({ kind: "previous-app-kept", path: keptPath }),
    new RegExp(keptPath.replace(/[()]/g, "\\$&")),
  );
  assert.equal(
    installFailureMessage({ kind: "failed", detail: "x" }),
    "The update could not be completed. Bindars has not restarted.",
  );
  assert.equal(
    installFailureMessage(new Error("x")),
    "The update could not be completed. Bindars has not restarted.",
  );
});

test("the update feature adds no network surface beyond the release endpoint", () => {
  const root = path.join(__dirname, "..");
  const capabilities = fs.readFileSync(path.join(root, "src-tauri/capabilities/default.json"), "utf8");
  assert.ok(!capabilities.includes("updater"), "the updater must not appear in the capability list");
  const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
  assert.ok(!packageJson.includes("plugin-updater"), "no npm updater package may be added");
  const tauriConf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.ok(tauriConf.app.security.csp.includes("connect-src 'none'"));
  assert.deepEqual(
    tauriConf.plugins.updater.endpoints,
    ["https://github.com/tcraid0/Bindars/releases/latest/download/latest.json"],
  );
  assert.equal(tauriConf.plugins.updater.requireSignedVersion, true);
});

test("a manual check from the Updates dialog reports an available update", async (t) => {
  const mounted = await mountUpdates(t, { ipc: { check_for_update: () => AVAILABLE } });
  await act(async () => { mounted.api.openDialog(); });
  await settle();
  assert.deepEqual(mounted.api.phase, AVAILABLE);
  assert.equal(mounted.api.dialogOpen, true);
  assert.equal(mounted.api.markerVisible, true);
  assert.deepEqual(called(mounted, "check_for_update"), [["check_for_update", { manual: true }]]);
});

test("a failed check says so and leaves Check Again available", async (t) => {
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: () => { throw { kind: "failed", detail: "offline" }; } },
  });
  t.mock.method(console, "warn", () => {});
  await act(async () => { mounted.api.openDialog(); });
  await settle();
  assert.equal(mounted.api.phase.kind, "idle");
  assert.equal(mounted.api.problem, "Couldn't check for updates. Try again later.");
});

test("a download the user hid does not restart the app by itself", async (t) => {
  let download = deferred();
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: () => AVAILABLE, download_update: () => download.promise },
  });
  await act(async () => { mounted.api.openDialog(); });
  await settle();
  await act(async () => { mounted.api.install(); });
  await settle();
  assert.equal(mounted.api.phase.kind, "downloading");
  assert.equal(mounted.api.markerVisible, true);

  await act(async () => { mounted.api.closeDialog(); });
  assert.equal(mounted.api.dialogOpen, false);
  assert.equal(mounted.api.phase.kind, "downloading");

  await act(async () => { download.resolve(null); });
  await settle();
  assert.deepEqual(mounted.api.phase, AVAILABLE);
  assert.equal(mounted.restartRequests, 0);

  // Pressing Install and Restart again, with the dialog open, hands over to the guard.
  download = deferred();
  await act(async () => { mounted.api.openDialog(); });
  await act(async () => { mounted.api.install(); });
  await settle();
  await act(async () => { download.resolve(null); });
  await settle();
  assert.equal(mounted.restartRequests, 1);
  assert.equal(mounted.api.dialogOpen, false);
});

test("a hidden download that fails reopens the dialog and keeps the update available", async (t) => {
  const download = deferred();
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: () => AVAILABLE, download_update: () => download.promise },
  });
  t.mock.method(console, "warn", () => {});
  await act(async () => { mounted.api.openDialog(); });
  await settle();
  await act(async () => { mounted.api.install(); });
  await settle();
  await act(async () => { mounted.api.closeDialog(); });

  await act(async () => { download.reject({ kind: "failed", detail: "connection lost" }); });
  await settle();
  assert.equal(mounted.api.dialogOpen, true);
  assert.equal(mounted.api.problem, "Couldn't download the update. Try again later.");
  assert.deepEqual(mounted.api.phase, AVAILABLE);
  assert.equal(mounted.api.markerVisible, true);
  assert.equal(mounted.restartRequests, 0);
});

test("two quick presses of Install and Restart start one download", async (t) => {
  const download = deferred();
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: () => AVAILABLE, download_update: () => download.promise },
  });
  await act(async () => { mounted.api.openDialog(); });
  await settle();
  await act(async () => {
    mounted.api.install();
    mounted.api.install();
  });
  await settle();
  assert.equal(called(mounted, "download_update").length, 1);
});

test("a download that finishes after the app view is gone asks for no restart", async (t) => {
  const download = deferred();
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: () => AVAILABLE, download_update: () => download.promise },
  });
  await act(async () => { mounted.api.openDialog(); });
  await settle();
  await act(async () => { mounted.api.install(); });
  await settle();
  await mounted.unmount();
  download.resolve(null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mounted.restartRequests, 0);
});

test("a choice that cannot be saved is undone, reported, and sends nothing", async (t) => {
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: () => AVAILABLE },
    storeSet: async (key) => key !== "updates:auto-check",
  });
  await act(async () => { mounted.api.answerQuestion(true); });
  await settle();
  assert.equal(mounted.api.autoCheck, false);
  assert.deepEqual(mounted.errors, ["Couldn't save that choice. Try again."]);
  // The unsaved value is put back, so the native gate does not keep reading it.
  assert.deepEqual(
    mounted.saved.filter(([key]) => key === "updates:auto-check"),
    [["updates:auto-check", true], ["updates:auto-check", false]],
  );
  assert.equal(called(mounted, "check_for_update").length, 0);
});

test("turning automatic checks on saves the choice before the first check", async (t) => {
  const order = [];
  const mounted = await mountUpdates(t, {
    ipc: { check_for_update: (args) => { order.push(`check:${args.manual}`); return AVAILABLE; } },
    storeSet: async (key, value) => {
      if (key === "updates:auto-check") order.push(`save:${value}`);
      return true;
    },
  });
  await act(async () => { mounted.api.answerQuestion(true); });
  await settle();
  assert.deepEqual(order, ["save:true", "check:false"]);
  assert.equal(mounted.api.autoCheck, true);
  assert.equal(mounted.api.dialogOpen, false, "an automatic check never opens the dialog");
  assert.equal(mounted.api.markerVisible, true);
});

test("a choice made before the saved setting loads is not overwritten by it", async (t) => {
  const firstRead = deferred();
  const mounted = await mountUpdates(t, {
    storeGet: async (key) => (key === "updates:auto-check" ? firstRead.promise : null),
  });
  await act(async () => { mounted.api.setAutoCheck(true); });
  await settle();
  await act(async () => { firstRead.resolve(false); });
  await settle();
  assert.equal(mounted.api.autoCheck, true);
});

test("the Updates dialog keeps keyboard focus inside when its buttons change", async (t) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const noop = () => {};
  const render = (phase) => act(async () => root.render(React.createElement(UpdateDialog, {
    visible: true, phase, problem: null, autoCheck: false,
    onClose: noop, onCheck: noop, onInstall: noop, onDownloadPage: noop, onAutoCheckChange: noop,
  })));
  const dialog = () => document.querySelector('[role="dialog"]');
  const button = (label) => Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent === label);

  await render({ kind: "checking" });
  assert.equal(document.activeElement?.textContent, "Close");

  await render(AVAILABLE);
  assert.ok(dialog().contains(document.activeElement), "focus stays in the dialog when an update is found");
  assert.equal(document.activeElement?.textContent, "Later");

  // Pressing Install and Restart removes that button; focus must not fall to the page.
  await act(async () => { button("Install and Restart").focus(); });
  await render({ kind: "downloading", current: "1.6.4", version: "1.6.5", percent: 10 });
  assert.equal(document.activeElement?.textContent, "Hide");
});
