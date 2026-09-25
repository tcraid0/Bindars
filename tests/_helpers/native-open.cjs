function createNativeOpenIpc(initialPath = null) {
  let pendingPath = initialPath;
  const takeCalls = [];

  return {
    wrap(handler) {
      return (command, args = {}) => {
        if (command === "take_pending_open_path") {
          takeCalls.push(args);
          const path = pendingPath;
          pendingPath = null;
          return path;
        }
        return handler(command, args);
      };
    },
    setPendingPath(path) {
      pendingPath = path;
    },
    takeCalls() {
      return [...takeCalls];
    },
  };
}

module.exports = { createNativeOpenIpc };
