import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { storeGet, storeSet } from "../lib/store";
import { isPrimaryModifier } from "../lib/shortcut-labels";
import { isImeCompositionKey } from "../lib/keyboard";
export const ZOOM_STEPS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export function nextZoom(value: number, direction: number) {
  return direction > 0
    ? (ZOOM_STEPS.find((step) => step > value) ?? 3)
    : ([...ZOOM_STEPS].reverse().find((step) => step < value) ?? 0.75);
}
export function useInterfaceZoom() {
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const value = useRef(1);
  const changed = useRef(false);
  const queue = useRef(Promise.resolve());
  const apply = useCallback((next: number, persist = true) => {
    value.current = next;
    if (persist) changed.current = true;
    queue.current = queue.current.then(async () => {
      try {
        await invoke("set_interface_zoom", { factor: next });
        setZoom(next);
        setError(null);
        if (persist && !(await storeSet("interface-zoom", next)))
          setError(
            "Zoom changed for this session, but couldn't be saved for next launch.",
          );
      } catch {
        setError("Couldn't change interface zoom. Try again.");
      }
    });
  }, []);
  const change = useCallback(
    (direction: number) =>
      apply(direction === 0 ? 1 : nextZoom(value.current, direction)),
    [apply],
  );
  useEffect(() => {
    let active = true;
    void storeGet<number>("interface-zoom").then((saved) => {
      if (
        active &&
        !changed.current &&
        typeof saved === "number" &&
        ZOOM_STEPS.includes(saved)
      )
        apply(saved, false);
    });
    const onKey = (event: KeyboardEvent) => {
      if (
        !isPrimaryModifier(event) ||
        event.altKey ||
        isImeCompositionKey(event) ||
        !["+", "=", "-", "0"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      change(event.key === "0" ? 0 : event.key === "-" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    const unsubscribe = listen<number>("bindars://interface-zoom", (event) =>
      change(event.payload),
    ).catch(() => () => {});
    return () => {
      active = false;
      window.removeEventListener("keydown", onKey, true);
      void unsubscribe.then((fn) => fn()).catch(() => {});
    };
  }, [apply, change]);
  return { zoom, change, error };
}
