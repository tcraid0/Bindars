import { Window } from "happy-dom";

// Node's test runner does not configure React's act environment automatically.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let testWindow;

export function installDomGlobals({ force = false } = {}) {
  if (!force && testWindow) {
    return testWindow;
  }

  const window = new Window();
  window.document.insertBefore(
    window.document.implementation.createDocumentType("html", "", ""),
    window.document.documentElement,
  );
  // Happy DOM omits compatMode; the app's HTML doctype selects standards mode.
  Object.defineProperty(window.document, "compatMode", { value: "CSS1Compat", configurable: true });
  testWindow = window;
  globalThis.window = window;
  // Node 21+ provides its own navigator. CodeMirror reads it at import time to
  // choose platform-specific shortcuts, so the DOM navigator must exist first.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    value: window.navigator,
  });
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.Event = window.Event;
  globalThis.InputEvent = window.InputEvent;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  }

  return window;
}

installDomGlobals();
