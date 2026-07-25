import { useRef, useState, useCallback } from "react";
import type { NavigationEntry } from "../types";

const MAX_STACK = 50;

export function useNavigationHistory() {
  const backStackRef = useRef<NavigationEntry[]>([]);
  const forwardStackRef = useRef<NavigationEntry[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const syncState = useCallback(() => {
    setCanGoBack(backStackRef.current.length > 0);
    setCanGoForward(forwardStackRef.current.length > 0);
  }, []);

  const pushEntry = useCallback(
    (current: NavigationEntry) => {
      backStackRef.current = [...backStackRef.current, current].slice(-MAX_STACK);
      forwardStackRef.current = [];
      syncState();
    },
    [syncState],
  );

  const peekBack = useCallback((): NavigationEntry | null => {
    const stack = backStackRef.current;
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }, []);

  const commitBack = useCallback(
    (current: NavigationEntry) => {
      const stack = backStackRef.current;
      if (stack.length === 0) return;
      backStackRef.current = stack.slice(0, -1);
      forwardStackRef.current = [...forwardStackRef.current, current].slice(-MAX_STACK);
      syncState();
    },
    [syncState],
  );

  const peekForward = useCallback((): NavigationEntry | null => {
    const stack = forwardStackRef.current;
    return stack.length > 0 ? stack[stack.length - 1] : null;
  }, []);

  const commitForward = useCallback(
    (current: NavigationEntry) => {
      const stack = forwardStackRef.current;
      if (stack.length === 0) return;
      forwardStackRef.current = stack.slice(0, -1);
      backStackRef.current = [...backStackRef.current, current].slice(-MAX_STACK);
      syncState();
    },
    [syncState],
  );

  return { canGoBack, canGoForward, pushEntry, peekBack, commitBack, peekForward, commitForward };
}
