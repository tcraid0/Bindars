function reportPersistError(onError: (error: unknown) => void, error: unknown) {
  try {
    onError(error);
  } catch {
    // Persistence error reporting must not break later saves.
  }
}

function reportPersistSuccess(onSuccess: () => void) {
  try {
    onSuccess();
  } catch {
    // Persistence success reporting must not break later saves.
  }
}

export function queueAnnotationPersist(
  currentQueue: Promise<void>,
  persist: () => Promise<boolean>,
  onError: (error: unknown) => void,
  onSuccess: () => void = () => {},
): Promise<boolean> {
  return currentQueue
    .catch((error) => {
      reportPersistError(onError, error);
    })
    .then(async () => {
      const persisted = await persist();
      if (!persisted) {
        reportPersistError(onError, new Error("Annotation save failed."));
        return false;
      }
      reportPersistSuccess(onSuccess);
      return true;
    })
    .catch((error) => {
      reportPersistError(onError, error);
      return false;
    });
}
