import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { TableOfContents } from "./components/TableOfContents";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner } from "./components/ErrorBanner";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import { ReaderControls } from "./components/ReaderControls";
import { DropZone } from "./components/DropZone";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { FocusBar } from "./components/FocusBar";
import { SearchBar } from "./components/SearchBar";
import { FountainRenderer } from "./components/FountainRenderer";
import { parseFountain, extractCharacters } from "./lib/fountain";
import { MarkdownEditor } from "./components/MarkdownEditor";
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
import { useHeadings } from "./hooks/useHeadings";
import { useHeadingObserver } from "./hooks/useHeadingObserver";
import { useDragDrop } from "./hooks/useDragDrop";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { useSessionRestore } from "./hooks/useSessionRestore";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { useSearch } from "./hooks/useSearch";
import { useFileWatcher } from "./hooks/useFileWatcher";
import { useAnnotations } from "./hooks/useAnnotations";
import { useWorkspaceRoot } from "./hooks/useWorkspaceRoot";
import { useWorkspaceIndex } from "./hooks/useWorkspaceIndex";
import { useWorkspaceSearch } from "./hooks/useWorkspaceSearch";
import { useWorkspaceInsights } from "./hooks/useWorkspaceInsights";
import { HEADER_HEIGHT_PX, HEADING_SCROLL_MARGIN_PX } from "./lib/scroll-constants";
import { toPathIdentityKey } from "./lib/paths";
import { computeReadingStats } from "./lib/reading-stats";
import { findAnchor, wrapRange, clearAnnotationHighlights } from "./lib/text-anchoring";
import { applyPrintState } from "./lib/print-state";
import { createPrintCleanupController, preparePrintDocument } from "./lib/print-export";
import { useToast } from "./components/ToastProvider";
import { storeGet, storeSet } from "./lib/store";
import { signalAppReady } from "./lib/app-ready";
import type { TextAnchor } from "./lib/text-anchoring";
import type { HighlightColor, SceneItem, WorkspaceSearchHit } from "./types";
import welcomeContent from "./assets/welcome.md?raw";

const SCENE_HEADING_RE = /^(?:INT\.|EXT\.|INT\/EXT\.|EST\.)\s+/i;

type PendingAction =
  | { kind: "close-window" }
  | { kind: "open-file-dialog" }
  | { kind: "open-file-path"; path: string }
  | { kind: "open-recent"; path: string }
  | { kind: "go-back" }
  | { kind: "go-forward" }
  | { kind: "navigate"; path: string; anchor: string | null }
  | { kind: "open-workspace-hit"; path: string; headingId: string | null };

function App() {
  const { theme, setTheme, cycleTheme } = useTheme();
  const { settings, updateSettings, resetSettings } = useReaderSettings();
  const {
    content,
    filePath,
    fileName,
    fileRevision,
    fileType,
    error,
    loading,
    openingPath,
    userOpenInFlight,
    openFile,
    openFilePath,
    setVirtualContent,
    dismissError,
  } = useMarkdownFile();
  const { recentFiles, loaded: recentFilesLoaded, addRecent, removeRecent, updateScrollPosition, getScrollPosition } = useRecentFiles();
  const { canGoBack, canGoForward, pushEntry, peekBack, commitBack, peekForward, commitForward } =
    useNavigationHistory();
  const workspaceRoot = useWorkspaceRoot();
  const workspaceIndex = useWorkspaceIndex(workspaceRoot.rootPath);
  const workspaceSearch = useWorkspaceSearch({ docs: workspaceIndex.docs, recentFiles });
  const workspaceInsights = useWorkspaceInsights(workspaceIndex.docs, filePath);

  const editor = useEditor();
  const { toast } = useToast();

  const readingStats = useMemo(() => content ? computeReadingStats(content, fileType) : null, [content, fileType]);

  const { highlights, bookmarks, addHighlight, removeHighlight, updateHighlight, toggleBookmark, isBookmarked } = useAnnotations(filePath);

  const [sidebarVisible, setSidebarVisible] = useState(() => {
    try {
      return localStorage.getItem("binder-sidebar-visible") === "true";
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
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [presentationMode, setPresentationMode] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [focusedCharacter, setFocusedCharacter] = useState<string | null>(null);
  const slidesRef = useRef<Slide[]>([]);
  const presentationDeferredReloadRef = useRef(false);

  // Restore sidebar state from Tauri store as async backup (if localStorage had no entry)
  useEffect(() => {
    let active = true;
    try {
      if (localStorage.getItem("binder-sidebar-visible") !== null) return;
    } catch { /* noop */ }
    storeGet<boolean>("sidebar-visible").then((stored) => {
      if (!active || stored === null) return;
      setSidebarVisible(stored);
    });
    return () => { active = false; };
  }, []);

  // Pending action to run after confirm dialog resolves.
  const pendingActionRef = useRef<PendingAction | null>(null);
  const conflictContinuationRef = useRef<(() => void) | null>(null);
  const executePendingActionRef = useRef<(action: PendingAction) => void>(() => {});
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mainScrollRef = useRef<HTMLElement | null>(null);
  const appRootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const progressTextRef = useRef<HTMLSpanElement | null>(null);
  const progressPctRef = useRef(-1);
  const keyDownHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  const motionScrollBehavior: ScrollBehavior = settings.reducedEffects ? "auto" : "smooth";
  const editingRef = useRef(editing);
  const dirtyRef = useRef(editor.dirty);
  const showConfirmDialogRef = useRef(showConfirmDialog);
  const showConflictDialogRef = useRef(showConflictDialog);
  const isProgrammaticCloseRef = useRef(false);
  const printCleanupControllerRef = useRef<ReturnType<typeof createPrintCleanupController> | null>(null);

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

  const saveVirtualContent = useCallback(async (): Promise<"saved" | "cancelled" | "error"> => {
    const buffer = editor.buffer;
    if (buffer === null) return "error";

    const baseName = (fileName || "untitled").replace(/\.(md|markdown|fountain)$/i, "");
    const defaultName = `${baseName || "untitled"}.md`;
    try {
      const savePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!savePath) return "cancelled";

      await invoke("export_markdown_file", { path: savePath, content: buffer });
      const reopened = await openFilePath(savePath, "user");
      if (!reopened) {
        toast("Saved, but couldn't reopen the new file automatically.", "error");
      }
      editor.exitEditMode();
      setEditing(false);
      editingRef.current = false;
      dirtyRef.current = false;
      return "saved";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(message || "Couldn't save file.", "error");
      return "error";
    }
  }, [editor, fileName, openFilePath, toast]);

  const saveCurrentEdits = useCallback(async (forceOverwrite = false) => {
    if (editor.saving) return "noop" as const;
    if (!filePath) {
      const result = await saveVirtualContent();
      if (result === "saved") return "saved" as const;
      if (result === "cancelled") return "noop" as const;
      return "error" as const;
    }
    return editor.save(filePath, { force: forceOverwrite });
  }, [editor, filePath, saveVirtualContent]);

  const handleSave = useCallback(async () => {
    const result = await saveCurrentEdits(false);
    if (result === "saved") {
      flashSaved();
      return;
    }
    if (result === "conflict") {
      conflictContinuationRef.current = null;
      showConflictDialogRef.current = true;
      setShowConflictDialog(true);
    }
  }, [flashSaved, saveCurrentEdits]);

  const enterEditMode = useCallback(() => {
    if (!content || editing) return;
    editor.enterEditMode(content, fileRevision);
    setEditing(true);
    showConflictDialogRef.current = false;
    setShowConflictDialog(false);
    conflictContinuationRef.current = null;
    if (searchVisible) closeSearch();
  }, [content, editing, editor, fileRevision, searchVisible, closeSearch]);

  const exitEditMode = useCallback(() => {
    editor.exitEditMode();
    setEditing(false);
    setSavedFlash(false);
    // Re-read file to refresh rendered view
    if (filePath) {
      openFilePath(filePath, "user").catch((err) => {
        console.warn("[exitEditMode] Failed to re-read file:", err);
      });
    }
  }, [editor, filePath, openFilePath]);

  const guardedExitEditMode = useCallback(() => {
    if (!editing) return;
    if (!editor.dirty) {
      exitEditMode();
      return;
    }
    pendingActionRef.current = null;
    showConfirmDialogRef.current = true;
    setShowConfirmDialog(true);
  }, [editing, editor.dirty, exitEditMode]);

  const toggleEditMode = useCallback(() => {
    if (editing) {
      guardedExitEditMode();
    } else {
      enterEditMode();
    }
  }, [editing, guardedExitEditMode, enterEditMode]);

  // Guard: run an action only if editor is clean, else show confirm dialog.
  const guardAction = useCallback((action: PendingAction) => {
    if (showConfirmDialog || showConflictDialog) return;
    if (presentationMode) {
      // Exit presentation inline — navigation will replace content anyway,
      // so no deferred reload needed.
      setPresentationMode(false);
      setCurrentSlide(0);
      slidesRef.current = [];
      presentationDeferredReloadRef.current = false;
    }
    if (!editing || !editor.dirty) {
      executePendingActionRef.current(action);
      return;
    }
    pendingActionRef.current = action;
    showConfirmDialogRef.current = true;
    setShowConfirmDialog(true);
  }, [editing, editor.dirty, showConfirmDialog, showConflictDialog, presentationMode]);

  const resolvePendingAction = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (!action) return;
    executePendingActionRef.current(action);
  }, []);

  const discardEditsAndContinue = useCallback(() => {
    conflictContinuationRef.current = null;
    // Exiting edit mode re-reads the current file from disk.
    exitEditMode();
    editingRef.current = false;
    dirtyRef.current = false;
    resolvePendingAction();
  }, [exitEditMode, resolvePendingAction]);

  const handleConfirmDiscard = useCallback(() => {
    setShowConfirmDialog(false);
    setShowConflictDialog(false);
    showConfirmDialogRef.current = false;
    showConflictDialogRef.current = false;
    discardEditsAndContinue();
  }, [discardEditsAndContinue]);

  const handleConfirmSave = useCallback(async () => {
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    const continueAfterSave = () => {
      if (editingRef.current) {
        exitEditMode();
      }
      editingRef.current = false;
      dirtyRef.current = false;
      resolvePendingAction();
    };

    const result = await saveCurrentEdits(false);
    if (result === "saved") {
      flashSaved();
      continueAfterSave();
      return;
    }
    if (result === "conflict") {
      conflictContinuationRef.current = continueAfterSave;
      showConflictDialogRef.current = true;
      setShowConflictDialog(true);
      return;
    }
    pendingActionRef.current = null;
  }, [saveCurrentEdits, flashSaved, exitEditMode, resolvePendingAction]);

  const handleConfirmCancel = useCallback(() => {
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    conflictContinuationRef.current = null;
    pendingActionRef.current = null;
  }, []);

  const handleConflictOverwrite = useCallback(async () => {
    const result = await saveCurrentEdits(true);
    if (result !== "saved") return;

    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    flashSaved();
    const continuation = conflictContinuationRef.current;
    conflictContinuationRef.current = null;
    if (continuation) continuation();
  }, [saveCurrentEdits, flashSaved]);

  const handleConflictReload = useCallback(() => {
    // "Reload" resolves conflict by discarding local edits and reading file content from disk.
    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    setShowConfirmDialog(false);
    showConfirmDialogRef.current = false;
    discardEditsAndContinue();
  }, [discardEditsAndContinue]);

  const handleConflictCancel = useCallback(() => {
    setShowConflictDialog(false);
    showConflictDialogRef.current = false;
    conflictContinuationRef.current = null;
    pendingActionRef.current = null;
  }, []);

  useEffect(() => {
    editingRef.current = editing;
    dirtyRef.current = editor.dirty;
    showConfirmDialogRef.current = showConfirmDialog;
    showConflictDialogRef.current = showConflictDialog;
  }, [editing, editor.dirty, showConfirmDialog, showConflictDialog]);

  // Guarded versions that don't depend on later declarations
  const guardedOpenFile = useCallback(() => {
    guardAction({ kind: "open-file-dialog" });
  }, [guardAction]);

  const guardedOpenFilePath = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) {
        guardAction({ kind: "open-file-path", path: paths[0] });
      }
    },
    [guardAction],
  );

  // Tauri window close guard: prevent accidental app close with unsaved edits.
  // Register once and read live state from refs to avoid stale closures.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let active = true;
    let unlisten: (() => void) | null = null;

    const handleCloseRequest = (event: { preventDefault: () => void }) => {
      if (isProgrammaticCloseRef.current) {
        isProgrammaticCloseRef.current = false;
        return;
      }

      // Allow native OS close behavior when there are no unsaved edits.
      if (!editingRef.current || !dirtyRef.current) {
        return;
      }

      event.preventDefault();

      // Keep unsaved-change protection strict while the confirm dialog is open.
      if (showConfirmDialogRef.current || showConflictDialogRef.current) {
        return;
      }

      pendingActionRef.current = { kind: "close-window" };
      showConfirmDialogRef.current = true;
      setShowConfirmDialog(true);
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
  }, []);

  // beforeunload: warn if dirty
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editing && editor.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [editing, editor.dirty]);

  // Exit edit mode when content changes (new file opened externally)
  useEffect(() => {
    if (editing && !content) {
      exitEditMode();
    }
  }, [content, editing, exitEditMode]);

  const openSearch = useCallback(() => {
    if (!content || editing) return;
    setSearchVisible(true);
  }, [content, editing]);

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

  // Reading progress bar — update via ref to avoid state churn on scroll
  useEffect(() => {
    const scrollEl = mainScrollRef.current;
    if (!scrollEl) return;

    let frame: number | null = null;

    const updateProgressNow = () => {
      const bar = progressBarRef.current;
      if (!bar) return;
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const max = scrollHeight - clientHeight;
      const pct = max > 0 ? Math.max(0, Math.min(scrollTop / max, 1)) : 0;
      bar.style.transform = `scaleX(${pct})`;
      const textEl = progressTextRef.current;
      const roundedPct = Math.round(pct * 100);
      if (textEl && roundedPct !== progressPctRef.current) {
        progressPctRef.current = roundedPct;
        textEl.textContent = `${roundedPct}%`;
      }
    };

    const scheduleProgressUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        updateProgressNow();
      });
    };

    scrollEl.addEventListener("scroll", scheduleProgressUpdate, { passive: true });
    scheduleProgressUpdate();
    return () => {
      scrollEl.removeEventListener("scroll", scheduleProgressUpdate);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [content]);

  // TOC: extract headings from rendered DOM, track active heading
  const headings = useHeadings(contentRef, content);
  const activeHeadingId = useHeadingObserver(headings, mainScrollRef, {
    syncIntervalMs: tocVisible && !focusMode ? 100 : 250,
    useIntersectionObserver: tocVisible && !focusMode,
  });
  const parsedFountain = useMemo(() => {
    if (fileType !== "fountain" || !content) return null;
    return parseFountain(content);
  }, [content, fileType]);

  const characters = useMemo(() => {
    if (!parsedFountain) return [];
    return extractCharacters(parsedFountain);
  }, [parsedFountain]);

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
    if (!settings.sceneLensEnabled) return [];
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
      if (!SCENE_HEADING_RE.test(heading.text)) continue;
      fallbackScenes.push({
        id: `scene-fallback-${heading.id}`,
        label: heading.text,
        line: i + 1,
        headingId: heading.id,
      });
    }
    return fallbackScenes;
  }, [settings.sceneLensEnabled, workspaceInsights.scenes, headings, parsedFountain]);

  // Pending scroll: set before opening a file, consumed after headings render
  const pendingScrollRef = useRef<string | null>(null);
  const openAttemptIdRef = useRef(0);

  // Session restore: reopen last file + scroll position on startup
  const handleSessionRestore = useCallback(
    async (session: { filePath: string; headingId: string | null }) => {
      const openAttemptId = ++openAttemptIdRef.current;
      pendingScrollRef.current = session.headingId;
      const ok = await openFilePath(session.filePath, "user");
      if (!ok) {
        if (openAttemptIdRef.current === openAttemptId) {
          pendingScrollRef.current = null;
        }
        dismissError();
      }
    },
    [openFilePath, dismissError],
  );

  const { restored: sessionRestored } = useSessionRestore({
    filePath,
    activeHeadingId,
    onRestore: handleSessionRestore,
  });

  // First-run: show welcome sample file on first launch
  useEffect(() => {
    // Wait for both startup signals
    if (!sessionRestored || !recentFilesLoaded) return;
    // Skip if something already loaded
    if (content || filePath || loading) return;
    if (recentFiles.length > 0) return;

    let cancelled = false;
    storeGet<boolean>("hasSeenWelcome").then((seen) => {
      if (cancelled || seen) return;
      setVirtualContent(welcomeContent, "Welcome to Binder.md");
      storeSet("hasSeenWelcome", true);
    });
    return () => { cancelled = true; };
  }, [sessionRestored, recentFilesLoaded, content, filePath, loading, recentFiles.length, setVirtualContent]);

  // Scroll to pending heading after headings are extracted from DOM
  useEffect(() => {
    const targetId = pendingScrollRef.current;
    if (!targetId || headings.length === 0) return;

    const exists = headings.some((h) => h.id === targetId);
    if (exists) {
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: "auto" });
      }
    } else {
      toast(`Heading "${targetId}" not found — it may have been renamed or removed.`, "error");
    }
    pendingScrollRef.current = null;
  }, [headings, toast]);

  // Debounced save of scroll position per file for recent-files memory
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!filePath || !activeHeadingId) return;

    if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = setTimeout(() => {
      updateScrollPosition(filePath, activeHeadingId);
    }, 1500);

    return () => {
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    };
  }, [filePath, activeHeadingId, updateScrollPosition]);

  // Track current position for navigation history (avoids stale closures in handlers)
  const currentPositionRef = useRef<{ filePath: string | null; headingId: string | null }>({
    filePath: null,
    headingId: null,
  });
  useEffect(() => {
    currentPositionRef.current = { filePath, headingId: activeHeadingId };
  }, [filePath, activeHeadingId]);

  // File watcher: auto-reload on external changes
  const handleFileChanged = useCallback((changedPath: string) => {
    if (userOpenInFlight) return;
    if (presentationMode) {
      presentationDeferredReloadRef.current = true;
      return;
    }
    const currentPath = currentPositionRef.current.filePath;
    if (!currentPath) return;

    const changedPathKey = toPathIdentityKey(changedPath);
    const currentPathKey = toPathIdentityKey(currentPath);
    if (!changedPathKey || changedPathKey !== currentPathKey) return;

    pendingScrollRef.current = currentPositionRef.current.headingId;
    void openFilePath(currentPath, "watcher");
  }, [openFilePath, userOpenInFlight, presentationMode]);

  useFileWatcher({
    filePath,
    isEditing: editing,
    onFileChanged: handleFileChanged,
  });

  // Annotations: highlight handler
  const handleHighlight = useCallback((anchor: TextAnchor, color: HighlightColor, headingId: string | null) => {
    addHighlight(anchor, color, headingId);
  }, [addHighlight]);

  // Apply annotation highlights to DOM after content renders
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !content) return;

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
  }, [content, highlights]);

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
    const el = document.getElementById(headingId);
    if (el) {
      el.scrollIntoView({ behavior: motionScrollBehavior, block: "start" });
    }
  }, [motionScrollBehavior]);

  // Navigate to a relative .md link
  const handleNavigateToFile = useCallback(
    async (path: string, anchor: string | null) => {
      // Same-file shortcut: skip re-reading and scroll directly
      if (filePath && toPathIdentityKey(path) === toPathIdentityKey(filePath)) {
        if (anchor) {
          const el = document.getElementById(anchor);
          if (el) {
            el.scrollIntoView({ behavior: "auto" });
          } else {
            toast(`Heading "${anchor}" not found in this document`, "error");
          }
        }
        return;
      }

      const pos = currentPositionRef.current;
      const openAttemptId = ++openAttemptIdRef.current;
      pendingScrollRef.current = anchor;
      const ok = await openFilePath(path, "user");
      if (ok) {
        if (pos.filePath) {
          pushEntry({ filePath: pos.filePath, headingId: pos.headingId });
        }
      } else {
        if (openAttemptIdRef.current === openAttemptId) {
          pendingScrollRef.current = null;
        }
      }
    },
    [filePath, pushEntry, openFilePath, toast],
  );

  const handleGoBack = useCallback(async () => {
    const entry = peekBack();
    if (!entry) return;
    const pos = currentPositionRef.current;
    if (!pos.filePath) return;
    const openAttemptId = ++openAttemptIdRef.current;
    pendingScrollRef.current = entry.headingId;
    const ok = await openFilePath(entry.filePath, "user");
    if (ok) {
      commitBack({ filePath: pos.filePath, headingId: pos.headingId });
    } else {
      if (openAttemptIdRef.current === openAttemptId) {
        pendingScrollRef.current = null;
      }
    }
  }, [peekBack, commitBack, openFilePath]);

  const handleGoForward = useCallback(async () => {
    const entry = peekForward();
    if (!entry) return;
    const pos = currentPositionRef.current;
    if (!pos.filePath) return;
    const openAttemptId = ++openAttemptIdRef.current;
    pendingScrollRef.current = entry.headingId;
    const ok = await openFilePath(entry.filePath, "user");
    if (ok) {
      commitForward({ filePath: pos.filePath, headingId: pos.headingId });
    } else {
      if (openAttemptIdRef.current === openAttemptId) {
        pendingScrollRef.current = null;
      }
    }
  }, [peekForward, commitForward, openFilePath]);

  // Update window title with current filename
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const title = fileName ? `${fileName} — Binder` : "Binder";
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
        if (savedHeading && savedHeading !== activeHeadingId) {
          const node = document.getElementById(savedHeading);
          if (node) {
            node.scrollIntoView({ behavior: motionScrollBehavior, block: "start" });
          }
        }
        return;
      }

      const openAttemptId = ++openAttemptIdRef.current;
      if (savedHeading) {
        pendingScrollRef.current = savedHeading;
      }
      const ok = await openFilePath(path, "user");
      if (!ok) {
        if (openAttemptIdRef.current === openAttemptId) {
          pendingScrollRef.current = null;
        }
      }
    },
    [activeHeadingId, filePath, getScrollPosition, motionScrollBehavior, openFilePath],
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
      try { localStorage.setItem("binder-sidebar-visible", String(next)); } catch { /* noop */ }
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
    if (!content || editing || focusMode || fileType === "fountain") return;
    const slides = parseSlides(content);
    if (slides.length === 0) return;
    slidesRef.current = slides;
    setCurrentSlide(0);
    setPresentationMode(true);
  }, [content, editing, focusMode, fileType]);

  const exitPresentation = useCallback(() => {
    setPresentationMode(false);
    setCurrentSlide(0);
    slidesRef.current = [];
    if (presentationDeferredReloadRef.current) {
      presentationDeferredReloadRef.current = false;
      const currentPath = currentPositionRef.current.filePath;
      if (currentPath) {
        pendingScrollRef.current = currentPositionRef.current.headingId;
        void openFilePath(currentPath, "watcher");
      }
    }
  }, [openFilePath]);

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

  executePendingActionRef.current = (action) => {
    switch (action.kind) {
      case "close-window": {
        const appWindow = getCurrentWindow();
        isProgrammaticCloseRef.current = true;
        void appWindow.close().catch((err) => {
          isProgrammaticCloseRef.current = false;
          console.error("[close-guard] Programmatic close failed:", err);
        });
        return;
      }
      case "open-file-dialog":
        void openFile();
        return;
      case "open-file-path":
        void openFilePath(action.path, "user");
        return;
      case "open-recent":
        void handleOpenRecent(action.path);
        return;
      case "go-back":
        void handleGoBack();
        return;
      case "go-forward":
        void handleGoForward();
        return;
      case "navigate":
        void handleNavigateToFile(action.path, action.anchor);
        return;
      case "open-workspace-hit":
        if (action.path === filePath) {
          if (action.headingId) {
            const node = document.getElementById(action.headingId);
            if (node) {
              node.scrollIntoView({ behavior: motionScrollBehavior, block: "start" });
            }
          }
          return;
        }
        void handleNavigateToFile(action.path, action.headingId);
        return;
    }
  };

  const openScene = useCallback((scene: SceneItem) => {
    if (!scene.headingId) return;
    const node = document.getElementById(scene.headingId);
    if (node) node.scrollIntoView({ behavior: motionScrollBehavior, block: "start" });
  }, [motionScrollBehavior]);

  const navigateScene = useCallback((direction: -1 | 1) => {
    if (sceneItems.length === 0) return;
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
    const node = document.getElementById(target.headingId);
    if (node) node.scrollIntoView({ behavior: motionScrollBehavior, block: "start" });
  }, [sceneItems, activeHeadingId, motionScrollBehavior]);

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
    if (showConfirmDialog || showConflictDialog) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const target = e.target as HTMLElement | null;
    const inInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

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

    // Ctrl+S: save in edit mode (must run before inInput bail-out)
    if (ctrl && key === "s") {
      e.preventDefault();
      if (editing) handleSave();
      return;
    }

    // Ctrl+E: toggle edit mode (must run before inInput bail-out)
    if (ctrl && key === "e") {
      e.preventDefault();
      if (content) toggleEditMode();
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

    // Escape in editor textarea
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
      if (activeHeadingId && content && !editing) {
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
      if (content && !editing) {
        handlePrint();
      }
    } else if (key === "escape" && searchVisible) {
      e.preventDefault();
      closeSearch();
    } else if (ctrl && key === "o") {
      e.preventDefault();
      guardedOpenFile();
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
    } else if (ctrl && e.shiftKey && key === "t") {
      e.preventDefault();
      cycleTheme();
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
      if (content && !editing && !focusMode && fileType !== "fountain") {
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
          onToggleEdit={toggleEditMode}
          onSave={handleSave}
          readingStats={readingStats}
          progressTextRef={progressTextRef}
          onToggleAnnotations={toggleAnnotationsPanel}
          hasAnnotations={highlights.length > 0 || bookmarks.length > 0}
          onPrint={handlePrint}
          onPresent={enterPresentation}
          fileType={fileType}
        />
      )}

      {content && !focusMode && !printing && !presentationMode && (
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

          {content && editing && editor.buffer !== null ? (
            <MarkdownEditor
              buffer={editor.buffer}
              settings={settings}
              saving={editor.saving}
              saveError={editor.saveError}
              onBufferChange={editor.updateBuffer}
              onDismissSaveError={editor.dismissSaveError}
            />
          ) : content ? (
            fileType === "fountain" ? (
              <FountainRenderer
                content={content}
                filePath={filePath || ""}
                settings={settings}
                contentRef={contentRef}
                focusedCharacter={focusedCharacter}
              />
            ) : (
              <MarkdownRenderer
                content={content}
                filePath={filePath || ""}
                settings={settings}
                contentRef={contentRef}
                onNavigateToFile={guardedNavigateToFile}
              />
            )
          ) : (
            <EmptyState onOpenFile={guardedOpenFile} recentFiles={recentFiles} onOpenRecent={guardedOpenRecent} />
          )}
        </main>

        <TableOfContents
          visible={tocVisible && !focusMode && !editing && !presentationMode}
          headings={headings}
          activeId={activeHeadingId}
          scenes={sceneItems}
          characters={characters}
          focusedCharacter={focusedCharacter}
          onToggleCharacterFocus={handleToggleCharacterFocus}
          isBookmarked={isBookmarked}
          onToggleBookmark={toggleBookmark}
          onOpenScene={openScene}
        />

        <AnnotationsPanel
          visible={annotationsPanelVisible && !focusMode && !editing && !presentationMode}
          highlights={highlights}
          bookmarks={bookmarks}
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
            onClose={closeReaderControls}
          />
        )}
      </div>

      {!editing && content && !presentationMode && (
        <HighlightToolbar
          contentRef={contentRef}
          isEditing={editing}
          activeHeadingId={activeHeadingId}
          onHighlight={handleHighlight}
        />
      )}
      {focusMode && <FocusBar fileName={fileName} onExit={exitFocusMode} readingStats={readingStats} progressTextRef={progressTextRef} reducedEffects={settings.reducedEffects} />}
      {focusedCharacter && fileType === "fountain" && !focusMode && !presentationMode && (
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
            title="Exit character focus (Esc)"
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
        message={`"${fileName || "This file"}" was modified outside Binder while you were editing.`}
        confirmLabel="Reload"
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
