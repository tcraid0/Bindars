const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { clearMocks, mockIPC, mockWindows } = require("@tauri-apps/api/mocks");
const { emit, TauriEvent } = require("@tauri-apps/api/event");
const { getCurrentWindow } = require("@tauri-apps/api/window");
const { installDom } = require("./_helpers/dom.cjs");

const projectRoot = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(projectRoot, "src/App.tsx"), "utf8");
const capabilities = JSON.parse(
  fs.readFileSync(
    path.join(projectRoot, "src-tauri/capabilities/default.json"),
    "utf8",
  ),
);

test("the close-request handler can complete both close steps", () => {
  assert.match(appSource, /\.onCloseRequested\(/);
  assert.ok(
    capabilities.permissions.includes("core:window:allow-close"),
    "programmatic close must be allowed to start the close-request lifecycle on platforms that destroy the window",
  );
  assert.ok(
    capabilities.permissions.includes("core:window:allow-destroy"),
    "Tauri requires destroy permission to finish an allowed close request",
  );
});

test("the installed SDK awaits the close handler and destroys only an allowed close", async () => {
  await installDom();
  for (const preventClose of [false, true]) {
    const commands = [];
    mockWindows("main");
    mockIPC((command) => {
      assert.equal(command, "plugin:window|destroy");
      assert.ok(capabilities.permissions.includes("core:window:allow-destroy"));
      commands.push(command);
    }, { shouldMockEvents: true });
    let finishHandler;
    const pendingHandler = new Promise((resolve) => { finishHandler = resolve; });
    const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
      await pendingHandler;
      if (preventClose) event.preventDefault();
    });
    try {
      await emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
      assert.deepEqual(commands, [], "destroy must wait for the async handler");
      finishHandler();
      await new Promise(setImmediate);
      assert.deepEqual(commands, preventClose ? [] : ["plugin:window|destroy"]);
    } finally {
      finishHandler();
      unlisten();
      clearMocks();
    }
  }
});

test("retired document commands are absent from the registered IPC surface", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src-tauri/src/lib.rs"), "utf8");
  const registration = source.match(/tauri::generate_handler!\[([\s\S]*?)\]/);
  assert.ok(registration, "expected the native command registration");
  assert.doesNotMatch(registration[1], /\b(?:resolve_markdown_path|write_markdown_file)\b/);
  assert.match(registration[1], /\bwrite_markdown_file_if_unmodified\b/);
});

test("hide-on-close is permitted without granting an unused show permission", () => {
  assert.match(
    appSource,
    /appWindow\.hide\(\)/,
    "the macOS close guard must hide the window instead of destroying it",
  );
  assert.ok(
    capabilities.permissions.includes("core:window:allow-hide"),
    "the macOS close continuation calls appWindow.hide() over IPC",
  );
  assert.ok(
    !capabilities.permissions.includes("core:window:allow-show"),
    "window reveal is performed by native Rust handlers (Dock reopen and Finder-open while hidden), which do not pass through the webview capability gate",
  );
});
