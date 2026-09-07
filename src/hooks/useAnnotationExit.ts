import { useCallback, useEffect, useRef, useState } from "react";
import type { FileAnnotations } from "../types";

export const ANNOTATION_EXIT_WAIT_MS = 3000;
interface PendingExit { resolve: (allow: boolean) => void; attempt: number }

/** The existing action admission remains the quit owner. This hook only obtains
 * an annotation decision; a timeout never consents to losing pending records. */
export function useAnnotationExit(
  pendingRecords: () => Record<string, FileAnnotations>,
  waitForSaves: () => Promise<void>,
  retrySave: () => void,
) {
  const pending = useRef<PendingExit | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [paths, setPaths] = useState<string[] | null>(null);
  const [waiting, setWaiting] = useState(false);
  const finish = useCallback((allow: boolean) => {
    const request = pending.current;
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);
    setPaths(null);
    setWaiting(false);
    request?.resolve(allow);
  }, []);
  const attempt = useCallback(async (request: PendingExit, retry: boolean) => {
    const version = ++request.attempt;
    setWaiting(true);
    try {
      if (retry) retrySave();
      await Promise.race([
        waitForSaves(),
        new Promise<void>((resolve) => { timer.current = setTimeout(resolve, ANNOTATION_EXIT_WAIT_MS); }),
      ]);
    } catch {
      // A failed wait, like a timeout, requires checking pending work below.
    }
    if (pending.current !== request || request.attempt !== version) return;
    if (timer.current) clearTimeout(timer.current);
    const remaining = Object.keys(pendingRecords());
    if (!remaining.length) finish(true);
    else { setWaiting(false); setPaths(remaining); }
  }, [finish, pendingRecords, retrySave, waitForSaves]);
  const requestExit = useCallback(() => new Promise<boolean>((resolve) => {
    const request = { resolve, attempt: 0 };
    pending.current = request;
    void attempt(request, false);
  }), [attempt]);
  const retry = useCallback(() => { if (pending.current) void attempt(pending.current, true); }, [attempt]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    pending.current?.resolve(false);
    pending.current = null;
  }, []);
  return { requestExit, paths, waiting, retry, keepOpen: () => finish(false), quitWithoutSaving: () => finish(true) };
}
