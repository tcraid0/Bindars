const { createRoot } = require("react-dom/client");
const { flushSync } = require("react-dom");

// Client rendering includes portalled modal content, which server rendering cannot render.
function renderMarkup(element) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(element));
    return host.innerHTML + (document.getElementById("dialog-root")?.innerHTML ?? "");
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}
module.exports = { renderMarkup };
