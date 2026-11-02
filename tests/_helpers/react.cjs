const { act } = require("react");
const { flushSync: flushReactSync } = require("react-dom");

// Preserve immediate DOM assertions while flushing effects in React's test
// scope. Async work still needs an awaited act in the calling test.
function flushSync(callback) {
  let result;
  act(() => { result = flushReactSync(callback); });
  return result;
}

module.exports = { flushSync };
