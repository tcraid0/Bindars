async function installDom() {
  await import("./dom-setup.mjs");
  resetDom();
}

function resetDom() {
  if (globalThis.document) {
    globalThis.document.body.innerHTML = "";
  }
}

module.exports = { installDom, resetDom };
