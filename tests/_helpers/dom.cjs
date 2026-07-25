let domReady = false;

async function installDom() {
  if (!domReady) {
    const { Window } = await import("happy-dom");
    const window = new Window();
    globalThis.window = window;
    // Node 21+ provides its own navigator, while Node 20 does not. Always use
    // the fake browser's navigator so the test environment is version-neutral.
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
    domReady = true;
  }

  resetDom();
}

function resetDom() {
  if (globalThis.document) {
    globalThis.document.body.innerHTML = "";
  }
}

module.exports = { installDom, resetDom };
