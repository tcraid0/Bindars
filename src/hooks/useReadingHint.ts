import { useCallback, useEffect, useRef, useState } from "react";
import { storeGet, storeSet } from "../lib/store";
import { trySetLocalStorage } from "../lib/safe-local-storage";

const STORE_KEY = "reading-hint-dismissed";
const LOCAL_KEY = "bindars-reading-hint-dismissed";

export function useReadingHint() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(LOCAL_KEY) === "true"; } catch { return false; }
  });
  const [loaded, setLoaded] = useState(false);
  const changedRef = useRef(false);

  useEffect(() => {
    let active = true;
    void storeGet<boolean>(STORE_KEY).then(value => {
      if (!active) return;
      if (value === true && !changedRef.current) {
        setDismissed(true);
        trySetLocalStorage(LOCAL_KEY, "true");
      }
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  const dismiss = useCallback(() => {
    if (changedRef.current) return;
    changedRef.current = true;
    setDismissed(true);
    trySetLocalStorage(LOCAL_KEY, "true");
    void storeSet(STORE_KEY, true);
  }, []);

  return { visible: loaded && !dismissed, dismiss };
}
