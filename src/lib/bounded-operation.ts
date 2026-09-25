export type BoundedOperationOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timed-out" }
  | { readonly status: "cancelled"; readonly reason: "cancelled" | "superseded" };

interface BoundedOperationOptions {
  readonly timeoutMs: number;
  readonly slowAfterMs?: number;
  readonly onSlow?: () => void;
}

export interface BoundedOperation<T> {
  readonly result: Promise<BoundedOperationOutcome<T>>;
  cancel: (reason?: "cancelled" | "superseded") => void;
}

export function boundOperation<T>(
  operation: Promise<T>,
  { timeoutMs, slowAfterMs, onSlow }: BoundedOperationOptions,
): BoundedOperation<T> {
  let settled = false;
  let resolveResult: (outcome: BoundedOperationOutcome<T>) => void = () => {};
  const result = new Promise<BoundedOperationOutcome<T>>((resolve) => {
    resolveResult = resolve;
  });

  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (outcome: BoundedOperationOutcome<T>) => {
    if (settled) return;
    settled = true;
    if (slowTimer !== null) clearTimeout(slowTimer);
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    resolveResult(outcome);
  };

  if (slowAfterMs !== undefined && onSlow) {
    slowTimer = setTimeout(() => {
      slowTimer = null;
      if (!settled) onSlow();
    }, slowAfterMs);
  }
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    settle({ status: "timed-out" });
  }, timeoutMs);

  void operation.then(
    (value) => settle({ status: "fulfilled", value }),
    (reason) => settle({ status: "rejected", reason }),
  );

  return {
    result,
    cancel(reason = "cancelled") {
      settle({ status: "cancelled", reason });
    },
  };
}
