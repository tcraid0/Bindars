import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

export interface StatePause {
  paused: boolean;
  isPaused: () => boolean;
}

/** Queue state application while native printing owns the current reader.
 * The synchronous predicate also covers the interval before React commits.
 */
export function useDeferredState<T>(initial: T | (() => T), pause?: StatePause): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initial);
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  const pendingRef = useRef<SetStateAction<T>[]>([]);
  const update = useCallback((action: SetStateAction<T>) => {
    if (pauseRef.current?.isPaused()) {
      pendingRef.current.push(action);
    } else {
      setValue(action);
    }
  }, []);
  useLayoutEffect(() => {
    if (pause?.paused || pause?.isPaused()) return;
    const pending = pendingRef.current;
    pendingRef.current = [];
    for (const action of pending) setValue(action);
  }, [pause?.paused]);
  return [value, update];
}
