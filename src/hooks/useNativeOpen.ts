import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const NATIVE_OPEN_AVAILABLE_EVENT = "bindars://native-open-available";

export type InitialNativeOpenSelection = "native" | "none";

interface DeferredSelection {
  promise: Promise<InitialNativeOpenSelection>;
  resolve: (selection: InitialNativeOpenSelection) => void;
  settled: boolean;
}

function createDeferredSelection(): DeferredSelection {
  let resolvePromise: (selection: InitialNativeOpenSelection) => void = () => {};
  const deferred: DeferredSelection = {
    promise: new Promise((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (selection) => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(selection);
    },
    settled: false,
  };
  return deferred;
}

interface UseNativeOpenArgs {
  onOpenPath: (path: string) => void;
}

export function useNativeOpen({ onOpenPath }: UseNativeOpenArgs) {
  const onOpenPathRef = useRef(onOpenPath);
  const initialSelectionRef = useRef<DeferredSelection | null>(null);
  const generationRef = useRef(0);
  onOpenPathRef.current = onOpenPath;

  if (!initialSelectionRef.current) {
    initialSelectionRef.current = createDeferredSelection();
  }

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let active = true;
    let unlisten: (() => void) | null = null;
    let drainRequested = false;
    let draining = false;
    let sawNativePath = false;

    const isCurrent = () => active && generationRef.current === generation;

    const drain = async () => {
      if (draining || !isCurrent()) return;
      draining = true;
      try {
        while (isCurrent() && drainRequested) {
          drainRequested = false;
          let path: string | null = null;
          try {
            path = await invoke<string | null>("take_pending_open_path");
          } catch (error) {
            // The command can be unavailable in browser-only development.
            console.warn("[native-open] Failed to drain a pending native open:", error);
          }
          if (!isCurrent()) return;
          if (path) {
            sawNativePath = true;
            try {
              onOpenPathRef.current(path);
            } catch (error) {
              console.error("[native-open] Failed to dispatch a native open:", error);
            }
          }
        }
      } finally {
        if (!isCurrent()) return;
        draining = false;
        if (drainRequested) {
          void drain();
          return;
        }
        initialSelectionRef.current?.resolve(sawNativePath ? "native" : "none");
      }
    };

    const requestDrain = () => {
      if (!isCurrent()) return;
      drainRequested = true;
      void drain();
    };

    void listen(NATIVE_OPEN_AVAILABLE_EVENT, requestDrain)
      .then((detach) => {
        if (!isCurrent()) {
          detach();
          return;
        }
        unlisten = detach;
        requestDrain();
      })
      .catch((error) => {
        console.warn("[native-open] Failed to attach the native-open listener:", error);
        requestDrain();
      });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, []);

  const waitForInitialNativeOpen = useCallback(
    () => initialSelectionRef.current!.promise,
    [],
  );

  return { waitForInitialNativeOpen };
}
