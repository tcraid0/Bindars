const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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