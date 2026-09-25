import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

export const NATIVE_QUIT_REQUESTED_EVENT = "bindars://quit-requested";

interface UseNativeQuitArgs {
  onQuitRequested: () => void;
}

/**
 * Listens for the custom macOS Quit menu item. The native side never exits on
 * its own; it only announces the request, and the frontend guard decides when
 * quitting is safe.
 */
export function useNativeQuit({ onQuitRequested }: UseNativeQuitArgs) {
  const onQuitRequestedRef = useRef(onQuitRequested);
  onQuitRequestedRef.current = onQuitRequested;

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    listen(NATIVE_QUIT_REQUESTED_EVENT, () => {
      if (!active) return;
      try {
        onQuitRequestedRef.current();
      } catch (error) {
        console.error("[native-quit] Failed to dispatch a quit request:", error);
      }
    })
      .then((detach) => {
        if (!active) {
          detach();
          return;
        }
        unlisten = detach;
      })
      .catch((error) => {
        // The listener is unavailable in browser-only development, where the
        // custom menu item does not exist either.
        console.warn("[native-quit] Failed to attach the quit-request listener:", error);
      });

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, []);
}
