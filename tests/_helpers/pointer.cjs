function dispatchPointer(target, type, options = {}) {
  return target.dispatchEvent(new window.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, button: 0, ...options,
  }));
}

function pointerClick(target) {
  dispatchPointer(target, "pointerdown");
  dispatchPointer(target, "pointerup");
  target.click();
}

module.exports = { dispatchPointer, pointerClick };
