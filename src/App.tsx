import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { ReaderNavigation } from "./components/ReaderNavigation";
import type { ReaderNavigationHandle } from "./components/ReaderNavigation";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner } from "./components/ErrorBanner";
import { DocumentComplexityNotice } from "./components/DocumentComplexityNotice";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { ReaderControls } from "./components/ReaderControls";
import { DropZone } from "./components/DropZone";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { FocusBar } from "./components/FocusBar";
import { SearchBar } from "./components/SearchBar";
import { FountainRenderer } from "./components/FountainRenderer";
import { extractCharacters, computeScriptStats, isMarkdownSceneHeadingText } from "./lib/fountain";
import { MarkdownEditor } from "./components/MarkdownEditor";
import type { EditorSurfacePosition, MarkdownEditorHandle } from "./components/MarkdownEditor";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { SnapshotRestoreDialog } from "./components/SnapshotRestoreDialog";
import type { SnapshotRestoreChoice } from "./components/SnapshotRestoreDialog";
import { HighlightToolbar } from "./components/HighlightToolbar";
import { AnnotationsPanel } from "./components/AnnotationsPanel";
import { CommandPalette } from "./components/CommandPalette";
import { PresentationView } from "./components/PresentationView";
import { parseSlides } from "./lib/slide-parser";
import type { Slide } from "./lib/slide-parser";
import { useTheme } from "./hooks/useTheme";
import { useEditor } from "./hooks/useEditor";
import { useReaderSettings } from "./hooks/useReaderSettings";
import { useMarkdownFile } from "./hooks/useMarkdownFile";
import type { PublishedDocument } from "./hooks/useMarkdownFile";
import { useDocumentReconciliation } from "./hooks/useDocumentReconciliation";
import type { ReconciliationSignal } from "./hooks/useDocumentReconciliation";
import { useHeadings } from "./hooks/useHeadings";
import { useDragDrop } from "./hooks/useDragDrop";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { useSessionRestore } from "./hooks/useSessionRestore";
import { useNativeOpen } from "./hooks/useNativeOpen";
import { useNativeQuit } from "./hooks/useNativeQuit";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { useSearch } from "./hooks/useSearch";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useAnnotations } from "./hooks/useAnnotations";
import { useWorkspaceRoot } from "./hooks/useWorkspaceRoot";
import { useWorkspaceIndex } from "./hooks/useWorkspaceIndex";
import { useWorkspaceSearch } from "./hooks/useWorkspaceSearch";
import { useWorkspaceInsights } from "./hooks/useWorkspaceInsights";
import { useMarkdownFormatting } from "./hooks/useMarkdownFormatting";
import { usePersistenceCoordinator } from "./hooks/usePersistenceCoordinator";
import { HEADER_HEIGHT_PX, HEADING_SCROLL_MARGIN_PX } from "./lib/scroll-constants";
import { toPathIdentityKey } from "./lib/paths";
import { decideEditNavigation } from "./lib/edit-navigation";
import { decideSaveContinuation, isSuccessfulSave } from "./lib/editor-save";
import type { EditorSaveResult } from "./lib/editor-save";
import { appErrorFromNative, normalizeFileError } from "./lib/native-file-error";
import { isDocumentOpen } from "./lib/document-state";
import { reconciliationProbeFailure } from "./lib/document-reconciliation";
import type {
  ReconciliationDecision,
  ReconciliationProbeResult,
  ReconciliationSnapshot,
} from "./lib/document-reconciliation";
import { canEnterEditMode, canEnterPresentationMode, canToggleEditMode, decideNativeCloseRequest, windowClosePolicy } from "./lib/app-flow";
import { formatReadingStatsSummary } from "./lib/reading-stats";
import { prepareReaderDocument } from "./lib/document-processing";
import { findAnchor, wrapRange, clearAnnotationHighlights } from "./lib/text-anchoring";
import { applyPrintState } from "./lib/print-state";
import { createPrintCleanupController, preparePrintDocument } from "./lib/print-export";
import { useToast } from "./components/ToastProvider";
import { storeGet, storeSet } from "./lib/store";
import { signalAppReady } from "./lib/app-ready";
import {
  captureReaderAnchor,
  findFragmentElement,
  findHeadingElement,
  restoreReaderAnchor,
} from "./lib/editor-position";
import type { ReaderAnchor, SourcePoint } from "./lib/editor-position";
import { isImeCompositionKey } from "./lib/keyboard";
import { formatShortcutLabel, renderShortcutTemplate, detectShortcutPlatform } from "./lib/shortcut-labels";
import {
  createDraftSnapshotId,
  draftSnapshotDocument,
  fileSnapshotDocument,
  getSnapshotStorageStats,
  listDocumentSnapshots,
  listSnapshotDrafts,
  readDocumentSnapshot,
  retireSnapshotDraft,
  writeDocumentSnapshot,
} from "./lib/snapshots";
import type {
  DraftSnapshotDocument,
  FileSnapshotDocument,
  SnapshotDocument,
  SnapshotDraft,
  SnapshotEntry,
  SnapshotStorageStats,
} from "./lib/snapshots";
import type { TextAnchor } from "./lib/text-anchoring";
import type { FileRevision, HighlightColor, OpenFileResult, SceneItem, ScriptSceneStats, WorkspaceSearchHit } from "./types";
import welcomeTemplate from "./assets/welcome.md?raw";

type PendingAction =
  | { kind: "close-window" }
  | { kind: "quit-app" }
  | { kind: "new-file" }
  | { kind: "open-file-dialog" }
  | { kind: "open-file-path"; path: string }
  | { kind: "open-recent"; path: string }
  | { kind: "go-back" }
  | { kind: "go-forward" }
  | { kind: "navigate"; path: string; anchor: string | null }
  | { kind: "open-workspace-hit"; path: string; headingId: string | null };

type EditExitPositionOutcome = "none" | "clean" | "saved" | "discarded";
type SaveContinuationIntent = "stay-editing" | "continue";
type GuardAdmission = "accepted" | "busy";
type ActionAdmissionId = number;

interface AdmittedAction {
  action: PendingAction;
  admissionId: ActionAdmissionId;
}

type PendingReaderTarget =
  | {
      kind: "heading";
      headingId: string;
      documentKey: string;
    }
  | {
      kind: "source";
      source: SourcePoint;
      viewportOffsetPx: number | null;
      documentKey: string | null;
      editorSessionKey: number;
    };

interface EditTransition {
  editorSessionKey: number;
  initialEditorTarget: SourcePoint;
  originalReaderAnchor: ReaderAnchor | null;
}

interface PendingExitReconciliation {
  path: string;
  readerTarget: ReaderAnchor | null;
  editorSessionKey: number;
}

interface DraftSnapshotAdoption {
  draft: DraftSnapshotDocument;
  file: FileSnapshotDocument;
}

interface SaveCurrentEditsOutcome {
  status: EditorSaveResult;
  draftAdoption: DraftSnapshotAdoption | null;
}

interface SaveCurrentEditsOptions {
  forceOverwrite?: boolean;
  quiet?: boolean;
  saveAs?: boolean;
}

type RestoreDialogState =
  | {
      kind: "document";
      document: SnapshotDocument;
      loading: boolean;
      error: string | null;
      entries: SnapshotEntry[];
    }
  | {
      kind: "drafts";
      loading: boolean;
      error: string | null;
      drafts: SnapshotDraft[];
    };

function sameSnapshotDocument(left: SnapshotDocument | null, right: SnapshotDocument): boolean {
  if (!left) return false;
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
  if (left.kind === "draft" && right.kind === "draft") return left.id === right.id;
  return false;
}

function snapshotErrorMessage(error: unknown): string {
  return normalizeFileError(error, "Bindars could not access recovery data.").message;
}

function formatSnapshotTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (!Number.isFinite(timestampMs) || Number.isNaN(date.getTime())) return "Unknown date";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return "Unknown date";
  }
}

function sameSourcePoint(left: SourcePoint, right: SourcePoint): boolean {
  return left.line === right.line && left.column === right.column;
}

function survivingEditorSource(
  transition: EditTransition | null,
  position: EditorSurfacePosition | null,
): SourcePoint | null {
  if (!transition || !position) return null;
  if (position.viewportMoved && position.viewport) return position.viewport;
  return position.cursor;
}

function App() {
  const { theme, setTheme, cycleTheme } = useTheme();
  const { settings, updateSettings, resetSettings } = useReaderSettings();
  const markdownFormatting = useMarkdownFormatting();
  const markdownFormattingEnabled = markdownFormatting.loaded && markdownFormatting.enabled;
  const {
    content,
    filePath,
    fileName,
    fileRevision,
    fileType,
    error,
    loading,
    openingPath,
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
    supersedePendingOpen,
    dismissError,
  } = useMarkdownFile();
  const { recentFiles, loaded: recentFilesLoaded, addRecent, removeRecent, updateScrollPosition, getScrollPosition } = useRecentFiles();
  const { canGoBack, canGoForward, pushEntry, peekBack, commitBack, peekForward, commitForward } =
    useNavigationHistory();
  const workspaceRoot = useWorkspaceRoot();
  const workspaceIndex = useWorkspaceIndex(workspaceRoot.rootPath);
  const workspaceSearch = useWorkspaceSearch({ docs: workspaceIndex.docs, recentFiles });
  const workspaceInsights = useWorkspaceInsights(workspaceIndex.docs, filePath);

  const editorSurfaceRef = useRef<MarkdownEditorHandle | null>(null);
  const dirtyRef = useRef(false);
  const flushPendingBuffer = useCallback(() => {
    const dirty = editorSurfaceRef.current?.flushPendingChanges() ?? null;
    if (dirty !== null) dirtyRef.current = dirty;
    return dirty;
  }, []);
  const editor = useEditor(flushPendingBuffer);
  const publishEditorBuffer = useCallback((nextBuffer: string) => {
    const dirty = editor.updateBuffer(nextBuffer);
    dirtyRef.current = dirty;
    return dirty;
  }, [editor.updateBuffer]);
  const flushAndReadDirty = useCallback(() => {
    return flushPendingBuffer() ?? dirtyRef.current;
  }, [flushPendingBuffer]);
  const { toast } = useToast();

  const preparedDocument = useMemo(
    () => isDocumentOpen(content) ? prepareReaderDocument(content, fileType) : null,
    [content, fileType],
  );
  const readerDocumentReady = preparedDocument?.status === "ready";
  const readingStats = readerDocumentReady ? preparedDocument.readingStats : null;
  const parsedFountain = readerDocumentReady ? preparedDocument.parsedFountain : null;

  const {
    status: annotationStatus,
    ready: annotationsReady,
    loadError: annotationLoadError,
    saveError: annotationSaveError,
    saveErrorVersion: annotationSaveErrorVersion,
    canRetrySave: canRetryAnnotationSave,
    highlights,
    bookmarks,
    addHighlight,
    removeHighlight,
    updateHighlight,
    toggleBookmark,
    isBookmarked,
    retryLoad: retryAnnotationLoad,
    retrySave: retryAnnotationSave,
  } = useAnnotations(filePath);

  const [sidebarVisible, setSidebarVisible] = useState(() => {
    try {
      return localStorage.getItem("bindars-sidebar-visible") === "true";
    } catch {
      return false;
    }
  });
  const [annotationsPanelVisible, setAnnotationsPanelVisible] = useState(false);
  const [tocVisible, setTocVisible] = useState(true);
  const [readerControlsVisible, setReaderControlsVisible] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [shortcutsVisible, setShortcutsVisible] = useState(false);
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorSessionKey, setEditorSessionKey] = useState(0);
  const [editorInitialPosition, setEditorInitialPosition] = useState<SourcePoint | null>(null);
  const [pendingReaderTarget, setPendingReaderTarget] = useState<PendingReaderTarget | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showClearRecoveryDialog, setShowClearRecoveryDialog] = useState(false);
  const [recoveryStorageStats, setRecoveryStorageStats] = useState<SnapshotStorageStats | null>(null);
  const [recoveryStorageStatsLoading, setRecoveryStorageStatsLoading] = useState(false);
  const [recoveryStorageStatsError, setRecoveryStorageStatsError] = useState<string | null>(null);
  const [snapshotDocument, setSnapshotDocument] = useState<SnapshotDocument | null>(null);
  const [restoreDialog, setRestoreDialog] = useState<RestoreDialogState | null>(null);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [actionAdmissionInFlight, setActionAdmissionInFlight] = useState(false);
  const [documentTransitionInFlight, setDocumentTransitionInFlight] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [focusedCharacter, setFocusedCharacter] = useState<string | null>(null);
  const slidesRef = useRef<Slide[]>([]);

  const documentOpen = isDocumentOpen(content);
  const welcomeContent = useMemo(
    () => renderShortcutTemplate(welcomeTemplate),
    [],
  );
  const canToggleEdit = canToggleEditMode({
    documentOpen,
    editing,
    loading,
    documentTransitionInFlight,
  });
  const canPresent = readerDocumentReady && canEnterPresentationMode({
    documentOpen,
    editing,
    loading,
    actionAdmissionInFlight,
    focusMode,
    fileType,
  });

  useEffect(() => {
    if (!annotationSaveError) return;
    toast(annotationSaveError, "error");
  }, [annotationSaveError, annotationSaveErrorVersion, toast]);

  useEffect(() => {
    if (!annotationLoadError) return;
    toast(annotationLoadError, "error");
  }, [annotationLoadError, toast]);

  // Restore sidebar state from Tauri store as async backup (if localStorage had no entry)
  useEffect(() => {
    let active = true;
    try {
      if (localStorage.getItem("bindars-sidebar-visible") !== null) return;
    } catch { /* noop */ }
    storeGet<boolean>("sidebar-visible").then((stored) => {
      if (!active || stored === null) return;
      setSidebarVisible(stored);
    });
    return () => { active = false; };
  }, []);

  // Pending action to run after confirm dialog resolves.
  const pendingActionRef = useRef<AdmittedAction | null>(null);
  // Guards direct-save vs. exit-flow dialog continuations across async writes.
  const saveContinuationIntentRef = useRef<SaveContinuationIntent | null>(null);
  const executePendingActionRef = useRef<(action: PendingAction) => Promise<void>>(async () => {});
  const actionAdmissionOwnerRef = useRef<ActionAdmissionId | null>(null);
  const documentTransitionInFlightRef = useRef(false);
  const nextActionAdmissionIdRef = useRef(0);
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mainScrollRef = useRef<HTMLElement | null>(null);
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const readerNavigationRef = useRef<ReaderNavigationHandle | null>(null);
  const activeHeadingIdRef = useRef<string | null>(null);
  const currentPositionRef = useRef<{ filePath: string | null; headingId: string | null }>({
    filePath: null,
    headingId: null,
  });
  // These mirrors support ordinary async App flows after React publishes a
  // render. Restore uses getPublishedDocument to detect earlier hook
  // publications that React has not rendered yet.
  const currentFilePathRef = useRef(filePath);
  const currentFileNameRef = useRef(fileName);
  const currentFileRevisionRef = useRef(fileRevision);
  const loadedContentRef = useRef(content);
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const progressTextRef = useRef<HTMLSpanElement | null>(null);
  const keyDownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const motionScrollBehavior: ScrollBehavior = settings.reducedEffects ? "auto" : "smooth";
  const editingRef = useRef(editing);
  const editorSessionKeyRef = useRef(0);
  const editTransitionRef = useRef<EditTransition | null>(null);
  const editingFilePathRef = useRef<string | null>(null);
  const snapshotDocumentRef = useRef<SnapshotDocument | null>(snapshotDocument);
  const pendingExitReconciliationRef = useRef<PendingExitReconciliation | null>(null);
  const showConfirmDialogRef = useRef(showConfirmDialog);
  const showConflictDialogRef = useRef(showConflictDialog);
  const restoreDialogOpenRef = useRef(restoreDialog !== null);
  const boundaryFlushInFlightRef = useRef(false);
  const flushBeforeContinuationRef = useRef<() => void>(() => {});
  const welcomePublicationRef = useRef(0);
  const isProgrammaticCloseRef = useRef(false);
  // A close continuation is draining snapshots or crossing the native close
  // handoff. Further close requests must not bypass its safety checks.
  const closeDrainPendingRef = useRef(false);
  const printCleanupControllerRef = useRef<ReturnType<typeof createPrintCleanupController> | null>(null);
  // Invalidates late restore-list results after the dialog closes or switches mode.
  const restoreRequestRef = useRef(0);
  const recoveryStorageStatsRequestRef = useRef(0);
  currentFilePathRef.current = filePath;
  currentFileNameRef.current = fileName;
  currentFileRevisionRef.current = fileRevision;
  loadedContentRef.current = content;
  snapshotDocumentRef.current = snapshotDocument;
  restoreDialogOpenRef.current = restoreDialog !== null;
  currentPositionRef.current = {
    filePath,
    headingId: activeHeadingIdRef.current,
  };

  const reportAutomaticSnapshotError = useCallback((message: string) => {
    console.warn("[snapshots] Automatic snapshots temporarily unavailable; retrying:", message);
    toast("Recovery snapshots are temporarily unavailable. Bindars will keep retrying; saves still work.", "error");
  }, [toast]);

  useEffect(() => {
    const pending = pendingExitReconciliationRef.current;
    if (!pending) return;
    if (!filePath || toPathIdentityKey(filePath) !== toPathIdentityKey(pending.path)) {
      pendingExitReconciliationRef.current = null;
    }
  }, [filePath]);

  const getActiveHeadingId = useCallback(() => activeHeadingIdRef.current, []);

  // In-document search
  const search = useSearch(contentRef);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    search.clear();
  }, [search.clear]);

  // --- Editing helpers ---

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
    savedFlashTimerRef.current = setTimeout(() => setSavedFlash(false), 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
    };
  }, []);

  const openSaveConfirmation = useCallback((intent: SaveContinuationIntent) => {
    saveContinuationIntentRef.current = intent;
    showConfirmDialogRef.current = true;
    setShowConfirmDialog(true);
  }, []);

  const openConflictDialog = useCallback((intent: SaveContinuationIntent) => {
    saveContinuationIntentRef.current = intent;
    showConflictDialogRef.current = true;
    setShowConflictDialog(true);
  }, []);

  const setPrintAttributes = useCallback(
    (printing: boolean) => {
      applyPrintState({
        printing,
        themed: settings.printWithTheme,
        layout: settings.printLayout,
        targets: [document.body, appRootRef.current],
      });
    },
    [settings.printLayout, settings.printWithTheme],
  );

  const clearPrintSession = useCallback(() => {
    printCleanupControllerRef.current?.disarm();
    setPrinting(false);
    setPrintAttributes(false);
  }, [setPrintAttributes]);

  const armPrintCleanup = useCallback(() => {
    if (!printCleanupControllerRef.current) {
      printCleanupControllerRef.current = createPrintCleanupController(clearPrintSession);
    }
    printCleanupControllerRef.current.arm();
  }, [clearPrintSession]);

  const handlePrint = useCallback(async () => {
    setPrintAttributes(true);
    setPrinting(true);
    armPrintCleanup();

    try {
      await preparePrintDocument({ root: contentRef.current });
      window.print();
    } catch (err) {
      console.warn("[print] Failed to prepare document for print:", err);
      clearPrintSession();
      toast("Couldn't prepare document for print.", "error");
    }
  }, [armPrintCleanup, clearPrintSession, setPrintAttributes, toast]);

  const saveCurrentEdits = useCallback(async (
    options: SaveCurrentEditsOptions = {},
  ): Promise<SaveCurrentEditsOutcome> => {
    const draftBeforeSaveAs = !filePath && snapshotDocumentRef.current?.kind === "draft"
      ? snapshotDocumentRef.current
      : null;
    let draftAdoption: DraftSnapshotAdoption | null = null;
    const result = filePath && !options.saveAs
      ? await editor.save(filePath, {
        force: options.forceOverwrite ?? false,
        quiet: options.quiet ?? false,
      })
      : await editor.saveAs(fileName || "Untitled.md");
    if (result.status === "saved" || result.status === "saved-with-newer-edits") {
      editingFilePathRef.current = result.file.canonicalPath;
      const savedSnapshotDocument = fileSnapshotDocument(
        result.file.canonicalPath,
        result.file.name,
      );
      snapshotDocumentRef.current = savedSnapshotDocument;
      setSnapshotDocument(savedSnapshotDocument);
      adoptSavedFile(result.file);
      if (draftBeforeSaveAs) {
        draftAdoption = { draft: draftBeforeSaveAs, file: savedSnapshotDocument };
      }
    }

    const status: EditorSaveResult = result.status;
    if (status === "saved") dirtyRef.current = false;
    if (status === "saved-with-newer-edits") dirtyRef.current = true;
    return { status, draftAdoption };
  }, [adoptSavedFile, editor, fileName, filePath]);

  const performAutosave = useCallback(async () => {
    const outcome = await saveCurrentEdits({ quiet: true });
    if (isSuccessfulSave(outcome.status)) flashSaved();
    return outcome.status;
  }, [flashSaved, saveCurrentEdits]);

  const editorPersistenceActive = editing
    && restoreDialog === null
    && !showConfirmDialog
    && !showConflictDialog;

  const {
    snapshotError,
    autosaveIssue,
    snapshotNow: snapshotCurrentState,
    waitForSnapshotQueue,
    clearRecoveryHistory,
    flushAutosave,
    cancelAutosaveAndWait,
    clearAutosaveIssue,
    recordSaveResult,
  } = usePersistenceCoordinator({
    snapshotActive: editorPersistenceActive,
    autosaveActive: editorPersistenceActive && editor.externalChange === null,
    dirty: editor.dirty,
    sessionKey: editorSessionKey,
    document: snapshotDocument,
    captureBuffer: editor.captureSnapshotBuffer,
    onAutomaticSnapshotError: reportAutomaticSnapshotError,
    bufferVersion: editor.buffer,
    onAutosave: performAutosave,
  });
  let saveWarning = autosaveIssue?.message ?? null;
  if (saveWarning === null && snapshotError) {
    saveWarning = `Recovery snapshots are temporarily unavailable; retrying automatically: ${snapshotError}`;
  }
  if (editor.externalChange) {
    saveWarning = "Autosave is paused because the file changed outside Bindars.";
  }

  const getReconciliationSnapshot = useCallback((): ReconciliationSnapshot | null => {
    const published = getPublishedDocument();
    const path = published.filePath;
    if (path === null || published.content === null) return null;

    const ownership = getOpenOwnership();
    const common = {
      documentId: toPathIdentityKey(path),
      filePath: path,
      publishedRevision: published.fileRevision,
      ownershipToken: `${ownership.generation}:${nextActionAdmissionIdRef.current}:${editorSessionKeyRef.current}`,
      userOpenInFlight: ownership.userOpenInFlight,
      guardedActionInFlight: actionAdmissionOwnerRef.current !== null,
    };

    if (!editingRef.current) {
      return {
        ...common,
        sessionId: ownership.generation,
        mode: "reader",
        content: published.content,
        dirty: false,
        expectedRevision: null,
      };
    }

    const editorState = editor.getReconciliationState();
    if (
      !editorState
      || !editingFilePathRef.current
      || toPathIdentityKey(editingFilePathRef.current) !== common.documentId
    ) {
      return null;
    }
    return {
      ...common,
      sessionId: editorState.sessionId,
      mode: "editor",
      content: editorState.content,
      dirty: editorState.dirty,
      expectedRevision: editorState.expectedRevision,
    };
  }, [editor, getOpenOwnership, getPublishedDocument]);

  const probeForReconciliation = useCallback(async (
    snapshot: ReconciliationSnapshot,
  ): Promise<ReconciliationProbeResult> => {
    try {
      const document = await invoke<OpenFileResult>("open_markdown_file", {
        path: snapshot.filePath,
      });
      return {
        status: "available",
        documentId: toPathIdentityKey(document.canonicalPath),
        document,
      };
    } catch (probeError) {
      return reconciliationProbeFailure(
        appErrorFromNative(probeError, "Bindars couldn't check the open document."),
      );
    }
  }, []);

  const applyReconciliationDecision = useCallback((
    decision: ReconciliationDecision,
    signal: ReconciliationSignal,
  ) => {
    // A watcher probe can already be active when watcher setup settles and
    // queues the editor-exit probe. Until that queued owner completes, every
    // reload for this document must preserve the captured editor source anchor.
    const pendingExit = pendingExitReconciliationRef.current;
    const preserveReaderPosition = (documentId: string) => {
      if (pendingExit?.readerTarget) {
        setPendingReaderTarget({
          kind: "source",
          source: pendingExit.readerTarget.source,
          viewportOffsetPx: pendingExit.readerTarget.viewportOffsetPx,
          documentKey: documentId,
          editorSessionKey: pendingExit.editorSessionKey,
        });
        return;
      }

      const headingId = activeHeadingIdRef.current;
      setPendingReaderTarget(headingId ? {
        kind: "heading",
        headingId,
        documentKey: documentId,
      } : null);
    };

    switch (decision.kind) {
      case "no-change":
        clearReconciliationError();
        break;
      case "refresh-equal-revision":
        if (decision.mode === "editor") {
          let refreshed: boolean;
          if (decision.dirty) {
            if (decision.capturedExpectedRevision === null) return;
            refreshed = editor.refreshDirtyExpectedRevision(
              decision.sessionId,
              decision.capturedExpectedRevision,
              decision.revision,
            );
          } else {
            refreshed = editor.refreshCleanExpectedRevision(
              decision.sessionId,
              decision.capturedContent,
              decision.capturedExpectedRevision,
              decision.revision,
            );
          }
          if (!refreshed) return;
        }
        refreshReconciledRevision(decision.revision);
        break;
      case "reload-reader":
        preserveReaderPosition(decision.documentId);
        adoptReconciledDocument(decision.document);
        break;
      case "refresh-clean-editor": {
        const refreshed = editor.refreshCleanBuffer(
          decision.sessionId,
          decision.capturedContent,
          decision.capturedExpectedRevision,
          decision.document.content,
          decision.document.revision,
          (capturedDocument, externalDocument) => (
            editorSurfaceRef.current?.adoptExternalDocument(
              capturedDocument,
              externalDocument,
            ) ?? false
          ),
        );
        if (!refreshed) return;
        adoptReconciledDocument(decision.document);
        break;
      }
      case "protect-dirty-editor":
        editor.protectFromExternalChange(decision.sessionId, "changed");
        clearReconciliationError();
        break;
      case "recover-deleted":
        if (decision.mode === "editor") {
          editor.protectFromExternalChange(decision.sessionId, "deleted");
        } else {
          reportReconciliationError({
            ...decision.error,
            message: "This file was deleted outside Bindars. The current document remains open so its contents can be recovered.",
          });
        }
        break;
      case "recover-unavailable":
        reportReconciliationError({
          ...decision.error,
          message: decision.reason === "timeout"
            ? "Checking this file timed out. The current document remains open; try again when the file is available."
            : decision.error.message,
        });
        break;
      case "stale-noop":
        return;
    }

    if (signal === "editor-exit") pendingExitReconciliationRef.current = null;
  }, [
    adoptReconciledDocument,
    clearReconciliationError,
    editor,
    refreshReconciledRevision,
    reportReconciliationError,
  ]);

  const {
    requestReconciliation,
    resumeDeferredReconciliation,
    supersedeReconciliation,
  } = useDocumentReconciliation({
    presentationActive: presentationMode,
    getSnapshot: getReconciliationSnapshot,
    probe: probeForReconciliation,
    applyDecision: applyReconciliationDecision,
  });

  const loadRecoveryStorageStats = useCallback(async (): Promise<void> => {
    const request = recoveryStorageStatsRequestRef.current + 1;
    recoveryStorageStatsRequestRef.current = request;
    setRecoveryStorageStatsLoading(true);
    setRecoveryStorageStatsError(null);
    try {
      const stats = await getSnapshotStorageStats();
      if (recoveryStorageStatsRequestRef.current !== request) return;
      setRecoveryStorageStats(stats);
    } catch (error) {
      if (recoveryStorageStatsRequestRef.current !== request) return;
      setRecoveryStorageStatsError(snapshotErrorMessage(error));
    } finally {
      if (recoveryStorageStatsRequestRef.current === request) {
        setRecoveryStorageStatsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!readerControlsVisible) return;
    void loadRecoveryStorageStats();
  }, [loadRecoveryStorageStats, readerControlsVisible]);

  const finishDraftSnapshotAdoption = useCallback(async (
    adoption: DraftSnapshotAdoption | null,
  ): Promise<void> => {
    if (!adoption) return;
    try {
      // The explicit document crosses the Save As render boundary, and the
      // coordinator queue lets all older draft writes finish before retirement.
      await snapshotCurrentState(adoption.file);
      await retireSnapshotDraft(adoption.draft);
    } catch (error) {
      console.warn("[snapshots] Failed to finish Save As recovery migration:", error);
      toast("The file was saved, but Bindars couldn't finish moving its recovery history.", "error");
    }
  }, [snapshotCurrentState, toast]);

  const saveCurrentEditsWithRecovery = useCallback(async (
    options: SaveCurrentEditsOptions = {},
  ): Promise<EditorSaveResult> => {
    const outcome = await saveCurrentEdits(options);
    await finishDraftSnapshotAdoption(outcome.draftAdoption);
    return outcome.status;
  }, [finishDraftSnapshotAdoption, saveCurrentEdits]);

  const handleSave = useCallback(async () => {
    if (actionAdmissionOwnerRef.current !== null) return;
    const pendingIssue = await cancelAutosaveAndWait();
    if (pendingIssue?.kind === "conflict") {
      openConflictDialog("stay-editing");
      return;
    }
    clearAutosaveIssue();
    if (filePath && !flushAndReadDirty()) {
      flashSaved();
      return;
    }

    const result = await saveCurrentEditsWithRecovery();
    recordSaveResult(result);
    if (isSuccessfulSave(result)) {
      clearAutosaveIssue();
      flashSaved();
      return;
    }
    if (result === "conflict") {
      openConflictDialog("stay-editing");
    }
  }, [cancelAutosaveAndWait, clearAutosaveIssue, filePath, flashSaved, flushAndReadDirty, openConflictDialog, recordSaveResult, saveCurrentEditsWithRecovery]);

  const handleSaveAsAfterError = useCallback(async () => {
    if (actionAdmissionOwnerRef.current !== null) return;
    await cancelAutosaveAndWait();
    clearAutosaveIssue();

    const result = await saveCurrentEditsWithRecovery({ saveAs: true });
    recordSaveResult(result);
    if (isSuccessfulSave(result)) {
      clearAutosaveIssue();
      flashSaved();
    }
  }, [cancelAutosaveAndWait, clearAutosaveIssue, flashSaved, recordSaveResult, saveCurrentEditsWithRecovery]);

  const beginEditSession = useCallback((
    initialContent: string,
    revision: FileRevision | null,
    path: string | null,
    name: string,
    readerAnchor: ReaderAnchor | null = null,
    restoredDraftDocument: SnapshotDocument | null = null,
  ) => {
    supersedeReconciliation();
    pendingExitReconciliationRef.current = null;
    supersedePendingOpen();
    const nextSessionKey = editorSessionKeyRef.current + 1;
    editorSessionKeyRef.current = nextSessionKey;
    const initialEditorTarget = readerAnchor?.source ?? { line: 1, column: 1 };
    editor.enterEditMode(initialContent, revision);
    editingFilePathRef.current = path;
    const nextSnapshotDocument = restoredDraftDocument
      ?? (path
        ? fileSnapshotDocument(path, name)
        : draftSnapshotDocument(createDraftSnapshotId(), name));
    snapshotDocumentRef.current = nextSnapshotDocument;
    setSnapshotDocument(nextSnapshotDocument);
    editTransitionRef.current = {
      editorSessionKey: nextSessionKey,
      initialEditorTarget,
      originalReaderAnchor: readerAnchor,
    };
    setPendingReaderTarget(null);
    setEditorInitialPosition(initialEditorTarget);
    setEditing(true);
    setEditorSessionKey(nextSessionKey);
    editingRef.current = true;
    dirtyRef.current = false;
    showConflictDialogRef.current = false;
    setShowConflictDialog(false);
    saveContinuationIntentRef.current = null;
    setSavedFlash(false);
    if (searchVisible) closeSearch();
  }, [closeSearch, editor, searchVisible, supersedePendingOpen, supersedeReconciliation]);

  const enterEditMode = useCallback(() => {
    if (
      documentTransitionInFlightRef.current
      || !isDocumentOpen(content)
      || !canEnterEditMode({
        documentOpen: true,
        editing,
        loading,
        documentTransitionInFlight,
      })
    ) return;
    const readerAnchor = contentRef.current && mainScrollRef.current
      ? captureReaderAnchor(contentRef.current, mainScrollRef.current, activeHeadingIdRef.current, content)
      : null;
    beginEditSession(content, fileRevision, filePath, fileName || "Untitled.md", readerAnchor);
  }, [beginEditSession, content, documentTransitionInFlight, editing, fileName, filePath, fileRevision, loading]);

  const resetEditSession = useCallback(() => {
    supersedeReconciliation();
    editor.exitEditMode();
    editingFilePathRef.current = null;
    snapshotDocumentRef.current = null;
    setSnapshotDocument(null);
    editTransitionRef.current = null;
    setPendingReaderTarget(null);
    setEditorInitialPosition(null);
    setEditing(false);
    setSavedFlash(false);
    editingRef.current = false;
    dirtyRef.current = false;
    saveContinuationIntentRef.current = null;
  }, [editor, supersedeReconciliation]);

  const publishSourceReaderTarget = useCallback((
    readerTarget: ReaderAnchor | null,
    documentKey: string | null,
    editorSessionKey: number,
  ) => {
    if (!readerTarget || editorSessionKeyRef.current !== editorSessionKey) return;
    setPendingReaderTarget({
      kind: "source",
      source: readerTarget.source,
      viewportOffsetPx: readerTarget.viewportOffsetPx,
      documentKey,
      editorSessionKey,
    });
  }, []);

  const exitEditMode = useCallback((positionOutcome: EditExitPositionOutcome = "none") => {
    const transition = editTransitionRef.current;
    const surfacePosition = positionOutcome === "clean" || positionOutcome === "saved"
      ? editorSurfaceRef.current?.capturePosition() ?? null
      : null;
    let readerTarget: ReaderAnchor | null = null;
    const survivingSource = survivingEditorSource(transition, surfacePosition);

    if (transition && positionOutcome === "discarded") {
      readerTarget = transition.originalReaderAnchor;
    } else if (transition && positionOutcome === "saved") {
      readerTarget = transition.originalReaderAnchor;
      if (survivingSource) {
        readerTarget = {
          source: survivingSource,
          // Moved editor positions restore by semantic block, not identical
          // pixel offset, because reader and editor wrapping differ.
          viewportOffsetPx: 0,
        };
      }
    } else if (transition && positionOutcome === "clean") {
      if (!surfacePosition) {
        readerTarget = transition.originalReaderAnchor;
      } else {
        readerTarget = !surfacePosition.viewportMoved
          && sameSourcePoint(surfacePosition.cursor, transition.initialEditorTarget)
          ? transition.originalReaderAnchor
          : {
              source: survivingSource ?? surfacePosition.cursor,
              viewportOffsetPx: 0,
            };
      }
    }

    const sessionKey = transition?.editorSessionKey ?? editorSessionKeyRef.current;
    const exitPath = editingFilePathRef.current;
    const documentKey = exitPath ? toPathIdentityKey(exitPath) : null;
    resetEditSession();

    publishSourceReaderTarget(readerTarget, documentKey, sessionKey);

    // Reconciliation starts only after the watcher attempt settles. That closes
    // the read-before-watch gap while still reconciling when watching fails.
    if (exitPath) {
      pendingExitReconciliationRef.current = {
        path: exitPath,
        readerTarget,
        editorSessionKey: sessionKey,
      };
    }
  }, [publishSourceReaderTarget, resetEditSession]);

  // Frozen for the app's lifetime: the running platform cannot change, and
  // the close guard's window policy must stay stable across re-renders.
  const closePolicy = useMemo(() => windowClosePolicy(detectShortcutPlatform()), []);

  const beginActionAdmission = useCallback((action: PendingAction): ActionAdmissionId | null => {
    if (actionAdmissionOwnerRef.current !== null) return null;
    const admissionId = nextActionAdmissionIdRef.current + 1;
    nextActionAdmissionIdRef.current = admissionId;
    actionAdmissionOwnerRef.current = admissionId;
    const blocksDocumentEntry = action.kind !== "close-window";
    documentTransitionInFlightRef.current = blocksDocumentEntry;
    setActionAdmissionInFlight(true);
    setDocumentTransitionInFlight(blocksDocumentEntry);
    return admissionId;
  }, []);

  const finishActionAdmission = useCallback((admissionId: ActionAdmissionId) => {
    if (actionAdmissionOwnerRef.current !== admissionId) return;
    actionAdmissionOwnerRef.current = null;
    documentTransitionInFlightRef.current = false;
    setActionAdmissionInFlight(false);
    setDocumentTransitionInFlight(false);
    resumeDeferredReconciliation();
  }, [resumeDeferredReconciliation]);

  const cancelPendingAction = useCallback(() => {
    const admitted = pendingActionRef.current;
    pendingActionRef.current = null;
    if (admitted) finishActionAdmission(admitted.admissionId);
  }, [finishActionAdmission]);

  const executeAdmittedAction = useCallback((admitted: AdmittedAction) => {
    void (async () => {
      try {
        if (admitted.action.kind !== "close-window") {
          await waitForSnapshotQueue();
        }
        await executePendingActionRef.current(admitted.action);
      } catch (error) {
        console.error("[action-guard] Admitted action failed:", error);
      } finally {
        finishActionAdmission(admitted.admissionId);
      }
    })();
  }, [finishActionAdmission, waitForSnapshotQueue]);

  const resolvePendingAction = useCallback(() => {
    const admitted = pendingActionRef.current;
    pendingActionRef.current = null;
    if (admitted) executeAdmittedAction(admitted);
  }, [executeAdmittedAction]);

  const continueAfterSuccessfulSave = useCallback((intent: SaveContinuationIntent) => {
    saveContinuationIntentRef.current = null;
    if (intent === "stay-editing") return;
    if (editingRef.current) {
      exitEditMode(pendingActionRef.current ? "none" : "saved");
    }
    editingRef.current = false;
    dirtyRef.current = false;
    resolvePendingAction();
  }, [exitEditMode, resolvePendingAction]);

  const discardEditsAndContinue = useCallback(() => {
    saveContinuationIntentRef.current = null;
    // Exiting edit mode re-reads the current file from disk.
    exitEditMode(pendingActionRef.current ? "none" : "discarded");
    editingRef.current = false;
    dirtyRef.current = false;
    resolvePendingAction();
  }, [exitEditMode, resolvePendingAction]);

  const flushBeforeContinuation = useCallback(async () => {
    if (boundaryFlushInFlightRef.current) return;
    boundaryFlushInFlightRef.current = true;
    try {
      const result = await flushAutosave();
      if (!editingRef.current) {
        resolvePendingAction();
        return;
      }
      if (result === "conflict") {
        openConflictDialog("continue");
        return;
      }
      if (result && isSuccessfulSave(result) && !flushAndReadDirty()) {
        flashSaved();
        continueAfterSuccessfulSave("continue");
        return;
      }
      openSaveConfirmation("continue");
    } catch (error) {
      console.error("[action-guard] Failed to flush before continuing:", error);
      cancelPendingAction();
      toast("Couldn't finish the current file action. Your document is still open.", "error");
    } finally {
      boundaryFlushInFlightRef.current = false;
    }
  }, [cancelPendingAction, continueAfterSuccessfulSave, flashSaved, flushAndReadDirty, flushAutosave, openConflictDialog, openSaveConfirmation, resolvePendingAction, toast]);
  // The native close listener is registered once; this mirror keeps its async
  // autosave boundary pointed at the current session and save callbacks.
  flushBeforeContinuationRef.current = () => {
    void flushBeforeContinuation();
  };

  const guardedExitEditMode = useCallback(() => {
    if (
      !editing
      || actionAdmissionOwnerRef.current !== null
      || boundaryFlushInFlightRef.current
    ) return;
    if (!flushAndReadDirty()) {
      exitEditMode("clean");
      return;
    }
    void flushBeforeContinuation();
  }, [editing, exitEditMode, flushAndReadDirty, flushBeforeContinuation]);

  const toggleEditMode = useCallback(() => {
    if (editing) {
      guardedExitEditMode();
    } else {
      enterEditMode();
    }
  }, [editing, guardedExitEditMode, enterEditMode]);

  // Guard: run an action only if editor is clean, else flush pending autosave.
  const guardAction = useCallback((action: PendingAction): GuardAdmission => {
    if (
      actionAdmissionOwnerRef.current !== null
      || pendingActionRef.current
      || boundaryFlushInFlightRef.current
      || showConfirmDialogRef.current
      || showConflictDialogRef.current
      || restoreDialogOpenRef.current
    ) {
      return "busy";
    }
    const decision = decideEditNavigation({
      editing: editingRef.current,
      dirty: flushAndReadDirty(),
      confirmDialogOpen: showConfirmDialogRef.current,
      conflictDialogOpen: showConflictDialogRef.current,
    });

    if (decision === "ignore") return "busy";
    const admissionId = beginActionAdmission(action);
    if (admissionId === null) return "busy";
    const admitted = { action, admissionId };
    if (presentationMode) {
      // Exit presentation inline — navigation will replace content anyway,
      // so no deferred reload needed.
      setPresentationMode(false);
      setCurrentSlide(0);
      slidesRef.current = [];
      supersedeReconciliation();
    }
    if (decision === "run-after-exit") {
      resetEditSession();
      executeAdmittedAction(admitted);
      return "accepted";
    }
    if (decision === "run") {
      executeAdmittedAction(admitted);
      return "accepted";
    }
    pendingActionRef.current = admitted;
    void flushBeforeContinuation();
    return "accepted";
  }, [beginActionAdmission, executeAdmittedAction, flushAndReadDirty, presentationMode, resetEditSession, flushBeforeContinuation, supersedeReconciliation]);
  // The native close and quit listeners are registered once; these mirrors
  // keep them pointed at the current guard admission.
  const guardActionRef = useRef<(action: PendingAction) => GuardAdmission>(() => "busy");
  guardActionRef.current = guardAction;

  // Discarding is irreversible in the editor, so capture the abandoned buffer
  // first. Best-effort by design: the capture is enqueued synchronously (before
  // session teardown can clear the buffer) but never blocks or cancels the
  // discard the user asked for.
  const captureDiscardedBuffer = useCallback(() => {
    if (!editingRef.current || !flushAndReadDirty()) return;
    void snapshotCurrentState().catch(() => {
      toast("Couldn't snapshot the discarded text, so it may not be recoverable.", "error");
    });
  }, [flushAndReadDirty, snapshotCurrentState, toast]);

  const handleConfirmDiscard = useCallback(() => {
    setShowConfirmDialog(false);
    setShowConflictDialog(false);
    showConfirmDialogRef.current = false;
    showConflictDialogRef.current = false;
    captureDiscardedBuffer();
    discardEditsAndContinue();
  }, [captureDiscardedBuffer, discardEditsAndContinue]);

  const handleConfirmSave = useCallback(async () => {
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    const continuationIntent = saveContinuationIntentRef.current ?? "continue";

    clearAutosaveIssue();
    const result = await saveCurrentEditsWithRecovery();
    recordSaveResult(result);
    const continuationDecision = decideSaveContinuation(result);
    if (continuationDecision === "continue") {
      flashSaved();
      continueAfterSuccessfulSave(continuationIntent);
      return;
    }
    if (continuationDecision === "reconfirm") {
      flashSaved();
      openSaveConfirmation(continuationIntent);
      return;
    }
    if (result === "conflict") {
      openConflictDialog(continuationIntent);
      return;
    }
    saveContinuationIntentRef.current = null;
    cancelPendingAction();
  }, [cancelPendingAction, clearAutosaveIssue, recordSaveResult, saveCurrentEditsWithRecovery, flashSaved, continueAfterSuccessfulSave, openConflictDialog, openSaveConfirmation]);

  const handleConfirmCancel = useCallback(() => {
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    saveContinuationIntentRef.current = null;
    cancelPendingAction();
  }, [cancelPendingAction]);

  const handleConflictOverwrite = useCallback(async () => {
    const continuationIntent = saveContinuationIntentRef.current ?? "stay-editing";
    clearAutosaveIssue();
    const result = await saveCurrentEditsWithRecovery({ forceOverwrite: true });
    recordSaveResult(result);
    const continuationDecision = decideSaveContinuation(result);
    if (continuationDecision === "stop") return;

    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    flashSaved();
    if (continuationDecision === "reconfirm") {
      openSaveConfirmation(continuationIntent);
      return;
    }
    continueAfterSuccessfulSave(continuationIntent);
  }, [clearAutosaveIssue, recordSaveResult, saveCurrentEditsWithRecovery, flashSaved, continueAfterSuccessfulSave, openSaveConfirmation]);

  const handleConflictReload = useCallback(async () => {
    // "Reload" resolves conflict by discarding local edits and reading file content from disk.
    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    clearAutosaveIssue();
    captureDiscardedBuffer();

    if (saveContinuationIntentRef.current === "continue") {
      discardEditsAndContinue();
      return;
    }

    exitEditMode("discarded");
  }, [captureDiscardedBuffer, clearAutosaveIssue, discardEditsAndContinue, exitEditMode]);

  const handleConflictCancel = useCallback(() => {
    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    saveContinuationIntentRef.current = null;
    cancelPendingAction();
  }, [cancelPendingAction]);

  useEffect(() => {
    editingRef.current = editing;
    dirtyRef.current = editor.dirty;
    showConfirmDialogRef.current = showConfirmDialog;
    showConflictDialogRef.current = showConflictDialog;
  }, [editing, editor.dirty, showConfirmDialog, showConflictDialog]);

  useEffect(() => {
    if (!editing) return;
    if (editingFilePathRef.current === filePath) return;
    resetEditSession();
  }, [editing, filePath, resetEditSession]);

  // Guarded versions that don't depend on later declarations
  const createNewDocument = useCallback(() => {
    welcomePublicationRef.current += 1;
    setVirtualContent("", "Untitled.md");
    beginEditSession("", null, null, "Untitled.md");
  }, [beginEditSession, setVirtualContent]);

  const getCurrentSnapshotDocument = useCallback((): SnapshotDocument | null => {
    if (editingRef.current) return snapshotDocumentRef.current;
    const path = currentFilePathRef.current;
    if (!path) return null;
    return fileSnapshotDocument(path, currentFileNameRef.current || "Untitled.md");
  }, []);

  const closeRestoreDialog = useCallback(() => {
    restoreRequestRef.current += 1;
    setRestoringSnapshotId(null);
    setRestoreDialog(null);
  }, []);

  const openDocumentSnapshotRestore = useCallback(async () => {
    if (actionAdmissionOwnerRef.current !== null) return;
    const document = getCurrentSnapshotDocument();
    if (!document) return;

    const request = restoreRequestRef.current + 1;
    restoreRequestRef.current = request;
    setRestoreDialog({
      kind: "document",
      document,
      loading: true,
      error: null,
      entries: [],
    });
    try {
      // A just-discarded buffer may still be a queued capture; the list must
      // not be populated before those writes land.
      await waitForSnapshotQueue();
      if (restoreRequestRef.current !== request) return;
      const entries = await listDocumentSnapshots(document);
      if (restoreRequestRef.current !== request) return;
      setRestoreDialog({
        kind: "document",
        document,
        loading: false,
        error: null,
        entries,
      });
    } catch (error) {
      if (restoreRequestRef.current !== request) return;
      setRestoreDialog({
        kind: "document",
        document,
        loading: false,
        error: snapshotErrorMessage(error),
        entries: [],
      });
    }
  }, [getCurrentSnapshotDocument, waitForSnapshotQueue]);

  const openDraftSnapshotRestore = useCallback(async () => {
    if (actionAdmissionOwnerRef.current !== null) return;
    const request = restoreRequestRef.current + 1;
    restoreRequestRef.current = request;
    setRestoreDialog({ kind: "drafts", loading: true, error: null, drafts: [] });
    try {
      // A just-discarded draft may still be a queued capture; wait for it so
      // the orphan list reflects it.
      await waitForSnapshotQueue();
      if (restoreRequestRef.current !== request) return;
      const result = await listSnapshotDrafts();
      if (restoreRequestRef.current !== request) return;
      setRestoreDialog({
        kind: "drafts",
        loading: false,
        error: null,
        drafts: result.drafts,
      });
      if (result.skippedCount > 0) {
        console.warn(`[snapshots] Skipped ${result.skippedCount} unreadable draft stream(s).`);
      }
    } catch (error) {
      if (restoreRequestRef.current !== request) return;
      setRestoreDialog({
        kind: "drafts",
        loading: false,
        error: snapshotErrorMessage(error),
        drafts: [],
      });
    }
  }, [waitForSnapshotQueue]);

  const restoreDocumentSnapshot = useCallback(async (
    document: SnapshotDocument,
    snapshotId: string,
  ) => {
    // Dismissal or a newer restore increments this ref. Recheck it after every
    // await so a late IPC result cannot replace a buffer the user resumed editing.
    const request = restoreRequestRef.current;
    let readerPublication: PublishedDocument | null = null;
    const assertRestoreContextCurrent = () => {
      if (!sameSnapshotDocument(getCurrentSnapshotDocument(), document)
        || (readerPublication !== null
          && (editingRef.current
            || getPublishedDocument() !== readerPublication))) {
        throw new Error("The active document changed before the snapshot could be restored.");
      }
    };
    setRestoringSnapshotId(snapshotId);
    try {
      // Validate and retain the selected bytes before creating safety boundaries;
      // no editor state changes until both safety writes finish.
      const restoredContent = await readDocumentSnapshot(document, snapshotId);
      if (restoreRequestRef.current !== request) return;
      assertRestoreContextCurrent();

      if (editingRef.current) {
        await snapshotCurrentState();
      } else {
        // Reader safety writes bypass the coordinator, so finish every older
        // automatic write before starting the backup/checkpoint pair.
        await waitForSnapshotQueue();
        if (restoreRequestRef.current !== request) return;
        if (editingRef.current
          || !sameSnapshotDocument(getCurrentSnapshotDocument(), document)) {
          throw new Error("The active document changed before the snapshot could be restored.");
        }
        const publication = getPublishedDocument();
        const publicationPathKey = publication.filePath
          ? toPathIdentityKey(publication.filePath)
          : null;
        const documentPathKey = document.kind === "file" ? toPathIdentityKey(document.path) : null;
        if (!publicationPathKey || publicationPathKey !== documentPathKey) {
          throw new Error("The active document changed before the snapshot could be restored.");
        }
        if (publication.content === null || publication.fileRevision === null) {
          throw new Error("The active document closed before it could be snapshotted.");
        }
        readerPublication = publication;
        await writeDocumentSnapshot(document, publication.content, { preservePrevious: true });
      }
      if (restoreRequestRef.current !== request) return;
      assertRestoreContextCurrent();

      // Keep the pre-rollback backup as a separate boundary. Subsequent rapid
      // automatic snapshots may merge the restored side without deleting it.
      await writeDocumentSnapshot(document, restoredContent, { preservePrevious: true });
      if (restoreRequestRef.current !== request) return;
      assertRestoreContextCurrent();

      const baseline = readerPublication?.content
        ?? (document.kind === "file" ? loadedContentRef.current : editor.flushAndReadBuffer());
      if (baseline === null) {
        throw new Error("The active document closed before the snapshot could be restored.");
      }
      const revision = readerPublication?.fileRevision
        ?? (document.kind === "file" ? currentFileRevisionRef.current : null);
      const path = readerPublication?.filePath
        ?? (document.kind === "file" ? document.path : null);
      const name = readerPublication?.fileName ?? document.name;
      beginEditSession(baseline, revision, path, name, null, document);
      const dirty = editor.updateBuffer(restoredContent);
      dirtyRef.current = dirty;
      closeRestoreDialog();
      toast(dirty ? "Snapshot restored. Save when you're ready." : "That snapshot already matches the current text.", "info");
    } catch (error) {
      if (restoreRequestRef.current !== request) return;
      setRestoringSnapshotId(null);
      const message = snapshotErrorMessage(error);
      setRestoreDialog((current) => current?.kind === "document"
        ? { ...current, error: message }
        : current);
      toast("Couldn't restore the snapshot. The current text was not changed.", "error");
    }
  }, [beginEditSession, closeRestoreDialog, editor, getCurrentSnapshotDocument, getPublishedDocument, snapshotCurrentState, toast, waitForSnapshotQueue]);

  const restoreDraftSnapshot = useCallback(async (draft: SnapshotDraft) => {
    const request = restoreRequestRef.current;
    setRestoringSnapshotId(draft.id);
    try {
      const document = draftSnapshotDocument(draft.id, draft.name);
      const entries = await listDocumentSnapshots(document);
      if (restoreRequestRef.current !== request) return;
      const latest = entries[0];
      if (!latest) throw new Error("This draft has no readable snapshots.");
      const restoredContent = await readDocumentSnapshot(document, latest.id);
      if (restoreRequestRef.current !== request) return;
      if (editingRef.current || isDocumentOpen(loadedContentRef.current)) {
        throw new Error("Another document opened before the draft could be restored.");
      }

      setVirtualContent("", draft.name);
      beginEditSession("", null, null, draft.name, null, document);
      const dirty = editor.updateBuffer(restoredContent);
      dirtyRef.current = dirty;
      closeRestoreDialog();
      toast("Recovered draft restored. Save it to choose a file location.", "info");
    } catch (error) {
      if (restoreRequestRef.current !== request) return;
      setRestoringSnapshotId(null);
      const message = snapshotErrorMessage(error);
      setRestoreDialog((current) => current?.kind === "drafts"
        ? { ...current, error: message }
        : current);
      toast("Couldn't restore that draft.", "error");
    }
  }, [beginEditSession, closeRestoreDialog, editor, setVirtualContent, toast]);

  const handleRestoreChoice = useCallback((id: string) => {
    const current = restoreDialog;
    if (!current || current.loading || current.error || restoringSnapshotId !== null) return;
    if (current.kind === "document") {
      void restoreDocumentSnapshot(current.document, id);
      return;
    }
    const draft = current.drafts.find((candidate) => candidate.id === id);
    if (draft) void restoreDraftSnapshot(draft);
  }, [restoreDialog, restoreDocumentSnapshot, restoreDraftSnapshot, restoringSnapshotId]);

  const restoreChoices = useMemo<SnapshotRestoreChoice[]>(() => {
    if (!restoreDialog) return [];
    if (restoreDialog.kind === "document") {
      return restoreDialog.entries.map((entry) => ({
        id: entry.id,
        title: formatSnapshotTime(entry.createdAtMs),
        detail: `${entry.size.toLocaleString()} bytes`,
      }));
    }
    return restoreDialog.drafts.map((draft) => ({
      id: draft.id,
      title: draft.name,
      detail: `${formatSnapshotTime(draft.latestSnapshotAtMs)} · ${draft.snapshotCount} snapshot${draft.snapshotCount === 1 ? "" : "s"}`,
    }));
  }, [restoreDialog]);

  const guardedNewFile = useCallback(() => {
    guardAction({ kind: "new-file" });
  }, [guardAction]);

  const guardedOpenFile = useCallback(() => {
    guardAction({ kind: "open-file-dialog" });
  }, [guardAction]);

  const admitExternalOpenPath = useCallback((path: string): GuardAdmission => {
    const admission = guardAction({ kind: "open-file-path", path });
    if (admission === "busy") {
      toast(
        "Bindars is finishing another file action. Try opening the file again in a moment.",
        "error",
      );
    }
    return admission;
  }, [guardAction, toast]);

  const guardedOpenFilePath = useCallback((paths: string[]): GuardAdmission => {
    const path = paths[0];
    return path ? admitExternalOpenPath(path) : "busy";
  }, [admitExternalOpenPath]);

  const { waitForInitialNativeOpen } = useNativeOpen({
    onOpenPath: admitExternalOpenPath,
  });

  // Native quit requests (custom macOS Quit menu item / Command-Q) go through
  // the same admission guard as document actions. The process exits only from
  // the quit-app continuation, after Save/Discard/Cancel resolves and the
  // snapshot queue has drained; the native side never terminates on its own.
  const requestGuardedQuit = useCallback(() => {
    const admission = guardActionRef.current({ kind: "quit-app" });
    if (admission === "busy") {
      toast("Bindars is finishing another file action. Try quitting again in a moment.", "error");
    }
  }, [toast]);

  useNativeQuit({ onQuitRequested: requestGuardedQuit });

  // Tauri window close guard. On macOS the main window is hidden instead of
  // destroyed so the process stays available for Dock reopen; a dirty document
  // resolves Save/Discard/Cancel first. Other platforms keep the previous
  // behavior of destroying the window and exiting on the last close.
  // Register once and read live state from refs to avoid stale closures.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | null = null;

    const handleCloseRequest = (event: { preventDefault: () => void }) => {
      const decision = decideNativeCloseRequest({
        closePolicy,
        programmaticCloseInFlight: isProgrammaticCloseRef.current,
        closeDrainPending: closeDrainPendingRef.current,
        actionAdmissionInFlight: actionAdmissionOwnerRef.current !== null,
      });

      switch (decision) {
        case "complete-programmatic-close": {
          isProgrammaticCloseRef.current = false;
          closeDrainPendingRef.current = false;
          // `appWindow.close()` crosses the native IPC boundary before this
          // callback runs. Any editor active now belongs to a newer session and
          // must cancel the stale close, even if it is not dirty yet.
          if (editingRef.current) {
            event.preventDefault();
          }
          return;
        }
        case "prevent-silently":
          // A close continuation is draining snapshots, or another admitted
          // action owns the guard. Repeated native close requests must not
          // bypass either safety check.
          event.preventDefault();
          return;
        case "prevent-and-guard":
          // macOS never lets the close request destroy the window. Clean and
          // dirty requests converge on the same guard: a dirty document
          // resolves Save/Discard/Cancel, and the continuation hides the
          // window once the snapshot queue has drained.
          event.preventDefault();
          guardActionRef.current({ kind: "close-window" });
          return;
        case "allow-native-close": {
          // Allow native OS close behavior when there are no unsaved edits.
          if (!editingRef.current || !flushAndReadDirty()) {
            return;
          }

          event.preventDefault();

          // Keep unsaved-change protection strict while the confirm dialog is
          // open and never stack the unsaved-changes dialog under the restore
          // modal. guardAction refuses those states too; these checks keep
          // the close request visibly swallowed instead of dropped silently.
          if (showConfirmDialogRef.current || showConflictDialogRef.current) {
            return;
          }
          if (restoreDialogOpenRef.current) return;
          if (boundaryFlushInFlightRef.current) return;

          guardActionRef.current({ kind: "close-window" });
          return;
        }
      }
    };

    const setup = async () => {
      try {
        const detach = await appWindow.onCloseRequested(handleCloseRequest);
        if (!active) {
          detach();
          return;
        }
        unlisten = detach;
      } catch (err) {
        console.warn("[close-guard] Failed to attach close handler:", err);
      }
    };

    void setup();

    return () => {
      active = false;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
  }, [closePolicy, flushAndReadDirty]);

  // beforeunload: publish any pending editor content before deciding whether to warn.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editingRef.current && flushAndReadDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [flushAndReadDirty]);

  // Exit edit mode when content changes (new file opened externally)
  useEffect(() => {
    if (editing && !isDocumentOpen(content)) {
      exitEditMode();
    }
  }, [content, editing, exitEditMode]);

  const openSearch = useCallback(() => {
    if (!isDocumentOpen(content) || editing || !readerDocumentReady) return;
    setSearchVisible(true);
  }, [content, editing, readerDocumentReady]);

  // Close search when content changes (new file opened)
  const prevContentRef = useRef(content);
  useEffect(() => {
    if (prevContentRef.current !== content) {
      prevContentRef.current = content;
      if (searchVisible) {
        search.clear();
      }
    }
  }, [content, searchVisible, search.clear]);

  const updateReadingProgressNow = useCallback(() => {
    const scrollEl = mainScrollRef.current;
    const bar = progressBarRef.current;
    if (!scrollEl) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    const max = scrollHeight - clientHeight;
    const pct = max > 0 ? Math.max(0, Math.min(scrollTop / max, 1)) : 0;
    if (bar) bar.style.transform = `scaleX(${pct})`;
    const textEl = progressTextRef.current;
    const progressText = `${Math.round(pct * 100)}%`;
    if (textEl && textEl.textContent !== progressText) {
      textEl.textContent = progressText;
    }
  }, []);

  // Reading progress bar — update via ref to avoid state churn on scroll.
  // Layout timing repopulates a remounted reader span before paint.
  useLayoutEffect(() => {
    const scrollEl = mainScrollRef.current;
    if (!scrollEl) return;

    let frame: number | null = null;

    const scheduleProgressUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        updateReadingProgressNow();
      });
    };

    scrollEl.addEventListener("scroll", scheduleProgressUpdate, { passive: true });
    updateReadingProgressNow();
    return () => {
      scrollEl.removeEventListener("scroll", scheduleProgressUpdate);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [content, editing, focusMode, presentationMode, updateReadingProgressNow]);

  // Extract headings after the reader DOM renders. Active tracking is colocated
  // with the TOC so heading changes do not rerender the full App tree.
  const headings = useHeadings(contentRef, content, !editing && readerDocumentReady);

  const scrollToHeading = useCallback(
    (
      headingId: string,
      options: ScrollIntoViewOptions = {},
    ): boolean => {
      const root = contentRef.current;
      if (!root) return false;
      const node = findHeadingElement(root, headingId);
      if (!node) return false;
      const behavior = options.behavior ?? motionScrollBehavior;

      readerNavigationRef.current?.setActiveId(headingId, {
        suppressObserverMs: behavior === "smooth" ? 450 : 0,
      });
      node.scrollIntoView({
        block: "start",
        behavior,
        ...options,
      });
      return true;
    },
    [motionScrollBehavior],
  );

  const scrollToFragment = useCallback(
    (
      fragmentId: string,
      options: ScrollIntoViewOptions = {},
    ): boolean => {
      const root = contentRef.current;
      if (!root) return false;
      const target = findFragmentElement(root, fragmentId);
      if (!target) return false;
      if (findHeadingElement(root, fragmentId) === target) {
        return scrollToHeading(fragmentId, options);
      }

      target.scrollIntoView({
        block: "start",
        behavior: options.behavior ?? motionScrollBehavior,
        ...options,
      });
      return true;
    },
    [motionScrollBehavior, scrollToHeading],
  );

  const openMarkdownFragment = useCallback(
    (fragmentId: string) => scrollToFragment(fragmentId, { behavior: "auto" }),
    [scrollToFragment],
  );

  const characters = useMemo(() => {
    if (!parsedFountain) return [];
    return extractCharacters(parsedFountain);
  }, [parsedFountain]);

  const scriptStats = useMemo(() => {
    if (!parsedFountain) return null;
    return computeScriptStats(parsedFountain);
  }, [parsedFountain]);

  const sceneStatsByHeadingId = useMemo<Record<string, ScriptSceneStats>>(() => {
    if (!scriptStats) return {};
    return Object.fromEntries(scriptStats.scenes.map((scene) => [scene.sceneId, scene]));
  }, [scriptStats]);

  const statsSummary = useMemo(() => {
    if (!readingStats) return null;

    if (fileType === "fountain" && scriptStats) {
      return formatReadingStatsSummary(readingStats, {
        pageCount: scriptStats.totalPages,
        runtimeMinutes: scriptStats.estimatedRuntimeMinutes,
      });
    }

    return formatReadingStatsSummary(readingStats);
  }, [fileType, readingStats, scriptStats]);

  // Clear focused character when file changes
  const prevFilePathRef = useRef(filePath);
  useEffect(() => {
    if (filePath !== prevFilePathRef.current) {
      prevFilePathRef.current = filePath;
      setFocusedCharacter(null);
    }
  }, [filePath]);

  const handleToggleCharacterFocus = useCallback((name: string) => {
    setFocusedCharacter((prev) => prev === name ? null : name);
  }, []);

  const sceneItems = useMemo(() => {
    if (!settings.sceneLensEnabled || !readerDocumentReady) return [];
    if (workspaceInsights.scenes.length > 0) return workspaceInsights.scenes;

    if (parsedFountain) {
      return parsedFountain.scenes.map((s) => ({
        id: s.id,
        label: s.text,
        line: s.index,
        headingId: s.id,
      }));
    }

    const fallbackScenes: SceneItem[] = [];
    for (let i = 0; i < headings.length; i += 1) {
      const heading = headings[i];
      if (!isMarkdownSceneHeadingText(heading.text)) continue;
      fallbackScenes.push({
        id: `scene-fallback-${heading.id}`,
        label: heading.text,
        line: i + 1,
        headingId: heading.id,
      });
    }
    return fallbackScenes;
  }, [settings.sceneLensEnabled, workspaceInsights.scenes, headings, parsedFountain, readerDocumentReady]);

  // Pending reader target: set before navigation or reader restoration and
  // consumed once by the newly mounted, correctly scoped reader DOM.
  const openAttemptIdRef = useRef(0);

  const openPathAndScroll = useCallback(
    async (path: string, headingId: string | null): Promise<boolean> => {
      // Only the latest user navigation may clear pending scroll after a failed open.
      // Watcher reloads preserve the current heading separately and intentionally
      // bypass this supersession guard.
      const openAttemptId = ++openAttemptIdRef.current;
      setPendingReaderTarget(null);
      const result = await openFilePathWithStatus(path);
      if (openAttemptIdRef.current !== openAttemptId) return false;

      if (result.status === "opened" && headingId) {
        setPendingReaderTarget({
          kind: "heading",
          headingId,
          documentKey: toPathIdentityKey(result.canonicalPath),
        });
      }
      return result.status === "opened";
    },
    [openFilePathWithStatus],
  );

  // Session restore: reopen last file + scroll position on startup
  const handleSessionRestore = useCallback(
    async (session: { filePath: string; headingId: string | null }) => {
      const ok = await openPathAndScroll(session.filePath, session.headingId);
      if (!ok) {
        dismissError();
      }
    },
    [openPathAndScroll, dismissError],
  );

  const {
    restored: sessionRestored,
    notifyPositionChanged: notifySessionPositionChanged,
  } = useSessionRestore({
    filePath,
    getActiveHeadingId,
    onRestore: handleSessionRestore,
    waitForInitialNativeOpen,
  });

  // First-run: show welcome sample file on first launch
  useEffect(() => {
    // Wait for both startup signals
    if (!sessionRestored || !recentFilesLoaded) return;
    // Skip if something already loaded
    if (isDocumentOpen(content) || filePath || loading) return;
    if (recentFiles.length > 0) return;

    let cancelled = false;
    const publicationId = ++welcomePublicationRef.current;
    storeGet<boolean>("hasSeenWelcome").then((seen) => {
      if (cancelled || seen || welcomePublicationRef.current !== publicationId) return;
      setVirtualContent(welcomeContent, "Welcome to Bindars.md");
      storeSet("hasSeenWelcome", true);
    });
    return () => { cancelled = true; };
  }, [sessionRestored, recentFilesLoaded, content, filePath, loading, recentFiles.length, setVirtualContent, welcomeContent]);

  useLayoutEffect(() => {
    if (editing || !pendingReaderTarget) return;
    const root = contentRef.current;
    const scrollRoot = mainScrollRef.current;
    if (!root || !scrollRoot) return;

    const currentDocumentKey = filePath ? toPathIdentityKey(filePath) : null;
    if (pendingReaderTarget.documentKey !== currentDocumentKey) {
      setPendingReaderTarget(null);
      return;
    }

    if (pendingReaderTarget.kind === "source") {
      if (pendingReaderTarget.editorSessionKey !== editorSessionKeyRef.current) return;
      restoreReaderAnchor(
        root,
        scrollRoot,
        pendingReaderTarget.source,
        pendingReaderTarget.viewportOffsetPx,
      );
      updateReadingProgressNow();
      setPendingReaderTarget(null);
      return;
    }

    if (!scrollToHeading(pendingReaderTarget.headingId, { behavior: "auto" })) {
      toast(`Heading "${pendingReaderTarget.headingId}" not found — it may have been renamed or removed.`, "error");
    }
    setPendingReaderTarget(null);
  }, [content, editing, filePath, pendingReaderTarget, scrollToHeading, toast, updateReadingProgressNow]);

  const handleActiveHeadingChange = useCallback((headingId: string | null) => {
    activeHeadingIdRef.current = headingId;
    currentPositionRef.current = {
      filePath: currentFilePathRef.current,
      headingId,
    };
    notifySessionPositionChanged();

    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = null;
    const path = currentFilePathRef.current;
    if (!path || !headingId) return;
    scrollSaveTimerRef.current = setTimeout(() => {
      scrollSaveTimerRef.current = null;
      if (currentFilePathRef.current !== path || activeHeadingIdRef.current !== headingId) return;
      updateScrollPosition(path, headingId);
    }, 1500);
  }, [notifySessionPositionChanged, updateScrollPosition]);

  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) {
        clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
    };
  }, []);

  // File watcher: auto-reload on external changes
  const handleFileChanged = useCallback((changedPath: string) => {
    const currentPath = currentPositionRef.current.filePath;
    if (!currentPath) return;

    const changedPathKey = toPathIdentityKey(changedPath);
    const currentPathKey = toPathIdentityKey(currentPath);
    if (!changedPathKey || changedPathKey !== currentPathKey) return;

    void requestReconciliation("watcher");
  }, [requestReconciliation]);

  const handleWatchSettled = useCallback((watchedPath: string) => {
    const pending = pendingExitReconciliationRef.current;
    if (!pending) return;
    if (toPathIdentityKey(pending.path) !== toPathIdentityKey(watchedPath)) {
      pendingExitReconciliationRef.current = null;
      return;
    }

    const currentPath = currentFilePathRef.current;
    if (
      editingRef.current
      || editorSessionKeyRef.current !== pending.editorSessionKey
      || !currentPath
      || toPathIdentityKey(currentPath) !== toPathIdentityKey(pending.path)
    ) {
      pendingExitReconciliationRef.current = null;
      return;
    }

    void requestReconciliation("editor-exit").then((result) => {
      if (result.kind === "stale-noop") {
        pendingExitReconciliationRef.current = null;
      }
    });
  }, [requestReconciliation]);

  useFileWatcher({
    filePath,
    isEditing: editing,
    onFileChanged: handleFileChanged,
    onWatchSettled: handleWatchSettled,
  });

  // Annotations: highlight handler
  const handleHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, headingId: string | null) => {
    addHighlight(anchor, color, headingId);
  }, [addHighlight]);

  // Apply annotation highlights to DOM after content renders
  useEffect(() => {
    if (editing || !readerDocumentReady) return;
    const container = contentRef.current;
    if (!container || !isDocumentOpen(content)) return;

    const frameId = requestAnimationFrame(() => {
      clearAnnotationHighlights(container);
      for (const hl of highlights) {
        const range = findAnchor({ prefix: hl.prefix, exact: hl.exact, suffix: hl.suffix }, container);
        if (range) {
          wrapRange(range, `annotation-highlight-${hl.color}`, hl.id);
        }
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [content, editing, highlights, readerDocumentReady]);

  // Scroll to highlight when clicked in panel
  const handleClickHighlight = useCallback((id: string) => {
    const container = contentRef.current;
    if (!container) return;
    const mark = container.querySelector(`mark[data-highlight-id="${id}"]`);
    if (mark) {
      mark.scrollIntoView({ behavior: motionScrollBehavior, block: "center" });
    }
  }, [motionScrollBehavior]);

  // Scroll to bookmark when clicked in panel
  const handleClickBookmark = useCallback((headingId: string) => {
    scrollToHeading(headingId);
  }, [scrollToHeading]);

  // Navigate to a relative .md link
  const handleNavigateToFile = useCallback(
    async (path: string, anchor: string | null) => {
      // Same-file shortcut: skip re-reading and scroll directly
      if (filePath && toPathIdentityKey(path) === toPathIdentityKey(filePath)) {
        if (anchor) {
          if (!scrollToFragment(anchor, { behavior: "auto" })) {
            toast(`Link target "#${anchor}" not found in this document`, "error");
          }
        }
        return;
      }

      const pos = currentPositionRef.current;
      const ok = await openPathAndScroll(path, anchor);
      if (ok) {
        if (pos.filePath) {
          pushEntry({ filePath: pos.filePath, headingId: pos.headingId });
        }
      }
    },
    [filePath, pushEntry, openPathAndScroll, scrollToFragment, toast],
  );

  const handleGoBack = useCallback(async () => {
    const entry = peekBack();
    if (!entry) return;
    const pos = currentPositionRef.current;
    if (!pos.filePath) return;
    const ok = await openPathAndScroll(entry.filePath, entry.headingId);
    if (ok) {
      commitBack({ filePath: pos.filePath, headingId: pos.headingId });
    }
  }, [peekBack, commitBack, openPathAndScroll]);

  const handleGoForward = useCallback(async () => {
    const entry = peekForward();
    if (!entry) return;
    const pos = currentPositionRef.current;
    if (!pos.filePath) return;
    const ok = await openPathAndScroll(entry.filePath, entry.headingId);
    if (ok) {
      commitForward({ filePath: pos.filePath, headingId: pos.headingId });
    }
  }, [peekForward, commitForward, openPathAndScroll]);

  // Update window title with current filename
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const title = fileName ? `${fileName} — Bindars` : "Bindars";
    void appWindow.setTitle(title).catch((err) => {
      console.warn("[window-title] Failed to set window title:", err);
    });
  }, [fileName]);

  // Auto-add to recent when a file is loaded
  useEffect(() => {
    if (filePath && fileName) {
      addRecent(filePath, fileName);
    }
  }, [filePath, fileName, addRecent]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      const targetPathKey = toPathIdentityKey(path);
      const currentPathKey = filePath ? toPathIdentityKey(filePath) : "";
      const savedHeading = getScrollPosition(path);
      if (targetPathKey && currentPathKey === targetPathKey) {
        if (savedHeading && savedHeading !== getActiveHeadingId()) {
          scrollToHeading(savedHeading);
        }
        return;
      }

      await openPathAndScroll(path, savedHeading);
    },
    [filePath, getActiveHeadingId, getScrollPosition, openPathAndScroll, scrollToHeading],
  );

  // Guarded versions that depend on navigation/file handlers
  const guardedOpenRecent = useCallback(
    (path: string) => {
      guardAction({ kind: "open-recent", path });
    },
    [guardAction],
  );

  const guardedGoBack = useCallback(() => {
    guardAction({ kind: "go-back" });
  }, [guardAction]);

  const guardedGoForward = useCallback(() => {
    guardAction({ kind: "go-forward" });
  }, [guardAction]);

  const guardedNavigateToFile = useCallback(
    (path: string, anchor: string | null) => {
      guardAction({ kind: "navigate", path, anchor });
    },
    [guardAction],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((v) => {
      const next = !v;
      try { localStorage.setItem("bindars-sidebar-visible", String(next)); } catch { /* noop */ }
      void storeSet("sidebar-visible", next);
      return next;
    });
  }, []);

  const toggleToc = useCallback(() => {
    setTocVisible((v) => !v);
  }, []);

  const toggleReaderControls = useCallback(() => {
    setReaderControlsVisible((v) => !v);
  }, []);

  const closeReaderControls = useCallback(() => {
    setReaderControlsVisible(false);
  }, []);

  const requestClearRecoveryHistory = useCallback(() => {
    setReaderControlsVisible(false);
    setShowClearRecoveryDialog(true);
  }, []);

  const cancelClearRecoveryHistory = useCallback(() => {
    setShowClearRecoveryDialog(false);
  }, []);

  const confirmClearRecoveryHistory = useCallback(async () => {
    setShowClearRecoveryDialog(false);
    try {
      await clearRecoveryHistory();
      toast("Recovery history cleared. New snapshots will be created as you edit.", "info");
      void loadRecoveryStorageStats();
    } catch (error) {
      console.warn("[snapshots] Failed to clear recovery history:", error);
      toast("Couldn't clear recovery history. Some snapshots may remain.", "error");
    }
  }, [clearRecoveryHistory, loadRecoveryStorageStats, toast]);

  const toggleAnnotationsPanel = useCallback(() => {
    setAnnotationsPanelVisible((v) => !v);
  }, []);

  const closeAnnotationsPanel = useCallback(() => {
    setAnnotationsPanelVisible(false);
  }, []);

  const closeShortcuts = useCallback(() => {
    setShortcutsVisible(false);
  }, []);

  const openCommandPalette = useCallback(() => {
    setCommandPaletteVisible(true);
  }, []);

  const closeCommandPalette = useCallback(() => {
    setCommandPaletteVisible(false);
    workspaceSearch.reset();
  }, [workspaceSearch.reset]);

  const exitFocusMode = useCallback(() => {
    setFocusMode(false);
  }, []);

  const enterPresentation = useCallback(() => {
    if (
      actionAdmissionOwnerRef.current !== null
      || !isDocumentOpen(content)
      || !readerDocumentReady
      || !canEnterPresentationMode({
        documentOpen: true,
        editing,
        loading,
        actionAdmissionInFlight,
        focusMode,
        fileType,
      })
    ) return;
    const slides = parseSlides(content);
    if (slides.length === 0) return;
    slidesRef.current = slides;
    setCurrentSlide(0);
    setPresentationMode(true);
  }, [actionAdmissionInFlight, content, editing, loading, focusMode, fileType, readerDocumentReady]);

  const exitPresentation = useCallback(() => {
    setPresentationMode(false);
    setCurrentSlide(0);
    slidesRef.current = [];
  }, []);

  const nextSlide = useCallback(() => {
    setCurrentSlide((i) => Math.min(i + 1, slidesRef.current.length - 1));
  }, []);

  const prevSlide = useCallback(() => {
    setCurrentSlide((i) => Math.max(i - 1, 0));
  }, []);

  const openWorkspacePath = useCallback(
    (path: string) => {
      guardAction({ kind: "navigate", path, anchor: null });
    },
    [guardAction],
  );

  const openWorkspaceHit = useCallback(
    (hit: WorkspaceSearchHit) => {
      guardAction({ kind: "open-workspace-hit", path: hit.path, headingId: hit.headingId });
      closeCommandPalette();
    },
    [guardAction, closeCommandPalette],
  );

  executePendingActionRef.current = async (action) => {
    switch (action.kind) {
      case "close-window": {
        const appWindow = getCurrentWindow();
        // Queued snapshot writes (notably the fire-and-forget discard capture)
        // must reach the backend before the window leaves the screen. Hiding
        // keeps the WebView alive, but draining first also protects data if the
        // process exits immediately after the hide.
        closeDrainPendingRef.current = true;
        try {
          await waitForSnapshotQueue();
          // Exiting for the original close leaves no active editor. If one
          // exists now, it is a newer session and wins over the stale close.
          if (editingRef.current) {
            closeDrainPendingRef.current = false;
            return;
          }
          if (closePolicy === "hide") {
            // Hiding emits no close-requested event, so there is no
            // programmatic-close handshake to finish; the process simply
            // stays available for Dock reopen and Finder delivery.
            closeDrainPendingRef.current = false;
            await appWindow.hide();
          } else {
            isProgrammaticCloseRef.current = true;
            // Keep the drain guard set until the resulting close-requested
            // callback performs the final new-session check.
            await appWindow.close();
          }
        } catch (err) {
          closeDrainPendingRef.current = false;
          isProgrammaticCloseRef.current = false;
          console.error("[close-guard] Programmatic close or hide failed:", err);
          toast("Couldn't close the window. Your document is still open.", "error");
        }
        return;
      }
      case "quit-app": {
        // executeAdmittedAction has already drained the snapshot queue for
        // this action. A newly entered edit session wins over the stale quit.
        if (editingRef.current) {
          console.warn("[quit-guard] A new edit session started before the quit completed; keeping the app running.");
          return;
        }
        try {
          await invoke("exit_after_guarded_quit");
        } catch (error) {
          console.error("[quit-guard] Failed to exit after the guard completed:", error);
          toast("Couldn't quit Bindars. Your document is still open.", "error");
        }
        return;
      }
      case "new-file":
        createNewDocument();
        return;
      case "open-file-dialog":
        await openFile();
        return;
      case "open-file-path":
        await openFilePath(action.path);
        return;
      case "open-recent":
        await handleOpenRecent(action.path);
        return;
      case "go-back":
        await handleGoBack();
        return;
      case "go-forward":
        await handleGoForward();
        return;
      case "navigate":
        await handleNavigateToFile(action.path, action.anchor);
        return;
      case "open-workspace-hit":
        if (action.path === filePath) {
          if (action.headingId) {
            scrollToHeading(action.headingId);
          }
          return;
        }
        await handleNavigateToFile(action.path, action.headingId);
        return;
    }
  };

  const openScene = useCallback((scene: SceneItem) => {
    if (!scene.headingId) return;
    scrollToHeading(scene.headingId);
  }, [scrollToHeading]);

  const navigateScene = useCallback((direction: -1 | 1) => {
    if (sceneItems.length === 0) return;
    const activeHeadingId = getActiveHeadingId();
    const currentIdx = activeHeadingId
      ? sceneItems.findIndex((s) => s.headingId === activeHeadingId)
      : -1;
    let targetIdx: number;
    if (currentIdx === -1) {
      targetIdx = direction === 1 ? 0 : sceneItems.length - 1;
    } else {
      targetIdx = currentIdx + direction;
    }
    if (targetIdx < 0 || targetIdx >= sceneItems.length) return;
    const target = sceneItems[targetIdx];
    if (!target.headingId) return;
    scrollToHeading(target.headingId);
  }, [getActiveHeadingId, sceneItems, scrollToHeading]);

  const handleDragEnter = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDropPaths = useCallback(
    (paths: string[]) => {
      guardedOpenFilePath(paths);
    },
    [guardedOpenFilePath],
  );

  // Drag and drop
  useDragDrop({
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDropPaths,
  });

  // Keyboard shortcuts
  keyDownHandlerRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (showConfirmDialog || showConflictDialog || showClearRecoveryDialog || restoreDialog) return;
    if (isImeCompositionKey(e)) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const altGraph = e.getModifierState?.("AltGraph") ?? false;
    const target = e.target as HTMLElement | null;
    const inInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const inEditorPanel = editing && typeof target?.closest === "function" && Boolean(target.closest(".cm-panel"));

    // Presentation mode: intercept all keys
    if (presentationMode) {
      if (key === "escape") { e.preventDefault(); exitPresentation(); return; }
      if (key === "arrowright" || key === "arrowdown" || key === " " || key === "enter") {
        e.preventDefault();
        nextSlide();
        return;
      }
      if (key === "arrowleft" || key === "arrowup" || key === "backspace") {
        e.preventDefault();
        prevSlide();
        return;
      }
      if (key === "home") { e.preventDefault(); setCurrentSlide(0); return; }
      if (key === "end") { e.preventDefault(); setCurrentSlide(slidesRef.current.length - 1); return; }
      return; // Block all other shortcuts while presenting
    }

    // CodeMirror owns its search panel except for the global save contract.
    // Ctrl/Cmd+S must flush the editor even while the panel input has focus.
    if (inEditorPanel && !(ctrl && key === "s")) {
      const appShortcutBeforeInput = ctrl && (
        key === "k"
        || key === "n"
        || key === "o"
        || key === "e"
        || (e.altKey && !altGraph && key === "m")
        || (e.shiftKey && key === "t")
      );
      if (appShortcutBeforeInput) e.preventDefault();
      return;
    }

    if (ctrl && key === "k") {
      e.preventDefault();
      if (commandPaletteVisible) {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
      return;
    }

    if (commandPaletteVisible) {
      if (key === "escape") {
        e.preventDefault();
        closeCommandPalette();
      } else if (key === "arrowdown") {
        e.preventDefault();
        workspaceSearch.moveNext();
      } else if (key === "arrowup") {
        e.preventDefault();
        workspaceSearch.movePrevious();
      } else if (key === "enter") {
        const hit = workspaceSearch.selectedHit;
        if (hit) {
          e.preventDefault();
          openWorkspaceHit(hit);
        }
      }
      return;
    }

    // App owns this persisted view preference. Reader and Fountain sessions
    // deliberately leave Ctrl+Alt+M inert rather than borrowing Ctrl+M's
    // annotations behavior.
    if (ctrl && e.altKey && !altGraph && key === "m") {
      if (editing && fileType === "markdown") {
        e.preventDefault();
        markdownFormatting.toggle();
      }
      return;
    }

    // Ctrl+N: create a document (must run before inInput bail-out)
    if (ctrl && key === "n") {
      e.preventDefault();
      guardedNewFile();
      return;
    }

    // Ctrl+O: open a file (must run before the editor input bail-out)
    if (ctrl && key === "o") {
      e.preventDefault();
      guardedOpenFile();
      return;
    }

    // Ctrl+S: save in edit mode (must run before inInput bail-out)
    if (ctrl && key === "s") {
      e.preventDefault();
      if (editing) handleSave();
      return;
    }

    // Ctrl+E: toggle edit mode (must run before inInput bail-out)
    if (ctrl && key === "e") {
      e.preventDefault();
      if (canToggleEditMode({
        documentOpen: isDocumentOpen(content),
        editing,
        loading,
        documentTransitionInFlight,
      })) toggleEditMode();
      return;
    }

    // Ctrl+Shift+T: cycle theme (must run before the editor input bail-out)
    if (ctrl && e.shiftKey && key === "t") {
      e.preventDefault();
      cycleTheme();
      return;
    }

    // Allow Escape and Enter/Shift+Enter in search input
    if (inInput && searchVisible) {
      if (key === "escape") {
        e.preventDefault();
        closeSearch();
        return;
      }
      // Let SearchBar handle Enter/Shift+Enter internally
      return;
    }

    // Escape in the editor surface
    if (inInput && editing) {
      if (key === "escape") {
        e.preventDefault();
        guardedExitEditMode();
        return;
      }
      if (ctrl && key === "p") {
        e.preventDefault();
        return;
      }
      return;
    }

    if (inInput) return;

    if (shortcutsVisible) {
      if (key === "escape") {
        e.preventDefault();
        closeShortcuts();
      } else if (e.key === "?" && !ctrl && !e.altKey) {
        e.preventDefault();
        closeShortcuts();
      }
      return;
    }

    if (ctrl && key === "d") {
      e.preventDefault();
      const activeHeadingId = getActiveHeadingId();
      if (activeHeadingId && isDocumentOpen(content) && !editing && annotationsReady) {
        const heading = headings.find((h) => h.id === activeHeadingId);
        if (heading) {
          toggleBookmark(heading.id, heading.text);
        }
      }
    } else if (ctrl && key === "m") {
      e.preventDefault();
      if (!editing) toggleAnnotationsPanel();
    } else if (ctrl && key === "f" && !e.shiftKey) {
      e.preventDefault();
      openSearch();
    } else if (ctrl && key === "p") {
      e.preventDefault();
      if (isDocumentOpen(content) && !editing) {
        handlePrint();
      }
    } else if (key === "escape" && searchVisible) {
      e.preventDefault();
      closeSearch();
    } else if (ctrl && key === "b") {
      e.preventDefault();
      toggleSidebar();
    } else if (ctrl && key === "j") {
      e.preventDefault();
      if (!editing) toggleToc();
    } else if (ctrl && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
      if (!editing) toggleToc();
    } else if (ctrl && e.shiftKey && key === "f") {
      e.preventDefault();
      if (!editing) setFocusMode((v) => !v);
    } else if (key === "escape" && !ctrl && !e.altKey && !e.shiftKey) {
      if (focusMode) {
        e.preventDefault();
        exitFocusMode();
      } else if (editing) {
        e.preventDefault();
        guardedExitEditMode();
      } else if (shortcutsVisible) {
        e.preventDefault();
        closeShortcuts();
      } else if (focusedCharacter) {
        e.preventDefault();
        setFocusedCharacter(null);
      }
    } else if (ctrl && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      updateSettings({ fontSize: settings.fontSize + 1 });
    } else if (ctrl && key === "-") {
      e.preventDefault();
      updateSettings({ fontSize: settings.fontSize - 1 });
    } else if (ctrl && key === "0") {
      e.preventDefault();
      resetSettings();
    } else if (e.altKey && key === "arrowleft") {
      e.preventDefault();
      guardedGoBack();
    } else if (e.altKey && key === "arrowright") {
      e.preventDefault();
      guardedGoForward();
    } else if (e.altKey && key === "arrowup" && !ctrl && !e.shiftKey) {
      e.preventDefault();
      navigateScene(-1);
    } else if (e.altKey && key === "arrowdown" && !ctrl && !e.shiftKey) {
      e.preventDefault();
      navigateScene(1);
    } else if (e.key === "?" && !ctrl && !e.altKey) {
      e.preventDefault();
      setShortcutsVisible((v) => !v);
    } else if (key === "f5") {
      e.preventDefault();
      if (isDocumentOpen(content) && !editing && !focusMode && fileType !== "fountain") {
        enterPresentation();
      }
    }
  };

  useEffect(() => {
    const stableKeyDownHandler = (e: KeyboardEvent) => keyDownHandlerRef.current(e);
    window.addEventListener("keydown", stableKeyDownHandler);
    return () => window.removeEventListener("keydown", stableKeyDownHandler);
  }, []);

  // Toggle print attributes on body + app root to isolate print rendering from app chrome.
  useEffect(() => {
    const beforePrint = () => {
      setPrintAttributes(true);
      setPrinting(true);
      armPrintCleanup();
    };
    const afterPrint = () => clearPrintSession();
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      clearPrintSession();
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, [armPrintCleanup, clearPrintSession, setPrintAttributes]);

  // Signal app readiness once session restore and recent files are loaded
  const appReady = sessionRestored && recentFilesLoaded;
  useEffect(() => {
    if (appReady) signalAppReady();
  }, [appReady]);

  // Suppress render while startup state is settling — loading screen covers #root
  if (!appReady) return null;

  return (
    <div
      ref={appRootRef}
      className={`h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden ${settings.reducedEffects ? "reduced-effects" : ""}`}
      style={
        {
          "--header-height": `${HEADER_HEIGHT_PX}px`,
          "--heading-scroll-margin": `${HEADING_SCROLL_MARGIN_PX}px`,
        } as CSSProperties
      }
    >
      {!focusMode && !printing && !presentationMode && (
        <Header
          fileName={fileName}
          filePath={filePath}
          theme={theme}
          onCycleTheme={cycleTheme}
          onNewFile={guardedNewFile}
          onOpenFile={guardedOpenFile}
          onToggleSidebar={toggleSidebar}
          onToggleToc={toggleToc}
          onToggleReaderControls={toggleReaderControls}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={guardedGoBack}
          onGoForward={guardedGoForward}
          isEditing={editing}
          isDirty={editor.dirty}
          isSavedFlash={savedFlash}
          saveWarning={saveWarning}
          canSave={!actionAdmissionInFlight && editing && (editor.dirty || !filePath)}
          canToggleEdit={canToggleEdit}
          onToggleEdit={toggleEditMode}
          onSave={handleSave}
          canRestoreSnapshot={!actionAdmissionInFlight && Boolean(filePath || snapshotDocument)}
          onRestoreSnapshot={openDocumentSnapshotRestore}
          statsSummary={statsSummary}
          progressTextRef={progressTextRef}
          onToggleAnnotations={toggleAnnotationsPanel}
          hasAnnotations={highlights.length > 0 || bookmarks.length > 0}
          onPrint={handlePrint}
          onPresent={enterPresentation}
          canPresent={canPresent}
          fileType={fileType}
          markdownFormattingEnabled={markdownFormattingEnabled}
          onToggleMarkdownFormatting={markdownFormatting.toggle}
        />
      )}

      {isDocumentOpen(content) && !focusMode && !printing && !presentationMode && (
        <div className="print-hide h-[2px] bg-bg-secondary shrink-0">
          <div
            ref={progressBarRef}
            className="h-full bg-accent origin-left"
            style={{
              transform: "scaleX(0)",
              transition: settings.reducedEffects ? "none" : "transform 80ms linear",
            }}
          />
        </div>
      )}

      <div className="flex flex-1 min-h-0 relative">
        <Sidebar
          visible={sidebarVisible && !focusMode && !presentationMode}
          recentFiles={recentFiles}
          currentFilePath={filePath}
          openingPath={openingPath}
          workspaceRootPath={workspaceRoot.rootPath}
          workspaceState={workspaceIndex.state}
          backlinks={workspaceInsights.backlinks}
          mentions={workspaceInsights.mentions}
          onOpenRecent={guardedOpenRecent}
          onRemoveRecent={removeRecent}
          onChooseWorkspaceRoot={workspaceRoot.chooseRoot}
          onClearWorkspaceRoot={workspaceRoot.clearRoot}
          onReindexWorkspace={workspaceIndex.reindex}
          onOpenWorkspacePath={openWorkspacePath}
          onOpenCommandPalette={openCommandPalette}
        />

        {/* Reading surface */}
        <main
          ref={mainScrollRef}
          className="flex-1 overflow-y-auto reading-surface bg-bg-primary min-w-0 relative"
        >
          {!editing && (
            <SearchBar
              visible={searchVisible}
              query={search.query}
              matchCount={search.matchCount}
              currentIndex={search.currentIndex}
              onQueryChange={search.setQuery}
              onNext={search.next}
              onPrevious={search.previous}
              onClose={closeSearch}
            />
          )}

          {loading && (
            <div className="max-w-[65ch] mx-auto px-6 pt-6 text-sm text-text-muted">
              Opening file...
            </div>
          )}

          {error && <ErrorBanner error={error} onDismiss={dismissError} />}

          {isDocumentOpen(content) && editing && editor.buffer !== null ? (
            <MarkdownEditor
              key={`${editorSessionKey}:${fileType}`}
              ref={editorSurfaceRef}
              buffer={editor.buffer}
              initialPosition={editorInitialPosition}
              scrollRootRef={mainScrollRef}
              fileType={fileType}
              markdownFormattingEnabled={markdownFormattingEnabled}
              settings={settings}
              saveError={editor.saveError}
              canSaveAsAfterError={editor.saveErrorRecovery === "save-as"}
              onBufferChange={publishEditorBuffer}
              onSaveAsAfterError={handleSaveAsAfterError}
              onDismissSaveError={editor.dismissSaveError}
            />
          ) : preparedDocument?.status === "too-complex" ? (
            <DocumentComplexityNotice
              contentRef={contentRef}
              message={preparedDocument.message}
            />
          ) : preparedDocument?.status === "ready" && preparedDocument.format === "fountain" ? (
            <FountainRenderer
              parsed={preparedDocument.parsedFountain}
              settings={settings}
              contentRef={contentRef}
              focusedCharacter={focusedCharacter}
            />
          ) : isDocumentOpen(content) && preparedDocument?.status === "ready" ? (
            <MarkdownRenderer
              content={content}
              filePath={filePath || ""}
              settings={settings}
              contentRef={contentRef}
              onOpenFragment={openMarkdownFragment}
              onNavigateToFile={guardedNavigateToFile}
            />
          ) : (
            <EmptyState
              onNewFile={guardedNewFile}
              onOpenFile={guardedOpenFile}
              recentFiles={recentFiles}
              onOpenRecent={guardedOpenRecent}
              onRestoreDrafts={openDraftSnapshotRestore}
              canRestoreDrafts={!actionAdmissionInFlight}
            />
          )}
        </main>

        <ReaderNavigation
          ref={readerNavigationRef}
          visible={tocVisible && !focusMode && !editing && !presentationMode}
          headings={headings}
          scrollRootRef={mainScrollRef}
          syncIntervalMs={tocVisible && !focusMode ? 100 : 250}
          useIntersectionObserver={tocVisible && !focusMode}
          onActiveHeadingChange={handleActiveHeadingChange}
          scenes={sceneItems}
          sceneStatsByHeadingId={sceneStatsByHeadingId}
          characters={characters}
          scriptCharacters={fileType === "fountain" ? scriptStats?.characters ?? [] : []}
          focusedCharacter={focusedCharacter}
          onToggleCharacterFocus={handleToggleCharacterFocus}
          isBookmarked={isBookmarked}
          onToggleBookmark={annotationsReady ? toggleBookmark : undefined}
          onOpenHeading={scrollToHeading}
          onOpenScene={openScene}
        />

        <AnnotationsPanel
          visible={annotationsPanelVisible && !focusMode && !editing && !presentationMode}
          annotationStatus={annotationStatus}
          annotationsReady={annotationsReady}
          loadError={annotationLoadError}
          saveError={annotationSaveError}
          canRetrySave={canRetryAnnotationSave}
          highlights={highlights}
          bookmarks={bookmarks}
          onRetryLoad={retryAnnotationLoad}
          onRetrySave={retryAnnotationSave}
          onRemoveHighlight={removeHighlight}
          onUpdateHighlight={updateHighlight}
          onClickHighlight={handleClickHighlight}
          onClickBookmark={handleClickBookmark}
          onClose={closeAnnotationsPanel}
          fileName={fileName}
          headings={headings}
        />

        {!focusMode && !presentationMode && (
          <ReaderControls
            visible={readerControlsVisible}
            settings={settings}
            theme={theme}
            fileType={fileType}
            onSetTheme={setTheme}
            onUpdate={updateSettings}
            onReset={resetSettings}
            recoveryStorageStats={recoveryStorageStats}
            recoveryStorageStatsLoading={recoveryStorageStatsLoading}
            recoveryStorageStatsError={recoveryStorageStatsError}
            onClearRecoveryHistory={requestClearRecoveryHistory}
            onClose={closeReaderControls}
          />
        )}
      </div>

      {!editing && readerDocumentReady && annotationsReady && isDocumentOpen(content) && !presentationMode && (
        <HighlightToolbar
          contentRef={contentRef}
          isEditing={editing}
          getActiveHeadingId={getActiveHeadingId}
          onHighlight={handleHighlight}
        />
      )}
      {focusMode && (
        <FocusBar
          fileName={fileName}
          isDirty={editor.dirty}
          isSavedFlash={savedFlash}
          saveWarning={saveWarning}
          onExit={exitFocusMode}
          statsSummary={statsSummary}
          progressTextRef={progressTextRef}
          reducedEffects={settings.reducedEffects}
          showMarkdownFormatting={editing && fileType === "markdown"}
          markdownFormattingEnabled={markdownFormattingEnabled}
          onToggleMarkdownFormatting={markdownFormatting.toggle}
        />
      )}
      {focusedCharacter && parsedFountain && fileType === "fountain" && !focusMode && !presentationMode && (
        <div
          role="status"
          className="print-hide fixed bottom-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-full bg-bg-secondary border border-border shadow-lg select-none"
        >
          <span className="text-sm text-accent font-medium truncate max-w-[200px]">
            {focusedCharacter}
          </span>
          <button
            type="button"
            onClick={() => setFocusedCharacter(null)}
            className="text-xs text-text-secondary hover:text-text-primary cursor-pointer transition-colors duration-120"
            title={`Exit character focus (${formatShortcutLabel("escape")})`}
            aria-label="Exit character focus"
          >
            Exit
          </button>
        </div>
      )}
      {presentationMode && (
        <PresentationView
          slides={slidesRef.current}
          currentSlide={currentSlide}
          settings={settings}
          filePath={filePath || ""}
          onExit={exitPresentation}
          onNext={nextSlide}
          onPrev={prevSlide}
          onNavigateToFile={guardedNavigateToFile}
        />
      )}
      <DropZone visible={isDragging} />
      <ShortcutOverlay visible={shortcutsVisible} onClose={closeShortcuts} />
      <CommandPalette
        visible={commandPaletteVisible}
        query={workspaceSearch.query}
        results={workspaceSearch.results}
        selectedIndex={workspaceSearch.selectedIndex}
        status={workspaceIndex.state.status}
        onQueryChange={workspaceSearch.setQuery}
        onClose={closeCommandPalette}
        onOpenHit={openWorkspaceHit}
        onHoverIndex={workspaceSearch.setSelectedIndex}
      />
      <ConfirmDialog
        visible={showConfirmDialog}
        title="Unsaved changes"
        message={`You have unsaved changes to ${fileName || "this file"}.`}
        confirmLabel="Save"
        cancelLabel="Discard"
        onConfirm={handleConfirmSave}
        onCancel={handleConfirmDiscard}
        onDismiss={handleConfirmCancel}
      />
      <ConfirmDialog
        visible={showConflictDialog}
        title="File changed on disk"
        message={`"${fileName || "This file"}" was modified outside Bindars while you were editing.`}
        confirmLabel="Reload"
        initialFocus="cancel"
        secondaryLabel="Overwrite"
        secondaryTone="danger"
        cancelLabel="Cancel"
        onConfirm={handleConflictReload}
        onSecondary={handleConflictOverwrite}
        onCancel={handleConflictCancel}
        onDismiss={handleConflictCancel}
      />
      <ConfirmDialog
        visible={showClearRecoveryDialog}
        title="Clear recovery history"
        message="This permanently deletes Bindars' recovery snapshots for all documents on this device. Your original files are not touched. If you keep editing, new recovery snapshots will be created."
        confirmLabel="Delete history"
        cancelLabel="Cancel"
        initialFocus="cancel"
        onConfirm={confirmClearRecoveryHistory}
        onCancel={cancelClearRecoveryHistory}
        onDismiss={cancelClearRecoveryHistory}
      />
      <SnapshotRestoreDialog
        visible={restoreDialog !== null}
        title={restoreDialog?.kind === "drafts" ? "Restore an unsaved draft" : "Restore snapshot"}
        loading={restoreDialog?.loading ?? false}
        error={restoreDialog?.error ?? null}
        emptyMessage={restoreDialog?.kind === "drafts"
          ? "No unsaved draft snapshots were found."
          : "No snapshots have been captured for this document yet."}
        choices={restoreChoices}
        restoringId={restoringSnapshotId}
        onRestore={handleRestoreChoice}
        onDismiss={closeRestoreDialog}
      />
    </div>
  );
}

export default App;
