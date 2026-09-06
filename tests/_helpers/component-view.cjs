const assert = require("node:assert/strict");
const React = require("react");
const { flushSync } = require("react-dom");
const { createRoot } = require("react-dom/client");
const { ToastProvider } = require("../../.tmp/workspace-tests/src/components/ToastProvider.js");

function renderComponent(Component, initialProps = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let props = initialProps;
  function render(updates = {}) {
    props = { ...props, ...updates };
    flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(ToastProvider, null, React.createElement(Component, props)))));
  }
  render();
  return {
    host, render,
    cleanup() { flushSync(() => root.unmount()); host.remove(); },
  };
}

function buttonWithText(host, text) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent.trim().startsWith(text));
  assert.ok(button, `expected button: ${text}`);
  return button;
}

function click(button) { flushSync(() => button.click()); }
function focus(element) { flushSync(() => element.focus()); }
function pressKey(key, options = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  flushSync(() => document.activeElement.dispatchEvent(event));
  return event;
}

module.exports = { renderComponent, buttonWithText, click, focus, pressKey };
