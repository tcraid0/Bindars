const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { createRequire } = require("node:module");
const fs = require("node:fs");

test("all math consumers and CSS resolve to the pinned patched KaTeX", () => {
  const pinned = require("../package.json").overrides.katex;
  assert.equal(require("katex").version, pinned);
  // This advisory starts being fixed at 0.18.2. Pinning is intentional:
  // consumers still declare ^0.16.x and require compatibility validation.
  const [major, minor, patch] = pinned.split(".").map(Number);
  assert.ok(major > 0 || minor > 18 || (minor === 18 && patch >= 2));
  const entry = require.resolve("katex");
  for (const consumer of ["rehype-katex", "mermaid", "micromark-extension-math"]) {
    assert.equal(createRequire(require.resolve(consumer)).resolve("katex"), entry, consumer);
  }
  const locked = Object.entries(require("../package-lock.json").packages)
    .filter(([name]) => /(?:^|\/)node_modules\/katex$/.test(name));
  assert.deepEqual(locked.map(([name, entry]) => [name, entry.version]), [["node_modules/katex", pinned]]);
  const cssPath = require.resolve("katex/dist/katex.min.css");
  assert.equal(path.dirname(cssPath), path.dirname(entry));
  const css = fs.readFileSync(cssPath, "utf8");
  const fonts = [...css.matchAll(/url\((?:["'])?(fonts\/[^)'"\s]+)(?:["'])?\)/g)];
  assert.ok(fonts.length > 0);
  for (const [, font] of fonts) assert.ok(fs.statSync(path.join(path.dirname(cssPath), font)).size > 0, font);
});

// A separate process also protects the suite when a probe throws or times out.
// Do not move prototype mutations into this process or a browser/app session.
for (const scenario of ["trust", "options", "defaults", "processor", "namespace", "limits"]) {
  test(`KaTeX ignores inherited ${scenario}`, () => {
    const result = spawnSync(process.execPath, [
      "tests/_helpers/katex-security-probe.cjs",
      scenario,
    ], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.trim(), `PASS ${scenario}`);
  });
}
