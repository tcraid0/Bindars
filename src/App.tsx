import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, useId } from "react";
import { flushSync } from "react-dom";
import type { CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, homeDir } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { ReaderNavigation } from "./components/ReaderNavigation";
import type { ReaderNavigationHandle } from "./components/ReaderNavigation";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner } from "./components/ErrorBanner";
import { DocumentNotice } from "./components/DocumentNotice";
import { DOCUMENT_COMPLEXITY_REASON } from "./lib/document-complexity";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { ReaderControls } from "./components/ReaderControls";
import { DropZone } from "./components/DropZone";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { FocusBar } from "./components/FocusBar";
import { SearchBar } from "./components/SearchBar";
import { FountainRenderer } from "./components/FountainRenderer";
import { computeScriptStats, isMarkdownSceneHeadingText } from "./lib/fountain";
import { MarkdownEditor } from "./components/MarkdownEditor";
import type { MarkdownEditorHandle } from "./components/MarkdownEditor";
import { AnnotationExitDialog } from "./components/AnnotationExitDialog";
import { useAnnotationExit } from "./hooks/useAnnotationExit";
import { ConfirmDialog } from "./components/ConfirmDialog";
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
import type { OpenFilePathResult } from "./hooks/useMarkdownFile";
import { useDocumentReconciliation } from "./hooks/useDocumentReconciliation";
import type { ReconciliationSignal } from "./hooks/useDocumentReconciliation";
import { useReconciliationLifecycle } from "./hooks/useReconciliationLifecycle";
import { useHeadings } from "./hooks/useHeadings";
import { useDragDrop } from "./hooks/useDragDrop";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { useSessionRestore } from "./hooks/useSessionRestore";
import { useNativeOpen } from "./hooks/useNativeOpen";
import { useNativeQuit } from "./hooks/useNativeQuit";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { useSearch } from "./hooks/useSearch";
import { useFileWatcher } from "./hooks/useFileWatcher";
import type { WatcherUnavailableReason } from "./hooks/useFileWatcher";
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
import { adoptsWrittenDestination, decideSaveContinuation, isSuccessfulSave } from "./lib/editor-save";
import type { EditorSaveResult } from "./lib/editor-save";
import { normalizeFileError } from "./lib/native-file-error";
import { isDocumentOpen } from "./lib/document-state";
import type {
  ReconciliationDecision,
  ReconciliationProbeResult,
  ReconciliationSnapshot,
} from "./lib/document-reconciliation";
import { probeDocumentForReconciliation } from "./lib/document-reconciliation-probe";
import { canEnterEditMode, canEnterPresentationMode, canToggleEditMode, decideNativeCloseRequest, windowClosePolicy } from "./lib/app-flow";
import type { PendingAction, RetryablePendingAction } from "./lib/app-flow";
import { formatReadingStatsSummary } from "./lib/reading-stats";
import { prepareReaderDocument } from "./lib/document-processing";
import { resolveAnchor, prepareAnnotationDocument, wrapRange, clearAnnotationHighlights } from "./lib/text-anchoring";
import { createPrintCleanupController, preparePrintDocument } from "./lib/print-export";
import { hasNativePrintCompletion, invokePrint } from "./lib/print-invocation";
import { useToast } from "./components/ToastProvider";
import { initializeAnnotationStorage } from "./lib/annotation-storage";
import { storeGet, storeSet } from "./lib/store";
import { signalAppReady, STARTUP_TIMEOUT_MS } from "./lib/app-ready";
import {
  captureReaderAnchor,
  findFragmentElement,
  findHeadingElement,
  restoreReaderAnchor,
} from "./lib/editor-position";
import type { ReaderAnchor, SourcePoint } from "./lib/editor-position";
import { isImeCompositionKey } from "./lib/keyboard";
import { formatShortcutLabel, renderShortcutTemplate, detectShortcutPlatform } from "./lib/shortcut-labels";
import type { TextAnchor } from "./lib/text-anchoring";
import type { FileRevision, HighlightColor, SceneItem, ScriptSceneStats, WorkspaceSearchHit } from "./types";
import welcomeTemplate from "./assets/welcome.md?raw";

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

interface SaveCurrentEditsOptions {
  forceOverwrite?: boolean;
  quiet?: boolean;
  saveAs?: boolean;
}

function sameSourcePoint(left: SourcePoint, right: SourcePoint): boolean {
  return left.line === right.line && left.column === right.column;
}

function App() {
  const [printPhase, setPrintPhase] = useState<"preparing" | "printing" | null>(null);
  const printSessionRef = useRef<{ invoked: boolean; nativePending: boolean } | null>(null);
  const printMountedRef = useRef(true);
  const printDisposeRef = useRef<(() => void) | null>(null);
  const isPrintInvoked = useCallback(() => Boolean(printSessionRef.current?.invoked), []);
  const printPause = { paused: printPhase === "printing", isPaused: isPrintInvoked };
  const { theme, setTheme, cycleTheme } = useTheme(printPause);
  const { settings, updateSettings, resetSettings } = useReaderSettings(printPause);
  const markdownFormatting = useMarkdownFormatting();
  const markdownFormattingEnabled = markdownFormatting.loaded && markdownFormatting.enabled;
  const {
    content,
    filePath,
    fileName,
    fileRevision,
    fileType,
    imageDocumentPath,
    error,
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
  } = useMarkdownFile();
  // Virtual drafts have no folder to authorize; a file waits for the native
  // acceptance of exactly the published path.
  const imagesAuthorized = filePath === null || imageDocumentPath === filePath;
  const { recentFiles, status: recentFilesStatus, addRecent, removeRecent, updateScrollPosition, getScrollPosition } = useRecentFiles();
  const { canGoBack, canGoForward, pushEntry, peekBack, commitBack, peekForward, commitForward } =
    useNavigationHistory();
  const workspaceRoot = useWorkspaceRoot();
  const workspaceIndex = useWorkspaceIndex(workspaceRoot.rootPath);
  const workspaceSearch = useWorkspaceSearch({ docs: workspaceIndex.docs, recentFiles });
  const workspaceInsights = useWorkspaceInsights(workspaceIndex.docs, filePath);

  const editorSurfaceRef = useRef<MarkdownEditorHandle | null>(null);
  const flushPendingBuffer = useCallback(() => {
    return editorSurfaceRef.current?.flushPendingChanges() ?? null;
  }, []);
  const editor = useEditor(flushPendingBuffer);
  const publishEditorBuffer = editor.updateBuffer;
  const flushAndReadDirty = useCallback(() => {
    return editor.captureSnapshotBuffer()?.dirty ?? false;
  }, [editor.captureSnapshotBuffer]);
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
    removeBookmark,
    restoreRecord: restoreAnnotationRecord,
    dataWarning: annotationDataWarning,
    saving: annotationsSaving,
    waitForSaves: waitForAnnotationSaves,
    pendingRecords: pendingAnnotationRecords,
    recordState: annotationRecordState,
    setLocked: setAnnotationsLocked,
    getMutationVersion: getAnnotationMutationVersion,
    retryLoad: retryAnnotationLoad,
    retrySave: retryAnnotationSave,
  } = useAnnotations(filePath);

  const annotationExit = useAnnotationExit(pendingAnnotationRecords, waitForAnnotationSaves, retryAnnotationSave);

  useEffect(() => {
    let active = true;
    void initializeAnnotationStorage().then((status) => {
      if (active && !status.settingsReady) toast("Settings storage is unavailable. Existing data was preserved; preference changes cannot be saved.", "error");
    }).catch(() => {
      if (active) toast("Annotation storage could not be initialized. Existing data was preserved. Retry from Highlights & notes.", "error");
    });
    return () => { active = false; };
  }, [toast]);

  const [sidebarVisible, setSidebarVisible] = useState(() => {
    try {
      return localStorage.getItem("bindars-sidebar-visible") === "true";
    } catch {
      return false;
    }
  });
  const sidebarUpdatedRef = useRef(false);
  const [startupTimedOut, setStartupTimedOut] = useState(false);
  const [annotationsPanelVisible, setAnnotationsPanelVisible] = useState(false);
  const flushAnnotationNoteRef = useRef<(() => void) | null>(null);
  const startNoteRef = useRef<((id: string) => void) | null>(null);
  const pendingNoteScrollRef = useRef<{ id: string; path: string | null; content: string | null } | null>(null);
  const [annotationLocations, setAnnotationLocations] = useState<Record<string, string>>({});
  const [tocVisible, setTocVisible] = useState(true);
  const [readerControlsVisible, setReaderControlsVisible] = useState(false);
  const readerControlsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const readerControlsId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const [shortcutsVisible, setShortcutsVisible] = useState(false);
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [currentFileIsDraft, setCurrentFileIsDraft] = useState(false);
  const [editorSessionKey, setEditorSessionKey] = useState(0);
  const [editorInitialPosition, setEditorInitialPosition] = useState<SourcePoint | null>(null);
  const [pendingReaderTarget, setPendingReaderTarget] = useState<PendingReaderTarget | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const printing = printPhase !== null;
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
    storeGet<unknown>("sidebar-visible").then((stored) => {
      if (!active || sidebarUpdatedRef.current || typeof stored !== "boolean") return;
      setSidebarVisible(stored);
    });
    return () => { active = false; };
  }, []);

  // Pending action to run after confirm dialog resolves.
  const pendingActionRef = useRef<AdmittedAction | null>(null);
  // Each dialog owns its continuation, even if a later dialog has the same intent.
  const saveContinuationRef = useRef<{ intent: SaveContinuationIntent } | null>(null);
  const executePendingActionRef = useRef<(action: PendingAction, annotationVersion: number) => Promise<void>>(async () => {});
  const actionAdmissionOwnerRef = useRef<ActionAdmissionId | null>(null);
  const documentTransitionInFlightRef = useRef(false);
  const nextActionAdmissionIdRef = useRef(0);
  const startupRestoreSupersededRef = useRef(false);
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mainScrollRef = useRef<HTMLElement | null>(null);
  const readerFocusRequestRef = useRef<{
    documentKey: string | null;
    editorSessionKey: number;
    openGeneration: number;
    actionId: number;
    searchVisible: boolean;
  } | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const readerNavigationRef = useRef<ReaderNavigationHandle | null>(null);
  const activeHeadingIdRef = useRef<string | null>(null);
  const currentPositionRef = useRef<{ filePath: string | null; headingId: string | null }>({
    filePath: null,
    headingId: null,
  });
  // These mirrors support async App flows after React publishes a render.
  const currentFilePathRef = useRef(filePath);
  const currentFileIsDraftRef = useRef(currentFileIsDraft);
  const draftClassificationRef = useRef<{ path: string; promise: Promise<boolean> } | null>(null);
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
  const pendingExitReconciliationRef = useRef<PendingExitReconciliation | null>(null);
  const showConfirmDialogRef = useRef(showConfirmDialog);
  const showConflictDialogRef = useRef(showConflictDialog);
  const boundaryFlushInFlightRef = useRef(false);
  const flushBeforeContinuationRef = useRef<() => void>(() => {});
  const programmaticCloseRef = useRef<{ annotationVersion: number } | null>(null);
  const printCleanupControllerRef = useRef<ReturnType<typeof createPrintCleanupController> | null>(null);
  currentFilePathRef.current = filePath;
  currentFileIsDraftRef.current = currentFileIsDraft;
  loadedContentRef.current = content;
  currentPositionRef.current = {
    filePath,
    headingId: activeHeadingIdRef.current,
  };

  useEffect(() => {
    let active = true;
    currentFileIsDraftRef.current = false;
    setCurrentFileIsDraft(false);
    draftClassificationRef.current = null;
    if (!filePath) return;
    const promise = invoke<boolean>("is_draft_document", { path: filePath }).catch(() => false);
    draftClassificationRef.current = { path: filePath, promise };
    void promise.then((isDraft) => {
      if (!active || currentFilePathRef.current !== filePath) return;
      draftClassificationRef.current = null;
      currentFileIsDraftRef.current = isDraft;
      setCurrentFileIsDraft(isDraft);
    });
    return () => { active = false; };
  }, [filePath]);

  const handleCancelPendingOpen = useCallback(() => {
    cancelPendingOpen();
    mainScrollRef.current?.focus({ preventScroll: true });
    toast("Opening canceled.", "info");
  }, [cancelPendingOpen, toast]);

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

  const requestReaderFocus = useCallback((retainedSearchVisible = false) => {
    const path = getPublishedDocument().filePath;
    readerFocusRequestRef.current = {
      documentKey: path ? toPathIdentityKey(path) : null,
      editorSessionKey: editorSessionKeyRef.current,
      openGeneration: getOpenOwnership().generation,
      actionId: nextActionAdmissionIdRef.current,
      searchVisible: retainedSearchVisible,
    };
  }, [getOpenOwnership, getPublishedDocument]);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    search.clear();
    if (!editingRef.current) requestReaderFocus();
  }, [requestReaderFocus, search.clear]);

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
    saveContinuationRef.current = { intent };
    showConfirmDialogRef.current = true;
    setShowConfirmDialog(true);
  }, []);

  const openConflictDialog = useCallback((intent: SaveContinuationIntent) => {
    saveContinuationRef.current = { intent };
    showConflictDialogRef.current = true;
    setShowConflictDialog(true);
  }, []);

  const clearPrintSession = useCallback(() => {
    if (printSessionRef.current?.nativePending || window.matchMedia?.("print").matches) return false;
    printSessionRef.current = null;
    printCleanupControllerRef.current?.disarm();
    if (printMountedRef.current) setPrintPhase(null);
    document.body.removeAttribute("data-printing");
    printDisposeRef.current?.();
    printDisposeRef.current = null;
    return true;
  }, []);

  const armPrintCleanup = useCallback(() => {
    if (!printCleanupControllerRef.current) {
      printCleanupControllerRef.current = createPrintCleanupController(clearPrintSession);
    }
    printCleanupControllerRef.current.arm();
  }, [clearPrintSession]);

  const handlePrint = useCallback(async () => {
    const root = contentRef.current;
    // Images are not in the DOM until authorized, so preparation would print
    // without them; refuse like any other in-flight transition.
    if (printSessionRef.current || !root || !isDocumentOpen(content)
      || editing || loading || presentationMode || documentTransitionInFlight
      || !imagesAuthorized) return;

    const session = { invoked: false, nativePending: false };
    printSessionRef.current = session;
    document.body.setAttribute("data-printing", "true");
    setPrintPhase("preparing");
    armPrintCleanup();

    try {
      await preparePrintDocument({ root });
      // Preparation belongs to this exact reader, even if a later operation
      // has already published a new document or entered the editor.
      if (printSessionRef.current !== session) return;
      if (contentRef.current !== root || !root.isConnected || editingRef.current
        || loadedContentRef.current !== content || currentFilePathRef.current !== filePath) {
        clearPrintSession();
        return;
      }
      const nativeCompletion = hasNativePrintCompletion();
      session.invoked = true;
      session.nativePending = nativeCompletion;
      flushSync(() => setPrintPhase("printing"));
      armPrintCleanup();
      await invokePrint(nativeCompletion);
      if (printSessionRef.current !== session) return;
      session.nativePending = false;
      if (nativeCompletion) printCleanupControllerRef.current?.check();
    } catch (err) {
      if (printSessionRef.current !== session) return;
      session.nativePending = false;
      console.warn("[print] Failed to print document:", err);
      printCleanupControllerRef.current?.check();
      if (printMountedRef.current) toast("Couldn't print document. Please try again.", "error");
    }
  }, [armPrintCleanup, clearPrintSession, content, filePath, editing, loading,
    presentationMode, documentTransitionInFlight, imagesAuthorized, toast]);

  // Invalidate pending preparation before a changed reader can be printed.
  useLayoutEffect(() => {
    if (!printSessionRef.current?.invoked) clearPrintSession();
  }, [content, filePath, fileType, editing, loading, presentationMode, documentTransitionInFlight, settings, theme, clearPrintSession]);

  const saveCurrentEdits = useCallback(async (
    options: SaveCurrentEditsOptions = {},
  ): Promise<EditorSaveResult> => {
    const result = filePath && !options.saveAs
      ? await editor.save(filePath, {
        force: options.forceOverwrite ?? false,
        quiet: options.quiet ?? false,
      })
      : !filePath && options.quiet
        ? await editor.createDraft()
        : await editor.saveAs(fileName || "Untitled.md", filePath);
    if (adoptsWrittenDestination(result)) {
      editingFilePathRef.current = result.file.canonicalPath;
      adoptSavedFile(result.file);
    }

    return result.status;
  }, [adoptSavedFile, editor.createDraft, editor.save, editor.saveAs, fileName, filePath]);

  const performAutosave = useCallback(async () => {
    const result = await saveCurrentEdits({ quiet: true });
    if (isSuccessfulSave(result)) flashSaved();
    return result;
  }, [flashSaved, saveCurrentEdits]);

  const editorPersistenceActive = editing
    && !showConfirmDialog
    && !showConflictDialog;

  const {
    autosaveIssue,
    flushAutosave,
    cancelAutosaveAndWait,
    clearAutosaveIssue,
    recordSaveResult,
    rearmAutosave,
  } = usePersistenceCoordinator({
    autosaveActive: editorPersistenceActive
      && editor.externalChange === null
      && editor.recoveryPath === null
      && !editor.savePathBlocked,
    dirty: editor.dirty,
    sessionKey: editorSessionKey,
    documentIdentity: documentOpen ? filePath ?? "new" : null,
    captureBuffer: editor.captureSnapshotBuffer,
    bufferVersion: editor.buffer,
    onAutosave: performAutosave,
  });
  let saveWarning = autosaveIssue?.message ?? null;
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
      guardedActionInFlight: actionAdmissionOwnerRef.current !== null || isPrintInvoked(),
    };

    if (!editingRef.current) {
      return {
        ...common,
        sessionId: ownership.generation,
        mode: "reader",
        content: published.content,
        dirty: false,
        expectedRevision: null,
        saveInFlight: false,
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
      saveInFlight: editorState.saveInFlight,
    };
  }, [editor.getReconciliationState, getOpenOwnership, getPublishedDocument]);

  const probeForReconciliation = useCallback(async (
    snapshot: ReconciliationSnapshot,
  ): Promise<ReconciliationProbeResult> => {
    return probeDocumentForReconciliation(snapshot.filePath);
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
      case "recover-unavailable":
        reportReconciliationError(decision.error);
        break;
      case "stale-noop":
        return;
    }

    if (signal === "editor-exit") pendingExitReconciliationRef.current = null;
  }, [
    adoptReconciledDocument,
    clearReconciliationError,
    editor.refreshDirtyExpectedRevision,
    editor.refreshCleanExpectedRevision,
    editor.refreshCleanBuffer,
    editor.protectFromExternalChange,
    refreshReconciledRevision,
    reportReconciliationError,
  ]);

  const {
    scheduleReconciliation,
    requestReconciliation,
    resumeDeferredReconciliation,
    supersedeReconciliation,
  } = useDocumentReconciliation({
    presentationActive: presentationMode,
    getSnapshot: getReconciliationSnapshot,
    probe: probeForReconciliation,
    applyDecision: applyReconciliationDecision,
  });

  useEffect(() => {
    if (printPhase === null && !editor.saving) resumeDeferredReconciliation();
  }, [printPhase, editor.saving, resumeDeferredReconciliation]);

  // An awaited step can outlast the editor session that requested it: the
  // document may have been swapped and a new session begun. Callers holding a
  // file path in their closure must recheck before acting on that path.
  const editorSessionIsCurrent = useCallback((sessionKey: number) =>
    editingRef.current && editorSessionKeyRef.current === sessionKey, []);

  const saveCurrentEditsForSession = useCallback(async (
    options: SaveCurrentEditsOptions = {},
  ): Promise<EditorSaveResult> => {
    const sessionKey = editorSessionKeyRef.current;
    const result = await saveCurrentEdits(options);
    if (!editorSessionIsCurrent(sessionKey)) return "stale";
    // Flush edits that arrived while the write resolved before a caller
    // treats the saved text as permission to leave.
    if (result === "saved" && flushAndReadDirty()) return "saved-with-newer-edits";
    return result;
  }, [editorSessionIsCurrent, flushAndReadDirty, saveCurrentEdits]);

  const retireDraft = useCallback(async (draftPath: string | null) => {
    const savedPath = getPublishedDocument().filePath;
    if (!draftPath || !savedPath) return;
    // Annotations belong to the draft's path. Deleting an annotated draft would
    // hide its notes and let the next draft with that name inherit them.
    if (toPathIdentityKey(draftPath) !== toPathIdentityKey(savedPath)) {
      const annotations = annotationRecordState(draftPath);
      if (annotations !== "empty") {
        const name = draftPath.split(/[\\/]/).pop() || draftPath;
        toast(annotations === "annotated"
          ? `Your highlights, notes, and bookmarks remain in the kept draft ${name}.`
          : `Bindars kept the draft ${name} because it couldn't confirm whether it has highlights, notes, or bookmarks.`, "info");
        return;
      }
    }
    try {
      const removed = await invoke<boolean>("delete_draft_document", { path: draftPath, savedPath });
      if (removed) removeRecent(draftPath);
    } catch (error) {
      console.warn("[drafts] Saved the document but could not remove its old draft:", error);
    }
  }, [annotationRecordState, getPublishedDocument, removeRecent, toast]);

  const handleSave = useCallback(async () => {
    if (actionAdmissionOwnerRef.current !== null) return;
    let draftPath = currentFileIsDraftRef.current ? filePath : null;
    const sessionKey = editorSessionKeyRef.current;
    try {
      const pendingIssue = await cancelAutosaveAndWait();
      // Waiting on the autosave can outlast this session (undo to clean, open
      // another file, start editing it). This closure's file path belongs to
      // the old session, so a superseded Save must not run against it.
      if (!editorSessionIsCurrent(sessionKey) || actionAdmissionOwnerRef.current !== null) return;
      const pathAfterAutosave = getPublishedDocument().filePath;
      if (filePath && pathAfterAutosave !== filePath) return;
      // Handle pending classification, the first draft published before its
      // effect ran, or an already resolved flag. Ordinary saves reuse the
      // existing classification; only the first-draft gap needs a new lookup.
      if (pathAfterAutosave && !draftPath) {
        const classification = draftClassificationRef.current;
        if (classification?.path === pathAfterAutosave) {
          if (await classification.promise) draftPath = pathAfterAutosave;
        } else if (!filePath) {
          // Autosave may publish the first draft before its classification effect runs.
          try {
            if (await invoke<boolean>("is_draft_document", { path: pathAfterAutosave })) {
              draftPath = pathAfterAutosave;
            }
          } catch {
            // A failed lookup keeps the ordinary save behavior available.
          }
        } else if (currentFilePathRef.current === pathAfterAutosave && currentFileIsDraftRef.current) {
          draftPath = pathAfterAutosave;
        }
        if (!editorSessionIsCurrent(sessionKey) || actionAdmissionOwnerRef.current !== null) return;
        if (getPublishedDocument().filePath !== pathAfterAutosave) return;
      }
      if (pendingIssue?.kind === "conflict") {
        openConflictDialog("stay-editing");
        return;
      }
      clearAutosaveIssue();
      if (filePath && !draftPath && !flushAndReadDirty()) {
        flashSaved();
        return;
      }

      const result = await saveCurrentEditsForSession({ saveAs: draftPath !== null });
      const failedDraftSaveAs = draftPath !== null && (result === "error" || result === "conflict");
      if (!failedDraftSaveAs) recordSaveResult(result);
      if (result === "conflict" && !failedDraftSaveAs) {
        openConflictDialog("stay-editing");
      }
      if (result !== "saved-with-recovery" && !isSuccessfulSave(result)) return;
      if (isSuccessfulSave(result)) {
        clearAutosaveIssue();
        flashSaved();
      }
      await retireDraft(draftPath);
    } finally {
      rearmAutosave();
    }
  }, [cancelAutosaveAndWait, clearAutosaveIssue, editorSessionIsCurrent, filePath, flashSaved, flushAndReadDirty, getPublishedDocument, openConflictDialog, rearmAutosave, recordSaveResult, retireDraft, saveCurrentEditsForSession]);

  const handleSaveAsAfterError = useCallback(async () => {
    if (actionAdmissionOwnerRef.current !== null) return;
    const draftPath = currentFileIsDraftRef.current ? filePath : null;
    const sessionKey = editorSessionKeyRef.current;
    try {
      await cancelAutosaveAndWait();
      if (!editorSessionIsCurrent(sessionKey) || actionAdmissionOwnerRef.current !== null) return;

      const result = await saveCurrentEditsForSession({ saveAs: true });
      const failedDraftSaveAs = draftPath !== null && (result === "error" || result === "conflict");
      if (!failedDraftSaveAs) recordSaveResult(result);
      if (result !== "saved-with-recovery" && !isSuccessfulSave(result)) return;
      if (isSuccessfulSave(result)) {
        clearAutosaveIssue();
        flashSaved();
      }
      await retireDraft(draftPath);
    } finally {
      rearmAutosave();
    }
  }, [cancelAutosaveAndWait, clearAutosaveIssue, editorSessionIsCurrent, filePath, flashSaved, rearmAutosave, recordSaveResult, retireDraft, saveCurrentEditsForSession]);

  const beginEditSession = useCallback((
    initialContent: string,
    revision: FileRevision | null,
    path: string | null,
    readerAnchor: ReaderAnchor | null = null,
  ) => {
    pendingNoteScrollRef.current = null;
    supersedeReconciliation();
    pendingExitReconciliationRef.current = null;
    supersedePendingOpen();
    const nextSessionKey = editorSessionKeyRef.current + 1;
    editorSessionKeyRef.current = nextSessionKey;
    const initialEditorTarget = readerAnchor?.source ?? { line: 1, column: 1 };
    editor.enterEditMode(initialContent, revision);
    editingFilePathRef.current = path;
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
    showConflictDialogRef.current = false;
    setShowConflictDialog(false);
    saveContinuationRef.current = null;
    setSavedFlash(false);
    if (searchVisible) closeSearch();
  }, [closeSearch, editor.enterEditMode, searchVisible, supersedePendingOpen, supersedeReconciliation]);

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
    beginEditSession(content, fileRevision, filePath, readerAnchor);
  }, [beginEditSession, content, documentTransitionInFlight, editing, filePath, fileRevision, loading]);

  const resetEditSession = useCallback(() => {
    supersedeReconciliation();
    editor.exitEditMode();
    editingFilePathRef.current = null;
    editTransitionRef.current = null;
    setPendingReaderTarget(null);
    setEditorInitialPosition(null);
    setEditing(false);
    setSavedFlash(false);
    editingRef.current = false;
    saveContinuationRef.current = null;
  }, [editor.exitEditMode, supersedeReconciliation]);

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
    if (transition && positionOutcome !== "none") {
      readerTarget = transition.originalReaderAnchor;
      if (surfacePosition && (surfacePosition.viewportMoved
        || !sameSourcePoint(surfacePosition.cursor, transition.initialEditorTarget))) {
        readerTarget = {
          source: surfacePosition.viewportMoved && surfacePosition.viewport
            ? surfacePosition.viewport : surfacePosition.cursor,
          // Moved positions restore by block because editor and reader wrapping differ.
          viewportOffsetPx: 0,
        };
      }
    }

    const sessionKey = transition?.editorSessionKey ?? editorSessionKeyRef.current;
    const exitPath = editingFilePathRef.current;
    const documentKey = exitPath ? toPathIdentityKey(exitPath) : null;
    resetEditSession();

    publishSourceReaderTarget(readerTarget, documentKey, sessionKey);
    if (positionOutcome !== "none") requestReaderFocus();

    // Reconciliation starts only after the watcher attempt settles. That closes
    // the read-before-watch gap while still reconciling when watching fails.
    if (exitPath) {
      pendingExitReconciliationRef.current = {
        path: exitPath,
        readerTarget,
        editorSessionKey: sessionKey,
      };
    }
  }, [publishSourceReaderTarget, requestReaderFocus, resetEditSession]);

  // Frozen for the app's lifetime: the running platform cannot change, and
  // the close guard's window policy must stay stable across re-renders.
  const closePolicy = useMemo(() => windowClosePolicy(detectShortcutPlatform()), []);

  const beginActionAdmission = useCallback((action: PendingAction): ActionAdmissionId | null => {
    if (actionAdmissionOwnerRef.current !== null) return null;
    pendingNoteScrollRef.current = null;
    const admissionId = nextActionAdmissionIdRef.current + 1;
    nextActionAdmissionIdRef.current = admissionId;
    actionAdmissionOwnerRef.current = admissionId;
    if (action.kind !== "close-window" && action.kind !== "quit-app") {
      startupRestoreSupersededRef.current = true;
    }
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
        const terminating = admitted.action.kind === "quit-app" || (admitted.action.kind === "close-window" && closePolicy !== "hide");
        // Commit the note buffer while its originating document can still mutate.
        flushSync(() => flushAnnotationNoteRef.current?.());
        if (terminating) {
          setAnnotationsLocked(true);
          if (!await annotationExit.requestExit()) return;
        }
        await executePendingActionRef.current(admitted.action, getAnnotationMutationVersion());
      } catch (error) {
        console.error("[action-guard] Admitted action failed:", error);
      } finally {
        setAnnotationsLocked(false);
        finishActionAdmission(admitted.admissionId);
      }
    })();
  }, [finishActionAdmission, closePolicy, annotationExit.requestExit, setAnnotationsLocked, getAnnotationMutationVersion]);

  const resolvePendingAction = useCallback(() => {
    const admitted = pendingActionRef.current;
    pendingActionRef.current = null;
    if (admitted) executeAdmittedAction(admitted);
  }, [executeAdmittedAction]);

  const continueAfterSuccessfulSave = useCallback((intent: SaveContinuationIntent) => {
    saveContinuationRef.current = null;
    if (intent === "stay-editing") return;
    if (editingRef.current) {
      exitEditMode(pendingActionRef.current ? "none" : "saved");
    }
    editingRef.current = false;
    resolvePendingAction();
  }, [exitEditMode, resolvePendingAction]);

  const discardEditsAndContinue = useCallback(() => {
    saveContinuationRef.current = null;
    // Exiting edit mode re-reads the current file from disk.
    exitEditMode(pendingActionRef.current ? "none" : "discarded");
    editingRef.current = false;
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
    if (isPrintInvoked()) return;
    if (editing) {
      guardedExitEditMode();
    } else {
      enterEditMode();
    }
  }, [editing, guardedExitEditMode, enterEditMode]);

  // Guard: run an action only if editor is clean, else flush pending autosave.
  const guardAction = useCallback((action: PendingAction): GuardAdmission => {
    // Quit is the one action admitted during an invoked print. Cmd-Q arrives
    // here from the native menu, not the keydown handler, and it is the only
    // escape if native completion never arrives. The quit continuation still
    // runs the unsaved-document decision and any pending annotation decision.
    if (isPrintInvoked() && action.kind !== "quit-app") return "busy";
    if (
      actionAdmissionOwnerRef.current !== null
      || pendingActionRef.current
      || boundaryFlushInFlightRef.current
      || showConfirmDialogRef.current
      || showConflictDialogRef.current
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

  const handleConfirmDiscard = useCallback(() => {
    setShowConfirmDialog(false);
    setShowConflictDialog(false);
    showConfirmDialogRef.current = false;
    showConflictDialogRef.current = false;
    discardEditsAndContinue();
  }, [discardEditsAndContinue]);

  const handleConfirmSave = useCallback(async () => {
    const continuation = saveContinuationRef.current;
    if (!continuation) return;
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;

    clearAutosaveIssue();
    const result = await saveCurrentEditsForSession();
    if (result === "stale" || saveContinuationRef.current !== continuation) return;
    recordSaveResult(result);
    const continuationDecision = decideSaveContinuation(result);
    if (continuationDecision === "continue") {
      flashSaved();
      continueAfterSuccessfulSave(continuation.intent);
      return;
    }
    if (continuationDecision === "reconfirm") {
      flashSaved();
      openSaveConfirmation(continuation.intent);
      return;
    }
    if (result === "conflict") {
      openConflictDialog(continuation.intent);
      return;
    }
    saveContinuationRef.current = null;
    cancelPendingAction();
  }, [cancelPendingAction, clearAutosaveIssue, recordSaveResult, saveCurrentEditsForSession, flashSaved, continueAfterSuccessfulSave, openConflictDialog, openSaveConfirmation]);

  const handleConfirmCancel = useCallback(() => {
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    saveContinuationRef.current = null;
    cancelPendingAction();
  }, [cancelPendingAction]);

  const handleConflictOverwrite = useCallback(async () => {
    const continuation = saveContinuationRef.current;
    if (!continuation) return;
    clearAutosaveIssue();
    const result = await saveCurrentEditsForSession({ forceOverwrite: true });
    if (result === "stale" || saveContinuationRef.current !== continuation) return;
    recordSaveResult(result);
    const continuationDecision = decideSaveContinuation(result);
    if (continuationDecision === "stop") return;

    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    flashSaved();
    if (continuationDecision === "reconfirm") {
      openSaveConfirmation(continuation.intent);
      return;
    }
    continueAfterSuccessfulSave(continuation.intent);
  }, [clearAutosaveIssue, recordSaveResult, saveCurrentEditsForSession, flashSaved, continueAfterSuccessfulSave, openSaveConfirmation]);

  const handleConflictReload = useCallback(async () => {
    // "Reload" resolves conflict by discarding local edits and reading file content from disk.
    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    clearAutosaveIssue();

    if (saveContinuationRef.current?.intent === "continue") {
      discardEditsAndContinue();
      return;
    }

    exitEditMode("discarded");
  }, [clearAutosaveIssue, discardEditsAndContinue, exitEditMode]);

  const handleConflictCancel = useCallback(() => {
    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    saveContinuationRef.current = null;
    cancelPendingAction();
  }, [cancelPendingAction]);

  useEffect(() => {
    editingRef.current = editing;
    showConfirmDialogRef.current = showConfirmDialog;
    showConflictDialogRef.current = showConflictDialog;
  }, [editing, showConfirmDialog, showConflictDialog]);

  useEffect(() => {
    if (!editing) return;
    if (editingFilePathRef.current === filePath) return;
    resetEditSession();
  }, [editing, filePath, resetEditSession]);

  // Guarded versions that don't depend on later declarations
  const createNewDocument = useCallback(() => {
    setVirtualContent("", "Untitled.md");
    beginEditSession("", null, null);
  }, [beginEditSession, setVirtualContent]);

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
        isPrintInvoked() ? "Close the print dialog, then try opening the file again."
          : "Bindars is finishing another file action. Try opening the file again in a moment.",
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
  // the quit-app continuation, after document and annotation decisions resolve;
  // the native side never terminates on its own.
  const requestGuardedQuit = useCallback(() => {
    const admission = guardActionRef.current({ kind: "quit-app" });
    if (admission === "busy") {
      toast("Bindars is finishing another file action. Try quitting again in a moment.", "error");
    }
  }, [toast]);

  useNativeQuit({ onQuitRequested: requestGuardedQuit });

  // Tauri window close guard. Every request is prevented and routed through
  // the action guard before the continuation hides the window (macOS, so the
  // process stays available for Dock reopen) or closes it (other platforms, exiting on the last close).
  // Register once and read live state from refs to avoid stale closures.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | null = null;

    const handleCloseRequest = (event: { preventDefault: () => void }) => {
      if (isPrintInvoked()) { event.preventDefault(); return; }
      const decision = decideNativeCloseRequest({
        programmaticCloseInFlight: programmaticCloseRef.current !== null,
        actionAdmissionInFlight: actionAdmissionOwnerRef.current !== null,
      });

      switch (decision) {
        case "complete-programmatic-close": {
          const approvedClose = programmaticCloseRef.current;
          programmaticCloseRef.current = null;
          // `appWindow.close()` crosses the native IPC boundary before this
          // callback runs. Any editor active now belongs to a newer session and
          // must cancel the stale close, even if it is not dirty yet.
          flushSync(() => flushAnnotationNoteRef.current?.());
          // Consent covers only this close and this annotation revision. The
          // close IPC may already have returned, allowing newer edits meanwhile.
          const hasUnapprovedAnnotations = Object.keys(pendingAnnotationRecords()).length > 0
            && approvedClose?.annotationVersion !== getAnnotationMutationVersion();
          if (editingRef.current || hasUnapprovedAnnotations) {
            event.preventDefault();
          }
          return;
        }
        case "prevent-silently":
          // An admitted action owns the guard. Repeated native close requests
          // must not bypass its pending save or annotation decision.
          event.preventDefault();
          return;
        case "prevent-and-guard":
          // The request never destroys the window directly on any platform.
          // Clean and dirty requests converge on the same guard: a dirty
          // document saves or resolves Save/Discard/Cancel before the
          // continuation hides the window on macOS or closes it elsewhere.
          event.preventDefault();
          guardActionRef.current({ kind: "close-window" });
          return;
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
  }, [pendingAnnotationRecords, getAnnotationMutationVersion]);

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

  // Reset search when the reader document changes, including identical text in another file.
  const prevSearchDocumentRef = useRef({ content, filePath });
  useEffect(() => {
    const previous = prevSearchDocumentRef.current;
    if (previous.content !== content || previous.filePath !== filePath) {
      prevSearchDocumentRef.current = { content, filePath };
      if (searchVisible) {
        search.clear();
      }
    }
  }, [content, filePath, searchVisible, search.clear]);

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
  const headings = useHeadings(contentRef, content, !editing && readerDocumentReady, filePath);

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
      if (findHeadingElement(root, target.id) === target) {
        return scrollToHeading(target.id, options);
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
    async (
      path: string,
      headingId: string | null,
      retryAction: RetryablePendingAction,
    ): Promise<OpenFilePathResult> => {
      // Only the latest user navigation may clear pending scroll after a failed open.
      // Watcher reloads preserve the current heading separately and intentionally
      // bypass this supersession guard.
      const openAttemptId = ++openAttemptIdRef.current;
      setPendingReaderTarget(null);
      const result = await openFilePathWithStatus(path, retryAction);
      if (openAttemptIdRef.current !== openAttemptId) return { status: "superseded" };

      if (result.status === "opened" && headingId) {
        setPendingReaderTarget({
          kind: "heading",
          headingId,
          documentKey: toPathIdentityKey(result.canonicalPath),
        });
      }
      return result;
    },
    [openFilePathWithStatus],
  );

  // Session restore: reopen last file + scroll position on startup
  const handleSessionRestore = useCallback(
    async (session: { filePath: string; headingId: string | null }) => {
      // Settings can arrive after a newer document action has already finished or
      // been cancelled. Startup restoration only owns the untouched launch;
      // the open hook handles supersession once the restoration read starts.
      if (startupRestoreSupersededRef.current) return;
      const result = await openPathAndScroll(
        session.filePath,
        session.headingId,
        { kind: "restore-session", path: session.filePath, headingId: session.headingId },
      );
      if (result.status === "failed" && result.error.category !== "resource-unavailable") {
        dismissError(result.errorOwnerToken);
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

    // Links may target footnotes and other non-heading fragments; headings
    // still route through scrollToHeading inside scrollToFragment.
    if (!scrollToFragment(pendingReaderTarget.headingId, { behavior: "auto" })) {
      toast(`"${pendingReaderTarget.headingId}" was not found in this document — it may have been renamed or removed.`, "error");
    }
    setPendingReaderTarget(null);
  }, [content, editing, filePath, pendingReaderTarget, scrollToFragment, toast, updateReadingProgressNow]);

  // Deliberate returns already cause a render. Complete once, after the layout
  // restoration and child dialog cleanup; a blocked request must never linger.
  useEffect(() => {
    const request = readerFocusRequestRef.current;
    if (!request) return;
    readerFocusRequestRef.current = null;
    const published = getPublishedDocument();
    const documentKey = published.filePath ? toPathIdentityKey(published.filePath) : null;
    const ownership = getOpenOwnership();
    if (
      request.documentKey !== documentKey
      || request.editorSessionKey !== editorSessionKeyRef.current
      || request.openGeneration !== ownership.generation
      || request.actionId !== nextActionAdmissionIdRef.current
      || ownership.userOpenInFlight || actionAdmissionOwnerRef.current !== null
      || editingRef.current || searchVisible !== request.searchVisible || !readerDocumentReady
      || presentationMode || printSessionRef.current
      || showConfirmDialogRef.current || showConflictDialogRef.current
      || shortcutsVisible || commandPaletteVisible || readerControlsVisible
    ) return;
    mainScrollRef.current?.focus({ preventScroll: true });
  });

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

    scheduleReconciliation("watcher");
  }, [scheduleReconciliation]);

  const handleWatcherUnavailable = useCallback((
    unavailablePath: string,
    reason: WatcherUnavailableReason,
  ) => {
    const currentPath = currentPositionRef.current.filePath;
    if (
      !currentPath
      || toPathIdentityKey(unavailablePath) !== toPathIdentityKey(currentPath)
    ) return;

    const pendingExit = pendingExitReconciliationRef.current;
    // Watch settlement already gave a setup failure for this path to the
    // higher-priority editor-exit reconciliation owner. A later native drop
    // is new information and must still reach the reconciliation controller.
    if (
      reason === "setup"
      && pendingExit
      && toPathIdentityKey(pendingExit.path) === toPathIdentityKey(unavailablePath)
    ) return;

    scheduleReconciliation(
      reason === "setup" ? "watcher-setup-fallback" : "watcher-drop-fallback",
    );
  }, [scheduleReconciliation]);

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

  const fileWatcher = useFileWatcher({
    filePath,
    isEditing: editing,
    onFileChanged: handleFileChanged,
    onWatchSettled: handleWatchSettled,
    onWatcherUnavailable: handleWatcherUnavailable,
  });

  useReconciliationLifecycle({
    onSignal: (signal) => {
      fileWatcher.retry();
      scheduleReconciliation(signal);
    },
  });

  // Annotations: highlight handler
  const handleHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, headingId: string | null) => {
    addHighlight(anchor, color, headingId);
  }, [addHighlight]);

  const handleNote = useCallback((anchor: TextAnchor, headingId: string | null) => {
    const id = addHighlight(anchor, "yellow", headingId);
    if (!id) return;
    pendingNoteScrollRef.current = { id, path: filePath, content };
    startNoteRef.current?.(id);
    setAnnotationsPanelVisible(true);
    setFocusMode(false);
  }, [addHighlight, filePath, content]);

  // Repaint for document identity changes, even when another file has identical text.
  useEffect(() => {
    const pending = pendingNoteScrollRef.current;
    if (pending && (pending.path !== filePath || pending.content !== content)) pendingNoteScrollRef.current = null;
    if (editing || !readerDocumentReady) return;
    const container = contentRef.current;
    if (!container || !isDocumentOpen(content)) return;
    if (!highlights.length) {
      clearAnnotationHighlights(container);
      setAnnotationLocations({});
      return;
    }

    let cancelled = false;
    let paintVersion = 0;
    let frameId = 0;
    const repaint = () => {
      const version = ++paintVersion;
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        void prepareAnnotationDocument(container, content).then((evidence) => {
          if (cancelled || version !== paintVersion || contentRef.current !== container) return;
          clearAnnotationHighlights(container);
          const locations: Record<string, string> = {};
          for (const hl of highlights) {
            const result = resolveAnchor(hl, container, evidence);
            locations[hl.id] = result.status;
            if (result.range) wrapRange(result.range, `annotation-highlight-${hl.color}`, hl.id);
          }
          setAnnotationLocations(locations);
          const pending = pendingNoteScrollRef.current;
          if (pending?.path === filePath && pending.content === content && highlights.some((hl) => hl.id === pending.id)) {
            pendingNoteScrollRef.current = null;
            const mark = Array.from(container.querySelectorAll<HTMLElement>("mark[data-highlight-id]"))
              .find((element) => element.dataset.highlightId === pending.id);
            const viewport = mainScrollRef.current?.getBoundingClientRect();
            const bounds = mark?.getBoundingClientRect();
            // Deliberate Note reflow can move its passage below the viewport.
            // Consume once after painting; later diagram repaints must not scroll.
            if (mark && viewport && bounds && (bounds.top < viewport.top || bounds.bottom > viewport.bottom)) {
              mark.scrollIntoView({ block: "center", behavior: "auto" });
            }
          }
        }).catch(() => {
          if (!cancelled && version === paintVersion) {
            const pending = pendingNoteScrollRef.current;
            if (pending?.path === filePath && pending.content === content && highlights.some((hl) => hl.id === pending.id)) {
              pendingNoteScrollRef.current = null;
            }
            clearAnnotationHighlights(container);
            setAnnotationLocations(Object.fromEntries(highlights.map((h) => [h.id, "uncertain"])));
          }
        });
      });
    };
    container.addEventListener("bindars:diagram-rendered", repaint);
    repaint();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      container.removeEventListener("bindars:diagram-rendered", repaint);
    };
  }, [content, filePath, editing, highlights, readerDocumentReady]);

  // Scroll to highlight when clicked in panel
  const handleClickHighlight = useCallback((id: string) => {
    const container = contentRef.current;
    if (!container) return;
    const mark = Array.from(container.querySelectorAll<HTMLElement>("mark[data-highlight-id]"))
      .find((element) => element.dataset.highlightId === id);
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
    async (
      path: string,
      anchor: string | null,
      retryAction: RetryablePendingAction = { kind: "navigate", path, anchor },
    ) => {
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
      const result = await openPathAndScroll(path, anchor, retryAction);
      if (result.status === "opened") {
        if (pos.filePath) {
          pushEntry({ filePath: pos.filePath, headingId: pos.headingId });
        }
      }
    },
    [filePath, pushEntry, openPathAndScroll, scrollToFragment, toast],
  );

  const handleGoBack = useCallback(async (
    retryAction: RetryablePendingAction = { kind: "go-back" },
  ) => {
    const entry = peekBack();
    if (!entry) return;
    const pos = currentPositionRef.current;
    if (!pos.filePath) return;
    const result = await openPathAndScroll(entry.filePath, entry.headingId, retryAction);
    if (result.status === "opened") {
      commitBack({ filePath: pos.filePath, headingId: pos.headingId });
    }
  }, [peekBack, commitBack, openPathAndScroll]);

  const handleGoForward = useCallback(async (
    retryAction: RetryablePendingAction = { kind: "go-forward" },
  ) => {
    const entry = peekForward();
    if (!entry) return;
    const pos = currentPositionRef.current;
    if (!pos.filePath) return;
    const result = await openPathAndScroll(entry.filePath, entry.headingId, retryAction);
    if (result.status === "opened") {
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
    if (recentFilesStatus === "ready" && filePath && fileName) {
      addRecent(filePath, fileName);
    }
  }, [filePath, fileName, recentFilesStatus, addRecent]);

  const handleOpenRecent = useCallback(
    async (
      path: string,
      retryAction: RetryablePendingAction = { kind: "open-recent", path },
    ) => {
      const targetPathKey = toPathIdentityKey(path);
      const currentPathKey = filePath ? toPathIdentityKey(filePath) : "";
      const savedHeading = getScrollPosition(path);
      if (targetPathKey && currentPathKey === targetPathKey) {
        if (savedHeading && savedHeading !== getActiveHeadingId()) {
          scrollToHeading(savedHeading);
        }
        return;
      }

      await openPathAndScroll(path, savedHeading, retryAction);
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
    sidebarUpdatedRef.current = true;
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

  const toggleAnnotationsPanel = useCallback(() => {
    pendingNoteScrollRef.current = null;
    setAnnotationsPanelVisible((v) => !v);
  }, []);

  const closeAnnotationsPanel = useCallback(() => {
    pendingNoteScrollRef.current = null;
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
    const removedControlHadFocus = Boolean(document.activeElement?.closest(".focus-bar"));
    setFocusMode(false);
    if (removedControlHadFocus) {
      if (editingRef.current) editorSurfaceRef.current?.focus();
      else requestReaderFocus(searchVisible);
    }
  }, [requestReaderFocus, searchVisible]);

  const enterPresentation = useCallback(() => {
    if (isPrintInvoked()) return;
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
    requestReaderFocus(searchVisible);
  }, [requestReaderFocus, searchVisible]);

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

  const retryDocumentOpen = useCallback(() => {
    if (
      !documentError?.retryAction
      || documentError.retryAvailability !== "ready"
    ) return;
    if (guardAction(documentError.retryAction) === "busy") {
      toast("Finish the current action before retrying this file.", "error");
    }
  }, [documentError, guardAction, toast]);

  const dismissDocumentError = useCallback(() => {
    dismissError(documentError?.ownerToken);
  }, [dismissError, documentError?.ownerToken]);

  executePendingActionRef.current = async (action, annotationVersion) => {
    switch (action.kind) {
      case "close-window": {
        const appWindow = getCurrentWindow();
        try {
          // Exiting for the original close leaves no active editor. If one
          // exists now, it is a newer session and wins over the stale close.
          if (editingRef.current) {
            return;
          }
          if (closePolicy === "hide") {
            // Hiding emits no close-requested event, so there is no
            // programmatic-close handshake to finish; the process simply
            // stays available for Dock reopen and Finder delivery.
            await appWindow.hide();
          } else {
            programmaticCloseRef.current = { annotationVersion };
            // The resulting close-requested callback performs the final
            // new-session and annotation checks.
            await appWindow.close();
          }
        } catch (err) {
          programmaticCloseRef.current = null;
          console.error("[close-guard] Programmatic close or hide failed:", err);
          toast("Couldn't close the window. Your document is still open.", "error");
        }
        return;
      }
      case "quit-app": {
        // Document and annotation decisions are complete. A newly entered
        // edit session still wins over the stale quit.
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
      case "try-sample": {
        // The admitted action owns the dialog, write and ordinary open together.
        // Cancel an earlier startup read before waiting for the destination.
        supersedePendingOpen();
        const generation = getOpenOwnership().generation;
        const isCurrent = () => getOpenOwnership().generation === generation;
        let defaultPath = "Welcome to Bindars.md";
        for (const directory of [documentDir, homeDir]) {
          try {
            const path = await directory();
            if (path && !path.includes("\0") && /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path)) {
              defaultPath = `${path.replace(/[/\\]$/, "")}/Welcome to Bindars.md`;
              break;
            }
          } catch {
            // Directory resolution is a suggestion; the user can choose any location.
          }
        }
        if (!isCurrent()) return;
        try {
          const path = await save({
            defaultPath,
            filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
          });
          if (!path || !isCurrent()) return;
          await invoke("export_markdown_file", { path, content: welcomeContent });
          if (!isCurrent()) return;
          const result = await openPathAndScroll(path, null, { kind: "open-file-path", path });
          if (result.status === "failed") {
            toast(`The example was saved to ${path}, but couldn't be opened. Open that file to try again.`, "error");
          }
        } catch (error) {
          if (isCurrent()) {
            toast(normalizeFileError(error, "Couldn't save the example. Choose another location and try again.").message, "error");
          }
        }
        return;
      }
      case "open-file-path":
        await openFilePath(action.path, action);
        return;
      case "open-recent":
        await handleOpenRecent(action.path, action);
        return;
      case "go-back":
        await handleGoBack(action);
        return;
      case "go-forward":
        await handleGoForward(action);
        return;
      case "navigate":
        await handleNavigateToFile(action.path, action.anchor, action);
        return;
      case "open-workspace-hit":
        await handleNavigateToFile(action.path, action.headingId, action);
        return;
      case "restore-session":
        await openPathAndScroll(action.path, action.headingId, action);
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
    // Native sheet events do not enter the webview. While pagination owns this
    // reader, skip app shortcuts but let system keys such as Cmd-Q through;
    // only a second Cmd/Ctrl-P must lose its default action.
    if (isPrintInvoked()) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") e.preventDefault();
      return;
    }
    if (showConfirmDialog || showConflictDialog) return;
    if (isImeCompositionKey(e)) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const altGraph = e.getModifierState?.("AltGraph") ?? false;
    const target = e.target as HTMLElement | null;
    const inInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const inEditorPanel = editing && typeof target?.closest === "function" && Boolean(target.closest(".cm-panel"));

    // Presentation keys yield to controls; Escape still exits the mode.
    if (presentationMode) {
      if (key === "escape") { e.preventDefault(); exitPresentation(); return; }
      if (inInput || target?.closest?.("select")) return;
      if (key === "enter" && target?.closest?.("button, a[href]")) return;
      if (key === " " && target?.closest?.("button")) return;
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
      // The input owns arrow selection; result buttons retain native keyboard behavior.
      if (target?.tagName !== "INPUT") return;
      if (key === "arrowdown") {
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
      if (e.key === "?" && !ctrl && !e.altKey) {
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
      if (!editing) {
        if (focusMode) exitFocusMode();
        else setFocusMode(true);
      }
    } else if (key === "escape" && !ctrl && !e.altKey && !e.shiftKey) {
      if (focusMode) {
        e.preventDefault();
        exitFocusMode();
      } else if (editing) {
        e.preventDefault();
        guardedExitEditMode();
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

  // All signals request the same guarded cleanup; no event can bypass active
  // print media or a native request still waiting for its completion callback.
  useEffect(() => {
    printMountedRef.current = true;
    const media = window.matchMedia?.("print");
    const beforePrint = () => {
      if (!printSessionRef.current?.invoked) {
        printSessionRef.current = { invoked: true, nativePending: false };
      }
      document.body.setAttribute("data-printing", "true");
      flushSync(() => setPrintPhase("printing"));
      armPrintCleanup();
    };
    const check = () => {
      if (printSessionRef.current?.invoked) printCleanupControllerRef.current?.check();
    };
    const mediaChanged = () => {
      if (media?.matches && !printSessionRef.current?.invoked) beforePrint();
      else if (!media?.matches) check();
    };
    const detach = () => {
      window.removeEventListener("afterprint", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      media?.removeEventListener("change", mediaChanged);
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    media?.addEventListener("change", mediaChanged);
    return () => {
      printMountedRef.current = false;
      window.removeEventListener("beforeprint", beforePrint);
      if (printSessionRef.current?.invoked) {
        // The native operation outlives React teardown. Retain only recovery
        // listeners until it ends; never update unmounted React state.
        printDisposeRef.current = detach;
      } else {
        detach();
        clearPrintSession();
      }
    };
  }, [armPrintCleanup, clearPrintSession]);

  // The deadline permits interaction, not storage writes. History and preference
  // hooks keep their own authority/user-intent guards while reads are pending.
  const appReady = startupTimedOut || (sessionRestored && recentFilesStatus !== "loading");
  useEffect(() => {
    if (appReady) {
      signalAppReady();
      return;
    }
    const timer = setTimeout(() => setStartupTimedOut(true), STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [appReady]);

  // Suppress render while startup state is settling — loading screen covers #root
  if (!appReady) return null;

  return (
    <div
      className={`app-shell h-screen flex flex-col bg-bg-primary text-text-primary overflow-hidden ${fileName ? "has-document" : ""} ${settings.reducedEffects ? "reduced-effects" : ""}`}
      style={
        {
          "--header-row-height": `${HEADER_HEIGHT_PX}px`,
          "--heading-scroll-margin": `${HEADING_SCROLL_MARGIN_PX}px`,
        } as CSSProperties
      }
    >
      {printing && (
        <div className="print-status">
          <span role="status">{printPhase === "preparing" ? "Preparing print…" : "Print dialog requested"}</span>
          {printPhase === "preparing" && (
            <button type="button" onClick={() => {
              clearPrintSession();
              mainScrollRef.current?.focus({ preventScroll: true });
            }}>Cancel</button>
          )}
        </div>
      )}

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
          readerControlsVisible={readerControlsVisible}
          readerControlsId={readerControlsId}
          readerControlsTriggerRef={readerControlsTriggerRef}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={guardedGoBack}
          onGoForward={guardedGoForward}
          isEditing={editing}
          isDirty={editor.dirty}
          isDraft={documentOpen && editing && !filePath}
          saveChoosesLocation={!filePath || currentFileIsDraft}
          isSavedFlash={savedFlash}
          saveWarning={saveWarning}
          canSave={!actionAdmissionInFlight && editing && (editor.dirty || !filePath || currentFileIsDraft)}
          canToggleEdit={canToggleEdit}
          onToggleEdit={toggleEditMode}
          onSave={handleSave}
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
          recentHistoryUnavailable={recentFilesStatus !== "ready"}
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
          tabIndex={-1}
          aria-label="Document"
          inert={presentationMode}
          className="flex-1 overflow-y-auto reading-surface bg-bg-primary min-w-0 relative focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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
            <div
              className="max-w-[65ch] mx-auto px-6 pt-6 text-sm text-text-muted flex flex-wrap items-center gap-x-3 gap-y-2"
            >
              <span role="status" aria-live="polite" aria-atomic="true">
                {openingSlow
                  ? "Still opening. Cloud and external files can take longer to become available."
                  : "Opening file..."}
              </span>
              {openingSlow && (
                <button
                  type="button"
                  onClick={handleCancelPendingOpen}
                  className="min-h-6 px-2 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors duration-120 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Cancel
                </button>
              )}
            </div>
          )}

          {error && (
            <ErrorBanner
              error={error}
              onDismiss={dismissDocumentError}
              onAction={documentError?.retryAction ? retryDocumentOpen : undefined}
              actionLabel={documentError?.retryAction ? "Retry" : undefined}
              actionDisabled={
                documentError?.retryAvailability !== "ready"
                || actionAdmissionInFlight
              }
            />
          )}

          {fileWatcher.unavailable && (
            <div role="status" className="max-w-[65ch] mx-auto px-6 py-3 text-sm text-text-secondary">
              Automatic file watching is unavailable. Bindars checks for changes when you return to this window.{" "}
              <button type="button" className="underline" onClick={fileWatcher.retry}>Retry file watching</button>
            </div>
          )}

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
              canDismissSaveError={!editor.savePathBlocked}
              recoveryPath={editor.recoveryPath}
              onBufferChange={publishEditorBuffer}
              onSaveAsAfterError={handleSaveAsAfterError}
              onDismissSaveError={editor.dismissSaveError}
            />
          ) : preparedDocument?.status === "too-complex" ? (
            <DocumentNotice
              contentRef={contentRef}
              title={`Document ${DOCUMENT_COMPLEXITY_REASON}`}
              message={preparedDocument.message}
            />
          ) : preparedDocument?.status === "parse-failed" ? (
            <DocumentNotice
              contentRef={contentRef}
              title="Screenplay could not be displayed"
              message={preparedDocument.message}
            />
          ) : preparedDocument?.status === "ready" && preparedDocument.format === "fountain" ? (
            <FountainRenderer
              // As with Markdown, discard marked DOM as a unit on source changes.
              key={content}
              parsed={preparedDocument.parsedFountain}
              settings={settings}
              contentRef={contentRef}
              focusedCharacter={focusedCharacter}
            />
          ) : isDocumentOpen(content) && preparedDocument?.status === "ready" ? (
            <MarkdownRenderer
              content={content}
              filePath={filePath || ""}
              imagesAuthorized={imagesAuthorized}
              settings={settings}
              contentRef={contentRef}
              onOpenFragment={openMarkdownFragment}
              onNavigateToFile={guardedNavigateToFile}
            />
          ) : (
            <EmptyState
              onNewFile={guardedNewFile}
              onOpenFile={guardedOpenFile}
              onTrySample={() => { guardAction({ kind: "try-sample" }); }}
              canTrySample={!actionAdmissionInFlight}
              recentFiles={recentFiles}
              recentHistoryUnavailable={recentFilesStatus !== "ready"}
              onOpenRecent={guardedOpenRecent}
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
          scriptCharacters={fileType === "fountain" ? scriptStats?.characters ?? [] : []}
          focusedCharacter={focusedCharacter}
          onToggleCharacterFocus={handleToggleCharacterFocus}
          isBookmarked={isBookmarked}
          onToggleBookmark={annotationsReady ? toggleBookmark : undefined}
          onOpenHeading={scrollToHeading}
          onOpenScene={openScene}
        />

        <AnnotationsPanel
          key={filePath}
          flushNoteRef={flushAnnotationNoteRef}
          startNoteRef={startNoteRef}
          visible={annotationsPanelVisible && !focusMode && !editing && !presentationMode}
          annotationStatus={annotationStatus}
          annotationsReady={annotationsReady}
          saving={annotationsSaving}
          mutationsDisabled={actionAdmissionInFlight}
          dataWarning={annotationDataWarning}
          locations={annotationLocations}
          onRemoveBookmark={removeBookmark}
          filePath={filePath}
          onRestoreRecord={restoreAnnotationRecord}
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
            id={readerControlsId}
            triggerRef={readerControlsTriggerRef}
            settings={settings}
            theme={theme}
            onSetTheme={setTheme}
            onUpdate={updateSettings}
            onReset={resetSettings}
            onClose={closeReaderControls}
          />
        )}
      </div>

      {!editing && !actionAdmissionInFlight && readerDocumentReady && annotationsReady && isDocumentOpen(content) && !presentationMode && (
        <HighlightToolbar
          key={JSON.stringify([filePath, content])}
          source={content ?? ""}
          contentRef={contentRef}
          isEditing={editing}
          getActiveHeadingId={getActiveHeadingId}
          onHighlight={handleHighlight}
          onNote={handleNote}
        />
      )}
      {focusMode && (
        <FocusBar
          fileName={fileName}
          isDirty={editor.dirty}
          isDraft={documentOpen && editing && !filePath}
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
          imagesAuthorized={imagesAuthorized}
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
        pending={workspaceSearch.pending}
        results={workspaceSearch.results}
        selectedIndex={workspaceSearch.selectedIndex}
        status={workspaceIndex.state.status}
        onQueryChange={workspaceSearch.setQuery}
        onClose={closeCommandPalette}
        onOpenHit={openWorkspaceHit}
        onHoverIndex={workspaceSearch.setSelectedIndex}
      />
      <AnnotationExitDialog paths={annotationExit.paths} waiting={annotationExit.waiting}
        onKeepOpen={annotationExit.keepOpen} onRetry={annotationExit.retry}
        onQuit={annotationExit.quitWithoutSaving} pendingRecords={pendingAnnotationRecords} />
      <ConfirmDialog
        visible={showConfirmDialog}
        title="Unsaved changes"
        message={`You have unsaved changes to ${fileName || "this file"}. If you discard them, they can't be recovered.`}
        confirmLabel="Save"
        cancelLabel="Discard"
        onConfirm={handleConfirmSave}
        onCancel={handleConfirmDiscard}
        onDismiss={handleConfirmCancel}
      />
      <ConfirmDialog
        visible={showConflictDialog}
        title="File changed on disk"
        message={`"${fileName || "This file"}" was modified outside Bindars while you were editing. Reload replaces your changes here with the version on disk; they can't be recovered. Overwrite keeps your changes and replaces the file on disk.`}
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
    </div>
  );
}

export default App;
