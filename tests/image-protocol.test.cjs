const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { mockConvertFileSrc, clearMocks } = require("@tauri-apps/api/mocks");
const { resolveImageSrc } = require("../.tmp/workspace-tests/src/lib/paths.js");

test("image URLs use the confined protocol and preserve decoded filenames exactly once", () => {
  for (const platform of ["macos", "linux", "windows"]) {
    mockConvertFileSrc(platform);
    try {
      const document = platform === "windows" ? "C:\\Users\\reader\\readme.md" : "/tmp/readme.md";
      const image = platform === "windows" ? "C:/Users/reader/images/café what?# literal%20.png" : "/tmp/images/café what?# literal%20.png";
      const source = resolveImageSrc("images/caf%C3%A9%20what%3F%23%20literal%2520.png?cache=1#preview", document);
      const url = new URL(source);
      assert.equal(url.protocol, platform === "windows" ? "http:" : "document-image:");
      assert.equal(url.hostname, platform === "windows" ? "document-image.localhost" : "localhost");
      assert.deepEqual(JSON.parse(decodeURIComponent(url.pathname.slice(1))), [document, image]);
      assert.equal(url.search, "");
      assert.equal(url.hash, "");
    } finally {
      clearMocks();
    }
  }
});

test("blocked image paths never produce a native protocol request", () => {
  mockConvertFileSrc("macos");
  try {
    for (const source of ["", "../private.png", "%2e%2e/private.png", "/private.png", "https://example.com/a.png", "file:///private.png", "data:image/png;base64,AAAA", "document-image://localhost/anything"]) {
      assert.equal(resolveImageSrc(source, "/tmp/document.md"), "", source);
    }
  } finally {
    clearMocks();
  }
});

test("image CSP allows only the confined native origins and removes ambient asset access", () => {
  const config = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const imageDirective = config.app.security.csp.split(";").find((directive) => directive.trim().startsWith("img-src "));
  assert.equal(imageDirective.trim(), "img-src 'self' document-image: http://document-image.localhost");
  assert.equal(config.app.security.assetProtocol?.enable ?? false, false);
});
