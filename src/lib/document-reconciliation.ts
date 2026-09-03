import type { AppError, FileRevision, OpenFileResult } from "../types";

export type ReconciliationMode = "reader" | "editor";

export type StaleReconciliationReason =
  | "superseded"
  | "user-action"
  | "document-changed"
  | "session-changed"
  | "ownership-changed"
  | "probe-document-changed"
  | "clean-editor-changed"
  | "no-document";

export interface ReconciliationSnapshot {
  readonly documentId: string;
  readonly filePath: string;
  readonly sessionId: number;
  readonly mode: ReconciliationMode;
  readonly content: string;
  readonly dirty: boolean;
  readonly expectedRevision: FileRevision | null;
  readonly publishedRevision: FileRevision | null;
  readonly ownershipToken: string;
  readonly userOpenInFlight: boolean;
  readonly guardedActionInFlight: boolean;
}

export type ReconciliationProbeResult =
  | {
      readonly status: "available";
      readonly documentId: string;
      readonly document: OpenFileResult;
    }
  | {
      readonly status: "deleted";
      readonly error: AppError;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "unavailable" | "timeout";
      readonly error: AppError;
    };

export type ReconciliationDecision =
  | { readonly kind: "no-change" }
  | {
      readonly kind: "refresh-equal-revision";
      readonly mode: ReconciliationMode;
      readonly dirty: boolean;
      readonly sessionId: number;
      readonly capturedContent: string;
      readonly capturedExpectedRevision: FileRevision | null;
      readonly revision: FileRevision;
    }
  | {
      readonly kind: "reload-reader";
      readonly documentId: string;
      readonly document: OpenFileResult;
    }
  | {
      readonly kind: "refresh-clean-editor";
      readonly sessionId: number;
      readonly capturedContent: string;
      readonly capturedExpectedRevision: FileRevision | null;
      readonly documentId: string;
      readonly document: OpenFileResult;
    }
  | {
      readonly kind: "protect-dirty-editor";
      readonly sessionId: number;
    }
  | {
      readonly kind: "recover-deleted";
      readonly mode: ReconciliationMode;
      readonly sessionId: number;
      readonly dirty: boolean;
      readonly error: AppError;
    }
  | {
      readonly kind: "recover-unavailable";
      readonly reason: "unavailable" | "timeout";
      readonly error: AppError;
    }
  | {
      readonly kind: "stale-noop";
      readonly reason: StaleReconciliationReason;
    };

export interface ReconciliationDecisionInput {
  readonly captured: ReconciliationSnapshot;
  readonly current: ReconciliationSnapshot;
  readonly probe: ReconciliationProbeResult;
  readonly superseded?: boolean;
}

export function sameFileRevision(
  left: FileRevision | null,
  right: FileRevision | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.contentHash === right.contentHash;
}

export function staleReconciliation(
  reason: StaleReconciliationReason,
): ReconciliationDecision {
  return { kind: "stale-noop", reason };
}

export function reconciliationProbeFailure(error: AppError): ReconciliationProbeResult {
  // A failed open cannot prove that the final document was deleted. A missing
  // ancestor, disconnected volume, or provider transition can surface through
  // the same not-found category, so only an explicitly confirmed caller may
  // construct the deleted probe outcome.
  return {
    status: "unavailable",
    reason: "unavailable",
    error,
  };
}

function activeRevision(snapshot: ReconciliationSnapshot): FileRevision | null {
  return snapshot.mode === "editor"
    ? snapshot.expectedRevision
    : snapshot.publishedRevision;
}

function equalRevisionRefresh(
  snapshot: ReconciliationSnapshot,
  revision: FileRevision,
): ReconciliationDecision {
  return {
    kind: "refresh-equal-revision",
    mode: snapshot.mode,
    dirty: snapshot.dirty,
    sessionId: snapshot.sessionId,
    capturedContent: snapshot.content,
    capturedExpectedRevision: snapshot.expectedRevision,
    revision,
  };
}

function staleOwnershipDecision(
  captured: ReconciliationSnapshot,
  current: ReconciliationSnapshot,
  superseded: boolean,
): ReconciliationDecision | null {
  if (superseded) return staleReconciliation("superseded");
  if (
    captured.userOpenInFlight
    || captured.guardedActionInFlight
    || current.userOpenInFlight
    || current.guardedActionInFlight
  ) {
    return staleReconciliation("user-action");
  }
  if (captured.documentId !== current.documentId || captured.filePath !== current.filePath) {
    return staleReconciliation("document-changed");
  }
  if (captured.sessionId !== current.sessionId || captured.mode !== current.mode) {
    return staleReconciliation("session-changed");
  }
  if (captured.ownershipToken !== current.ownershipToken) {
    return staleReconciliation("ownership-changed");
  }
  return null;
}

export function decideDocumentReconciliation({
  captured,
  current,
  probe,
  superseded = false,
}: ReconciliationDecisionInput): ReconciliationDecision {
  const staleOwnership = staleOwnershipDecision(captured, current, superseded);
  if (staleOwnership) return staleOwnership;

  if (current.mode === "editor" && !current.dirty) {
    const cleanEditorChanged = captured.content !== current.content
      || captured.dirty !== current.dirty
      || !sameFileRevision(captured.expectedRevision, current.expectedRevision)
      || !sameFileRevision(captured.publishedRevision, current.publishedRevision);
    if (cleanEditorChanged) return staleReconciliation("clean-editor-changed");
  }

  if (probe.status === "deleted") {
    return {
      kind: "recover-deleted",
      mode: current.mode,
      sessionId: current.sessionId,
      dirty: current.dirty,
      error: probe.error,
    };
  }

  if (probe.status === "unavailable") {
    return {
      kind: "recover-unavailable",
      reason: probe.reason,
      error: probe.error,
    };
  }

  if (probe.documentId !== current.documentId) {
    return staleReconciliation("probe-document-changed");
  }

  const revision = activeRevision(current);
  const revisionChanged = !sameFileRevision(revision, probe.document.revision);
  const contentChanged = current.content !== probe.document.content;

  if (current.mode === "editor" && current.dirty) {
    if (revision === null || revision.contentHash !== probe.document.revision.contentHash) {
      return {
        kind: "protect-dirty-editor",
        sessionId: current.sessionId,
      };
    }
    if (!revisionChanged) return { kind: "no-change" };
    return equalRevisionRefresh(current, probe.document.revision);
  }

  if (!revisionChanged && !contentChanged) return { kind: "no-change" };

  if (!contentChanged) {
    return equalRevisionRefresh(current, probe.document.revision);
  }

  if (current.mode === "reader") {
    return {
      kind: "reload-reader",
      documentId: probe.documentId,
      document: probe.document,
    };
  }

  return {
    kind: "refresh-clean-editor",
    sessionId: current.sessionId,
    capturedContent: current.content,
    capturedExpectedRevision: current.expectedRevision,
    documentId: probe.documentId,
    document: probe.document,
  };
}
