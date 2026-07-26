const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const tauriConf = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"),
);
const security = tauriConf.app.security;

function cspSources(csp, directiveName) {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === directiveName || part.startsWith(`${directiveName} `));
  if (directive === undefined) return null;
  return directive.slice(directiveName.length).trim().split(/\s+/).filter(Boolean);
}

test("style-src keeps 'unsafe-inline' for runtime-injected stylesheets", () => {
  const styleSources = cspSources(security.csp, "style-src");
  assert.ok(styleSources, "the production CSP must declare an explicit style-src directive");
  assert.ok(
    styleSources.includes("'unsafe-inline'"),
    "CodeMirror (via style-mod) and Mermaid deliver their CSS through runtime-injected " +
      "<style> elements; without 'unsafe-inline' WebKit refuses them and the editor and " +
      "diagrams render unstyled in production builds",
  );
});

test("Tauri's style nonce injection stays disabled so 'unsafe-inline' remains effective", () => {
  // Tauri stamps a nonce onto every <style> element in index.html and appends
  // 'nonce-...' to style-src at load time. Per the CSP spec, any nonce or hash
  // in a directive makes 'unsafe-inline' ignored, which silently blocks every
  // runtime-injected stylesheet in packaged builds only (the v1.4.0 bug where
  // the Plain/Styled heading toggle changed state but never changed pixels).
  // The dev-server path never applies this packaged-asset transformation, so
  // only this invariant protects the release.
  const disabled = security.dangerousDisableAssetCspModification;
  assert.ok(
    Array.isArray(disabled) && disabled.includes("style-src"),
    "app.security.dangerousDisableAssetCspModification must list \"style-src\" to keep " +
      "Tauri from appending style nonces that cancel 'unsafe-inline'",
  );
});

test("script-src hardening is not disabled alongside the style-src exemption", () => {
  const disabled = security.dangerousDisableAssetCspModification;
  assert.notEqual(
    disabled,
    true,
    "disabling all CSP modification would also strip Tauri's script nonces and hashes; " +
      "only the style-src directive may be exempted",
  );
  assert.ok(
    !(Array.isArray(disabled) && disabled.includes("script-src")),
    "Tauri's script nonce/hash injection must stay active for the inline bootstrap script",
  );
});
