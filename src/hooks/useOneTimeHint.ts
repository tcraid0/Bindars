import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";
import { trySetLocalStorage } from "../lib/safe-local-storage";

export function useOneTimeHint(storeKey: string, localKey: string) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(localKey) === "true"; } catch { return false; }
  });
  const [loaded, setLoaded] = useState(false);
  const changedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void storeGet<boolean>(storeKey).then(value => {
      if (!active) return;
      if (value === true && !changedRef.current) {
        setDismissed(true);
        trySetLocalStorage(localKey, "true");
      }
      setLoaded(true);
    });
    return () => { active = false; };
  }, [storeKey, localKey]);

  const dismiss = useCallback(() => {
    if (changedRef.current) return;
    changedRef.current = true;
    setDismissed(true);
    trySetLocalStorage(localKey, "true");
    void storeSet(storeKey, true);
  }, [storeKey, localKey]);

  return { visible: loaded && !dismissed, loaded, dismiss };
}
