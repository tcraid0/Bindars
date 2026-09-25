const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const {
  AppErrorBoundary,
} = require("../.tmp/workspace-tests/src/components/AppErrorBoundary.js");

test("app error boundary exposes a stable diagnostic selector", () => {
  const boundary = new AppErrorBoundary({ children: React.createElement("main") });
  boundary.state = { error: new Error("render failed") };

  const markup = renderToStaticMarkup(boundary.render());

  assert.match(markup, /data-testid="app-error-boundary"/);
  assert.match(markup, /Bindars hit an unexpected error/);
});
