const test = require("node:test");
const assert = require("node:assert/strict");

test("DOM setup replaces a Node-style navigator before browser modules load", async () => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value: { platform: "MacIntel", userAgent: "Node.js/24" },
  });

  const { installDomGlobals } = await import("./_helpers/dom-setup.mjs");
  const window = installDomGlobals({ force: true });

  assert.equal(globalThis.navigator, window.navigator);
  assert.match(globalThis.navigator.userAgent, /HappyDOM/);
  assert.equal(globalThis.document, window.document);
  assert.equal(document.compatMode, "CSS1Compat");
  assert.equal(globalThis.IS_REACT_ACT_ENVIRONMENT, true);
});
