import { useCallback, useEffect, useRef } from "react";
import {
  decideDocumentReconciliation,
  staleReconciliation,
} from "../lib/document-reconciliation";
import type {
  ReconciliationDecision,
  ReconciliationProbeResult,
  ReconciliationSnapshot,
} from "../lib/document-reconciliation";

export type ReconciliationSignal =
  | "focus"
  | "resume"
  | "watcher"
  | "watcher-setup-fallback"
  | "watcher-drop-fallback"
  | "editor-exit";

export type ReconciliationRequestResult =
  | ReconciliationDecision
  | { readonly kind: "deferred" };

export const RECONCILIATION_COALESCE_MS = 20;

const trailingSignals = new Set<ReconciliationSignal>([
  "watcher",
  "watcher-setup-fallback",
  "watcher-drop-fallback",
  "editor-exit",
]);

function queuedSignalPriority(signal: ReconciliationSignal): number {
  if (signal === "editor-exit") return 3;
  if (trailingSignals.has(signal)) return 2;
  return 1;
}

function mergeQueuedSignal(
  current: ReconciliationSignal | null,
  incoming: ReconciliationSignal,
): ReconciliationSignal {
  if (current === null || queuedSignalPriority(incoming) >= queuedSignalPriority(current)) {
    return incoming;
  }
  return current;
}

interface UseDocumentReconciliationOptions {
  readonly presentationActive: boolean;
  readonly getSnapshot: () => ReconciliationSnapshot | null;
  readonly probe: (snapshot: ReconciliationSnapshot) => Promise<ReconciliationProbeResult>;
  readonly applyDecision: (
    decision: ReconciliationDecision,
    signal: ReconciliationSignal,
  ) => void;
}

interface UseDocumentReconciliationReturn {
  scheduleReconciliation: (signal: ReconciliationSignal) => void;
  requestReconciliation: (
    signal: ReconciliationSignal,
  ) => Promise<ReconciliationRequestResult>;
  resumeDeferredReconciliation: () => void;
  supersedeReconciliation: () => void;
}

interface QueuedProbeWaiter {
  readonly resolve: (result: ReconciliationRequestResult) => void;
  readonly reject: (reason: unknown) => void;
}

interface QueuedProbe {
  signal: ReconciliationSignal;
  readonly documentId: string;
  mayRetryStateChange: boolean;
  readonly waiters: QueuedProbeWaiter[];
}

interface DeferredProbe {
  readonly documentId: string;
  signal: ReconciliationSignal;
}

function resolveQueuedProbe(
  queued: QueuedProbe | null,
  result: ReconciliationRequestResult,
): void {
  if (!queued) return;
  for (const waiter of queued.waiters) waiter.resolve(result);
}

export function useDocumentReconciliation({
  presentationActive,
  getSnapshot,
  probe,
  applyDecision,
}: UseDocumentReconciliationOptions): UseDocumentReconciliationReturn {
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeProbeRef = useRef<Promise<ReconciliationRequestResult> | null>(null);
  const trailingProbeRef = useRef<QueuedProbe | null>(null);
  const deferredProbeRef = useRef<DeferredProbe | null>(null);
  const scheduledProbeRef = useRef<DeferredProbe | null>(null);
  const coalescingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presentationActiveRef = useRef(presentationActive);
  const getSnapshotRef = useRef(getSnapshot);
  const probeRef = useRef(probe);
  const applyDecisionRef = useRef(applyDecision);
  const requestRef = useRef<(signal: ReconciliationSignal) => Promise<ReconciliationRequestResult>>(
    async () => staleReconciliation("no-document"),
  );
  const runProbeRef = useRef<(
    signal: ReconciliationSignal,
    mayRetryStateChange?: boolean,
  ) => Promise<ReconciliationRequestResult>>(
    async () => staleReconciliation("no-document"),
  );

  presentationActiveRef.current = presentationActive;
  getSnapshotRef.current = getSnapshot;
  probeRef.current = probe;
  applyDecisionRef.current = applyDecision;

  const cancelScheduledProbe = useCallback(() => {
    if (coalescingTimerRef.current !== null) {
      clearTimeout(coalescingTimerRef.current);
      coalescingTimerRef.current = null;
    }
    scheduledProbeRef.current = null;
  }, []);

  const detachPendingWork = useCallback(() => {
    generationRef.current += 1;
    activeProbeRef.current = null;
    cancelScheduledProbe();
    resolveQueuedProbe(
      trailingProbeRef.current,
      staleReconciliation("superseded"),
    );
    trailingProbeRef.current = null;
    deferredProbeRef.current = null;
  }, [cancelScheduledProbe]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detachPendingWork();
    };
  }, [detachPendingWork]);

  const deferProbe = useCallback((documentId: string, signal: ReconciliationSignal): void => {
    const current = deferredProbeRef.current;
    if (current?.documentId === documentId) {
      current.signal = mergeQueuedSignal(current.signal, signal);
      return;
    }
    deferredProbeRef.current = { documentId, signal };
  }, []);

  const enqueueTrailingProbe = useCallback((
    documentId: string,
    signal: ReconciliationSignal,
    mayRetryStateChange: boolean,
    waiter?: QueuedProbeWaiter,
  ): void => {
    const current = trailingProbeRef.current;
    if (current?.documentId === documentId) {
      current.signal = mergeQueuedSignal(current.signal, signal);
      current.mayRetryStateChange ||= mayRetryStateChange;
      if (waiter) current.waiters.push(waiter);
      return;
    }
    if (current) {
      resolveQueuedProbe(current, staleReconciliation("superseded"));
    }
    trailingProbeRef.current = {
      documentId,
      signal,
      mayRetryStateChange,
      waiters: waiter ? [waiter] : [],
    };
  }, []);

  const runProbe = useCallback((
    signal: ReconciliationSignal,
    mayRetryStateChange = true,
  ): Promise<ReconciliationRequestResult> => {
    const captured = getSnapshotRef.current();
    if (!captured) return Promise.resolve(staleReconciliation("no-document"));
    if (captured.userOpenInFlight || captured.guardedActionInFlight) {
      deferProbe(captured.documentId, signal);
      return Promise.resolve({ kind: "deferred" });
    }

    const generation = generationRef.current;
    const operation = (async (): Promise<ReconciliationRequestResult> => {
      const probeResult = await probeRef.current(captured);
      if (!mountedRef.current || generation !== generationRef.current) {
        return staleReconciliation("superseded");
      }
      if (presentationActiveRef.current) {
        deferProbe(captured.documentId, signal);
        return staleReconciliation("superseded");
      }

      const current = getSnapshotRef.current();
      if (!current) return staleReconciliation("no-document");

      const decision = decideDocumentReconciliation({
        captured,
        current,
        probe: probeResult,
      });
      if (decision.kind === "stale-noop") {
        if (decision.reason === "user-action") {
          deferProbe(captured.documentId, signal);
        } else if (
          mayRetryStateChange
          && current.documentId === captured.documentId
          && (
            decision.reason === "clean-editor-changed"
            || decision.reason === "ownership-changed"
          )
        ) {
          enqueueTrailingProbe(captured.documentId, signal, false);
        }
        return decision;
      }
      applyDecisionRef.current(decision, signal);
      return decision;
    })();

    activeProbeRef.current = operation;
    const releaseOperation = () => {
      if (activeProbeRef.current !== operation) return;
      activeProbeRef.current = null;

      const trailingProbe = trailingProbeRef.current;
      trailingProbeRef.current = null;
      if (
        trailingProbe === null
        || !mountedRef.current
        || generation !== generationRef.current
      ) {
        resolveQueuedProbe(trailingProbe, staleReconciliation("superseded"));
        return;
      }

      if (presentationActiveRef.current) {
        deferProbe(trailingProbe.documentId, trailingProbe.signal);
        resolveQueuedProbe(trailingProbe, { kind: "deferred" });
        return;
      }
      const current = getSnapshotRef.current();
      if (!current || current.documentId !== trailingProbe.documentId) {
        resolveQueuedProbe(trailingProbe, staleReconciliation("superseded"));
        return;
      }
      const trailingOperation = runProbeRef.current(
        trailingProbe.signal,
        trailingProbe.mayRetryStateChange,
      );
      void trailingOperation.then(
        (result) => resolveQueuedProbe(trailingProbe, result),
        (reason) => {
          for (const waiter of trailingProbe.waiters) waiter.reject(reason);
        },
      );
    };
    void operation.then(releaseOperation, releaseOperation);
    return operation;
  }, [deferProbe, enqueueTrailingProbe]);
  runProbeRef.current = runProbe;

  const requestReconciliation = useCallback((
    signal: ReconciliationSignal,
  ): Promise<ReconciliationRequestResult> => {
    const captured = getSnapshotRef.current();
    if (presentationActiveRef.current) {
      if (!captured) return Promise.resolve(staleReconciliation("no-document"));
      deferProbe(captured.documentId, signal);
      return Promise.resolve({ kind: "deferred" });
    }

    const activeProbe = activeProbeRef.current;
    if (activeProbe) {
      if (!trailingSignals.has(signal) || !captured) return activeProbe;
      return new Promise<ReconciliationRequestResult>((resolve, reject) => {
        enqueueTrailingProbe(captured.documentId, signal, true, { resolve, reject });
      });
    }
    return runProbe(signal);
  }, [deferProbe, enqueueTrailingProbe, runProbe]);
  requestRef.current = requestReconciliation;

  const scheduleReconciliation = useCallback((signal: ReconciliationSignal) => {
    const captured = getSnapshotRef.current();
    if (!captured) return;

    const scheduled = scheduledProbeRef.current;
    if (scheduled?.documentId === captured.documentId) {
      scheduled.signal = mergeQueuedSignal(scheduled.signal, signal);
    } else {
      scheduledProbeRef.current = {
        documentId: captured.documentId,
        signal,
      };
    }
    if (coalescingTimerRef.current !== null) return;

    coalescingTimerRef.current = setTimeout(() => {
      coalescingTimerRef.current = null;
      const queued = scheduledProbeRef.current;
      scheduledProbeRef.current = null;
      if (!queued || !mountedRef.current) return;

      const current = getSnapshotRef.current();
      if (!current || current.documentId !== queued.documentId) return;
      void requestRef.current(queued.signal);
    }, RECONCILIATION_COALESCE_MS);
  }, []);

  const resumeDeferredReconciliation = useCallback(() => {
    if (presentationActiveRef.current || activeProbeRef.current) return;
    const deferredProbe = deferredProbeRef.current;
    if (!deferredProbe) return;

    const current = getSnapshotRef.current();
    deferredProbeRef.current = null;
    if (!current || current.documentId !== deferredProbe.documentId) return;
    if (current.userOpenInFlight || current.guardedActionInFlight) {
      deferredProbeRef.current = deferredProbe;
      return;
    }
    void requestRef.current(deferredProbe.signal);
  }, []);

  const supersedeReconciliation = detachPendingWork;

  useEffect(() => {
    if (presentationActive) return;
    resumeDeferredReconciliation();
  }, [presentationActive, resumeDeferredReconciliation]);

  return {
    scheduleReconciliation,
    requestReconciliation,
    resumeDeferredReconciliation,
    supersedeReconciliation,
  };
}
