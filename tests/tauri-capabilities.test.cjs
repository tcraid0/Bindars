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
    "programmatic close must be allowed to start the close-request lifecycle",
  );
  assert.ok(
    capabilities.permissions.includes("core:window:allow-destroy"),
    "Tauri requires destroy permission to finish an allowed close request",
  );
});
