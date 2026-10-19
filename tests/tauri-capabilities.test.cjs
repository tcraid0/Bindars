const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

function externalLinkGrants(directory) {
  return fs.readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) return externalLinkGrants(file);
    const extension = path.extname(file);
    // Match Tauri's recursive discovery and exclusion of generated schemas.
    if (path.basename(directory) === "schemas"
        || ![".json", ".toml", ".json5"].includes(extension)) return [];
    // New capability formats need a parser here before the guard can audit them.
    assert.equal(extension, ".json", `review capability format: ${file}`);
    const capability = JSON.parse(fs.readFileSync(file, "utf8"));
    return capability.permissions.filter((permission) => {
      const identifier = typeof permission === "string" ? permission : permission.identifier;
      return identifier.startsWith("opener:") || identifier.startsWith("shell:");
    });
  });
}

test("capability discovery ignores unrelated files and checks nested capabilities", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bindars-capabilities-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const nested = path.join(directory, "nested");
  const schemas = path.join(directory, "schemas");
  fs.mkdirSync(nested);
  fs.mkdirSync(schemas);
  for (const file of [".DS_Store", "README.md", "nested/ignored.JSON", "schemas/schema.json"]) {
    fs.writeFileSync(path.join(directory, file), "not a capability");
  }
  fs.writeFileSync(path.join(nested, "extra.json"), JSON.stringify({
    permissions: ["core:event:allow-listen", "opener:allow-default-urls", "shell:allow-open"],
  }));
  assert.deepEqual(externalLinkGrants(directory), ["opener:allow-default-urls", "shell:allow-open"]);
  for (const extension of ["toml", "json5"]) {
    const file = path.join(nested, `extra.${extension}`);
    fs.writeFileSync(file, "must be reviewed");
    assert.throws(() => externalLinkGrants(directory), /review capability format/);
    fs.unlinkSync(file);
  }
});

test("external links grant only web and email URL scopes across all capabilities", () => {
  // This checks native capability input, independently of frontend link handlers.
  // An additional capability/default grant could otherwise restore tel: access.
  assert.deepEqual(externalLinkGrants(path.join(projectRoot, "src-tauri/capabilities")), [{
    identifier: "opener:allow-open-url",
    allow: [{ url: "http://*" }, { url: "https://*" }, { url: "mailto:*" }],
  }]);
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(config.app.security.capabilities, undefined, "use only the audited capability files");
});

test("the zero-margin macOS window.print bridge is not permitted", () => {
  // macOS printing goes through print_current_webview. Without this grant a
  // misdetected platform fails loudly instead of silently printing without margins.
  assert.equal(capabilities.permissions.includes("core:webview:allow-print"), false);
});

test("sidebar title updates have permission to emit their native event", async () => {
  await installDom();
  const payloads = [];
  mockIPC((command, args) => {
    assert.equal(command, "plugin:event|emit");
    assert.ok(
      capabilities.permissions.includes("core:event:allow-emit"),
      "the packaged webview must be allowed to send sidebar intent to the native menu",
    );
    payloads.push(args);
  });
  try {
    await emit("bindars://sidebar-visible", true);
    await emit("bindars://sidebar-visible", false);
    assert.deepEqual(payloads, [
      { event: "bindars://sidebar-visible", payload: true },
      { event: "bindars://sidebar-visible", payload: false },
    ]);
  } finally {
    clearMocks();
  }
});

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
  assert.doesNotMatch(registration[1], /\b(?:export_html_file|read_image_file_as_base64)\b/);
  assert.doesNotMatch(registration[1], /\bopen_markdown_file_externally\b/);
  assert.doesNotMatch(
    registration[1],
    /\b(?:write_document_snapshot|list_document_snapshots|read_document_snapshot|list_snapshot_drafts|retire_snapshot_draft|migrate_snapshot_drafts|get_snapshot_storage_stats|clear_snapshot_history)\b/,
  );
  assert.match(registration[1], /\breveal_markdown_file_in_folder\b/);
  assert.match(registration[1], /\bwrite_markdown_file_if_unmodified\b/);
  assert.match(registration[1], /\bexport_markdown_file\b/);
  assert.match(registration[1], /\bprint_current_webview\b/);
});

test("documents are revealed through the one validated backend command", () => {
  const helperSource = fs.readFileSync(
    path.join(projectRoot, "src/lib/reveal-document.ts"),
    "utf8",
  );
  assert.match(helperSource, /invoke\("reveal_markdown_file_in_folder", \{ path \}\)/);
  for (const file of ["src/components/Header.tsx", "src/components/DocumentList.tsx"]) {
    const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert.match(source, /from "\.\.\/lib\/reveal-document"/);
    assert.doesNotMatch(source, /reveal_markdown_file_in_folder|\b(?:openPath|revealItemInDir)\(/);
  }
  assert.equal(capabilities.permissions.includes("opener:allow-reveal-item-in-dir"), false);
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

test("the custom print command uses the invoking webview without destination arguments", () => {
  const native = fs.readFileSync(path.join(projectRoot, "src-tauri/src/printing.rs"), "utf8");
  const registration = fs.readFileSync(path.join(projectRoot, "src-tauri/src/lib.rs"), "utf8");
  assert.match(registration, /printing::print_current_webview/);
  assert.match(native, /pub async fn print_current_webview\(webview: tauri::Webview\)/);
  assert.match(native, /validate_caller\(webview\.label\(\), local\)/);
  assert.deepEqual(capabilities.windows, ["main"]);
  assert.equal(capabilities.remote, undefined);
});
