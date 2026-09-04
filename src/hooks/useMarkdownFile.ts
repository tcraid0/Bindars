import { useState, useCallback, useEffect, useRef } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppError, FileRevision, FileType, OpenFileResult } from "../types";
import type { SavedFileSnapshot } from "../lib/editor-save";
import { OPENABLE_FILE_EXTENSIONS } from "../lib/openable-files";
import { appErrorFromNative } from "../lib/native-file-error";
import { boundOperation } from "../lib/bounded-operation";
import type { BoundedOperation } from "../lib/bounded-operation";
import {
  beginDocumentRead,
  DOCUMENT_OPEN_SLOW_MS,
  DOCUMENT_OPEN_TIMEOUT_MS,
  documentReadPathKey,
} from "../lib/document-read";
import type { RetryablePendingAction } from "../lib/app-flow";

export type OpenFilePathResult =
  | { status: "opened"; canonicalPath: string }
  | { status: "failed"; error: AppError; errorOwnerToken: number }
  | { status: "cancelled" }
  | { status: "superseded" };

export interface DocumentErrorState {
  readonly ownerToken: number;
  readonly source: "open" | "reconciliation";
  readonly error: AppError;
  readonly retryAction: RetryablePendingAction | null;
  readonly retryAvailability: "ready" | "native-pending" | null;
}

export interface PublishedDocument {
  readonly content: string | null;
  readonly filePath: string | null;
  readonly fileName: string | null;
  readonly fileRevision: FileRevision | null;
}

export interface OpenOwnership {
  readonly generation: number;
  readonly userOpenInFlight: boolean;
}

function unavailableOpenMessage(
  kind: "pending" | "timeout",
  hasCurrentDocument: boolean,
  hasRetryAction: boolean,
): string {
  const outcome = kind === "pending"
    ? "macOS is still waiting on an earlier request for this file."
    : "Opening this file timed out.";
  const preserved = hasCurrentDocument ? " Your current document remains open." : "";
  const recovery = kind === "pending" ? "that request finishes" : "macOS finishes the storage request";
  const nextStep = hasRetryAction
    ? `Retry will become available when ${recovery}`
    : `Try opening the file again after ${recovery}`;
  return `${outcome}${preserved} ${nextStep}; if it never does, quit and reopen Bindars.`;
}

function availableRetryMessage(kind: "pending" | "timeout", hasCurrentDocument: boolean): string {
  const outcome = kind === "pending"
    ? "The earlier macOS request finished without changing the open document."
    : "The timed-out macOS request has finished.";
  const preserved = hasCurrentDocument ? " Your current document remains open." : "";
  return `${outcome}${preserved} Retry is now available.`;
}

function publishedFileDocument(file: OpenFileResult | SavedFileSnapshot): PublishedDocument {
  return {
    content: file.content,
    filePath: file.canonicalPath,
    fileName: file.name,
    fileRevision: file.revision,
  };
}

interface UseMarkdownFileReturn {
  content: string | null;
  filePath: string | null;
  fileName: string | null;
  fileRevision: FileRevision | null;
  fileType: FileType;
  error: AppError | null;
  documentError: DocumentErrorState | null;
  loading: boolean;
  openingPath: string | null;
  openingSlow: boolean;
  getPublishedDocument: () => PublishedDocument;
  getOpenOwnership: () => OpenOwnership;
  openFile: () => Promise<void>;
  openFilePath: (path: string, retryAction?: RetryablePendingAction) => Promise<boolean>;
  openFilePathWithStatus: (
    path: string,
    retryAction?: RetryablePendingAction,
  ) => Promise<OpenFilePathResult>;
  setVirtualContent: (text: string, name: string) => void;
  adoptSavedFile: (file: SavedFileSnapshot) => void;
  adoptReconciledDocument: (document: OpenFileResult) => void;
  refreshReconciledRevision: (revision: FileRevision) => void;
  reportReconciliationError: (error: AppError) => void;
  clearReconciliationError: () => void;
  cancelPendingOpen: () => void;
  supersedePendingOpen: () => void;
  dismissError: (ownerToken?: number) => void;
}

export function useMarkdownFile(): UseMarkdownFileReturn {
  const [content, setContent] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileRevision, setFileRevision] = useState<FileRevision | null>(null);
  const [documentError, setDocumentError] = useState<DocumentErrorState | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const [openingSlow, setOpeningSlow] = useState(false);
  const requestIdRef = useRef(0);
  const errorOwnerIdRef = useRef(0);
  const userOpenInFlightRef = useRef(false);
  const activeRequestRef = useRef<number | null>(null);
  const activePathKeyRef = useRef<string | null>(null);
  const activeOperationRef = useRef<BoundedOperation<OpenFileResult> | null>(null);
  const publishedDocumentRef = useRef<PublishedDocument>({
    content: null,
    filePath: null,
    fileName: null,
    fileRevision: null,
  });
  const documentErrorRef = useRef<DocumentErrorState | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      activeOperationRef.current?.cancel("superseded");
      activePathKeyRef.current = null;
      activeOperationRef.current = null;
    };
  }, []);

  const publishErrorState = useCallback((next: DocumentErrorState | null) => {
    documentErrorRef.current = next;
    setDocumentError(next);
  }, []);

  const dismissError = useCallback((ownerToken?: number) => {
    if (
      ownerToken !== undefined
      && documentErrorRef.current?.ownerToken !== ownerToken
    ) return;
    publishErrorState(null);
  }, [publishErrorState]);

  const reportOwnedError = useCallback((
    source: DocumentErrorState["source"],
    ownedError: AppError,
    retryAction: RetryablePendingAction | null = null,
    retryAvailability: DocumentErrorState["retryAvailability"] = null,
    released?: Promise<void>,
    releasedError?: AppError,
  ): number => {
    const ownerToken = ++errorOwnerIdRef.current;
    const next: DocumentErrorState = {
      ownerToken,
      source,
      error: ownedError,
      retryAction,
      retryAvailability,
    };
    publishErrorState(next);

    if (retryAvailability === "native-pending" && released) {
      void released.then(() => {
        if (!mountedRef.current) return;
        const current = documentErrorRef.current;
        if (current?.ownerToken !== ownerToken) return;
        publishErrorState({
          ...current,
          error: releasedError ?? current.error,
          retryAvailability: "ready",
        });
      });
    }
    return ownerToken;
  }, [publishErrorState]);

  const cancelActiveOperation = useCallback((reason: "cancelled" | "superseded") => {
    activeOperationRef.current?.cancel(reason);
  }, []);

  const resetOpenTracking = useCallback(() => {
    activeRequestRef.current = null;
    activePathKeyRef.current = null;
    activeOperationRef.current = null;
    userOpenInFlightRef.current = false;
    setLoading(false);
    setOpeningPath(null);
    setOpeningSlow(false);
  }, []);

  const applyPublishedDocument = useCallback((document: PublishedDocument) => {
    // Always replace this object: reader restore compares its identity as a
    // generation token, including before React commits the corresponding state.
    publishedDocumentRef.current = document;
    setContent(document.content);
    setFilePath(document.filePath);
    setFileName(document.fileName);
    setFileRevision(document.fileRevision);
  }, []);

  const publishDocument = useCallback((document: PublishedDocument) => {
    applyPublishedDocument(document);
    publishErrorState(null);
  }, [applyPublishedDocument, publishErrorState]);

  const getPublishedDocument = useCallback(() => publishedDocumentRef.current, []);
  const getOpenOwnership = useCallback((): OpenOwnership => ({
    generation: requestIdRef.current,
    userOpenInFlight: userOpenInFlightRef.current,
  }), []);

  const supersedePendingOpen = useCallback(() => {
    if (activeRequestRef.current !== null) {
      requestIdRef.current += 1;
      cancelActiveOperation("superseded");
      resetOpenTracking();
    }
  }, [cancelActiveOperation, resetOpenTracking]);

  const cancelPendingOpen = useCallback(() => {
    cancelActiveOperation("cancelled");
  }, [cancelActiveOperation]);

  const fileType: FileType =
    filePath?.toLowerCase().endsWith(".fountain") ? "fountain" : "markdown";

  const openFilePathWithStatus = useCallback(async (
    path: string,
    retryAction?: RetryablePendingAction,
  ): Promise<OpenFilePathResult> => {
    const pathKey = documentReadPathKey(path);
    // A user action can overtake the unguarded session restore. When both
    // target the same normalized path, transfer the existing native read to
    // the newer logical owner instead of turning a healthy in-flight read
    // into a same-path saturation error.
    const transferActiveRead = activeRequestRef.current !== null
      && activeOperationRef.current !== null
      && activePathKeyRef.current === pathKey;
    cancelActiveOperation("superseded");
    const requestId = ++requestIdRef.current;
    activeRequestRef.current = requestId;
    activePathKeyRef.current = pathKey;
    setLoading(true);
    publishErrorState(null);
    userOpenInFlightRef.current = true;
    setOpeningPath(path);
    setOpeningSlow(false);

    try {
      const read = beginDocumentRead(path);
      if (read.status === "pending" && !transferActiveRead) {
        const hasCurrentDocument = publishedDocumentRef.current.content !== null;
        const pendingError: AppError = {
          category: "resource-unavailable",
          message: unavailableOpenMessage(
            "pending",
            hasCurrentDocument,
            retryAction !== undefined,
          ),
        };
        const errorOwnerToken = reportOwnedError(
          "open",
          pendingError,
          retryAction ?? null,
          retryAction ? "native-pending" : null,
          read.released,
          retryAction ? {
            category: "resource-unavailable",
            message: availableRetryMessage("pending", hasCurrentDocument),
          } : undefined,
        );
        return { status: "failed", error: pendingError, errorOwnerToken };
      }

      const operation = boundOperation(read.result, {
        slowAfterMs: DOCUMENT_OPEN_SLOW_MS,
        timeoutMs: DOCUMENT_OPEN_TIMEOUT_MS,
        onSlow: () => {
          if (mountedRef.current && requestId === requestIdRef.current) {
            setOpeningSlow(true);
          }
        },
      });
      activeOperationRef.current = operation;
      const outcome = await operation.result;

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return { status: "superseded" };
      }

      if (outcome.status === "cancelled") {
        return { status: outcome.reason };
      }
      if (outcome.status === "timed-out") {
        const hasCurrentDocument = publishedDocumentRef.current.content !== null;
        const timeoutError: AppError = {
          category: "resource-unavailable",
          message: unavailableOpenMessage(
            "timeout",
            hasCurrentDocument,
            retryAction !== undefined,
          ),
        };
        const errorOwnerToken = reportOwnedError(
          "open",
          timeoutError,
          retryAction ?? null,
          retryAction ? "native-pending" : null,
          read.released,
          retryAction ? {
            category: "resource-unavailable",
            message: availableRetryMessage("timeout", hasCurrentDocument),
          } : undefined,
        );
        return { status: "failed", error: timeoutError, errorOwnerToken };
      }
      if (outcome.status === "rejected") {
        const appError = appErrorFromNative(outcome.reason, "Failed to open file.");
        const retryAvailability = retryAction && appError.category === "resource-unavailable"
          ? "ready"
          : null;
        const errorOwnerToken = reportOwnedError(
          "open",
          appError,
          retryAvailability ? retryAction : null,
          retryAvailability,
        );
        return { status: "failed", error: appError, errorOwnerToken };
      }

      publishDocument(publishedFileDocument(outcome.value));
      return { status: "opened", canonicalPath: outcome.value.canonicalPath };
    } catch (unexpectedError) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return { status: "superseded" };
      }
      const appError = appErrorFromNative(unexpectedError, "Failed to open file.");
      const errorOwnerToken = reportOwnedError("open", appError);
      return { status: "failed", error: appError, errorOwnerToken };
    } finally {
      if (activeRequestRef.current === requestId) {
        if (mountedRef.current) {
          resetOpenTracking();
        } else {
          activeRequestRef.current = null;
          activePathKeyRef.current = null;
          activeOperationRef.current = null;
          userOpenInFlightRef.current = false;
        }
      }
    }
  }, [cancelActiveOperation, publishDocument, publishErrorState, reportOwnedError, resetOpenTracking]);

  const openFilePath = useCallback(async (
    path: string,
    retryAction?: RetryablePendingAction,
  ): Promise<boolean> => {
    return (await openFilePathWithStatus(path, retryAction)).status === "opened";
  }, [openFilePathWithStatus]);

  const openFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Supported Files",
            extensions: [...OPENABLE_FILE_EXTENSIONS],
          },
        ],
      });

      if (selected) {
        await openFilePath(selected, { kind: "open-file-path", path: selected });
      }
    } catch (dialogError) {
      reportOwnedError(
        "open",
        appErrorFromNative(dialogError, "Failed to open file."),
      );
    }
  }, [openFilePath, reportOwnedError]);

  const setVirtualContent = useCallback((text: string, name: string) => {
    requestIdRef.current += 1;
    cancelActiveOperation("superseded");
    publishDocument({ content: text, filePath: null, fileName: name, fileRevision: null });
    resetOpenTracking();
  }, [cancelActiveOperation, publishDocument, resetOpenTracking]);

  const adoptSavedFile = useCallback((file: SavedFileSnapshot) => {
    requestIdRef.current += 1;
    cancelActiveOperation("superseded");
    publishDocument(publishedFileDocument(file));
    resetOpenTracking();
  }, [cancelActiveOperation, publishDocument, resetOpenTracking]);

  const clearErrorOwnedBy = useCallback((source: DocumentErrorState["source"]) => {
    if (documentErrorRef.current?.source !== source) return;
    publishErrorState(null);
  }, [publishErrorState]);

  const clearNonRetryableErrorAfterReconciliation = useCallback(() => {
    const current = documentErrorRef.current;
    if (current?.source === "open" && current.retryAction !== null) return;
    publishErrorState(null);
  }, [publishErrorState]);

  const adoptReconciledDocument = useCallback((document: OpenFileResult) => {
    requestIdRef.current += 1;
    cancelActiveOperation("superseded");
    resetOpenTracking();
    const published = publishedFileDocument(document);
    applyPublishedDocument(published);
    clearNonRetryableErrorAfterReconciliation();
  }, [
    applyPublishedDocument,
    cancelActiveOperation,
    clearNonRetryableErrorAfterReconciliation,
    resetOpenTracking,
  ]);

  const refreshReconciledRevision = useCallback((revision: FileRevision) => {
    requestIdRef.current += 1;
    cancelActiveOperation("superseded");
    resetOpenTracking();
    const current = publishedDocumentRef.current;
    const refreshed = { ...current, fileRevision: revision };
    publishedDocumentRef.current = refreshed;
    setFileRevision(revision);
    clearNonRetryableErrorAfterReconciliation();
  }, [cancelActiveOperation, clearNonRetryableErrorAfterReconciliation, resetOpenTracking]);

  const reportReconciliationError = useCallback((reconciliationError: AppError) => {
    const current = documentErrorRef.current;
    if (current?.source === "open" && current.retryAction !== null) return;
    reportOwnedError("reconciliation", reconciliationError);
  }, [reportOwnedError]);

  const clearReconciliationError = useCallback(() => {
    clearErrorOwnedBy("reconciliation");
  }, [clearErrorOwnedBy]);

  return {
    content,
    filePath,
    fileName,
    fileRevision,
    fileType,
    error: documentError?.error ?? null,
    documentError,
    loading,
    openingPath,
    openingSlow,
    getPublishedDocument,
    getOpenOwnership,
    openFile,
    openFilePath,
    openFilePathWithStatus,
    setVirtualContent,
    adoptSavedFile,
    adoptReconciledDocument,
    refreshReconciledRevision,
    reportReconciliationError,
    clearReconciliationError,
    cancelPendingOpen,
    supersedePendingOpen,
    dismissError,
  };
}
