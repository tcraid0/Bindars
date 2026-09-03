import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const APP_RESUMED_EVENT = "bindars://app-resumed";

export type ReconciliationLifecycleSignal = "focus" | "resume";

interface UseReconciliationLifecycleOptions {
  readonly onSignal: (signal: ReconciliationLifecycleSignal) => void;
}

export function useReconciliationLifecycle({
  onSignal,
}: UseReconciliationLifecycleOptions): void {
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;

  useEffect(() => {
    let active = true;
    const detachers = new Set<() => void>();
    const retain = (detach: () => void) => {
      if (!active) {
        detach();
        return;
      }
      detachers.add(detach);
    };

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (active && focused) onSignalRef.current("focus");
      })
      .then(retain)
      .catch((error) => {
        console.warn("[reconciliation] Failed to attach the focus listener:", error);
      });

    void listen(APP_RESUMED_EVENT, () => {
      if (active) onSignalRef.current("resume");
    })
      .then(retain)
      .catch((error) => {
        console.warn("[reconciliation] Failed to attach the resume listener:", error);
      });

    return () => {
      active = false;
      for (const detach of detachers) detach();
      detachers.clear();
    };
  }, []);
}
