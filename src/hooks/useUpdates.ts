import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { storeGet, storeSet } from "../lib/store";
import { detectShortcutPlatform } from "../lib/shortcut-labels";
import { useOneTimeHint } from "./useOneTimeHint";
import {
  ASKED_KEY,
  ASKED_LOCAL_KEY,
  AUTO_CHECK_KEY,
  LAUNCH_COUNT_KEY,
  RELEASES_URL,
  UPDATE_PROGRESS_EVENT,
  checkForUpdate,
  downloadPercent,
  downloadUpdate,
  installFailureMessage,
  shouldAskAboutUpdates,
} from "../lib/updates";
import type { UpdateCheck } from "../lib/updates";

type AvailableUpdate = Extract<UpdateCheck, { kind: "available" }>;

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | Extract<UpdateCheck, { kind: "up-to-date" }>
  | AvailableUpdate
  | { kind: "downloading"; current: string; version: string; percent: number | null };

const IDLE: UpdatePhase = { kind: "idle" };
const AUTOMATIC_CHECK_DELAY_MS = 10_000;
// Native code allows one automatic check a day. Asking more often than that
// keeps a long-running session from drifting past a day between checks.
const AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface ProgressPayload {
  downloaded: number;
  total: number | null;
}

interface UseUpdatesArgs {
  requestRestartForUpdate: () => "accepted" | "busy";
  notifyError: (message: string) => void;
}

function isBusy(error: unknown): boolean {
  return (error as { kind?: string } | null)?.kind === "busy";
}

/** Update checks and installs. macOS only; elsewhere it stays idle and silent. */
export function useUpdates(args: UseUpdatesArgs) {
  const macos = detectShortcutPlatform() === "macos";
  const [phase, setPhaseState] = useState<UpdatePhase>(IDLE);
  const [problem, setProblem] = useState<string | null>(null);
  const [dialogOpen, setDialogOpenState] = useState(false);
  const [autoCheck, setAutoCheckState] = useState(false);
  const [previousLaunchCount, setPreviousLaunchCount] = useState<number | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { visible: questionVisible, dismiss: dismissQuestion } = useOneTimeHint(ASKED_KEY, ASKED_LOCAL_KEY);

  // Callbacks decide from these refs, which change with the state rather than
  // on the next render, so two quick clicks cannot both start an operation.
  const phaseRef = useRef<UpdatePhase>(IDLE);
  const dialogOpenRef = useRef(false);
  const autoCheckRef = useRef(false);
  const autoCheckChangedRef = useRef(false);
  const activeRef = useRef(false);
  const argsRef = useRef(args);
  argsRef.current = args;

  const setPhase = useCallback((next: UpdatePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const showDialog = useCallback((open: boolean) => {
    dialogOpenRef.current = open;
    setDialogOpenState(open);
  }, []);
  const applyAutoCheck = useCallback((value: boolean) => {
    autoCheckRef.current = value;
    setAutoCheckState(value);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  // Read the saved settings once and count this launch. Nothing here talks to
  // the network; the decision to check stays in native code.
  useEffect(() => {
    if (!macos) return;
    void (async () => {
      const savedAutoCheck = await storeGet<boolean>(AUTO_CHECK_KEY);
      if (!activeRef.current) return;
      // A choice made while this read was pending is newer than its answer.
      if (!autoCheckChangedRef.current) applyAutoCheck(savedAutoCheck === true);
      const savedLaunchCount = await storeGet<number>(LAUNCH_COUNT_KEY);
      if (!activeRef.current) return;
      const previous = typeof savedLaunchCount === "number" ? savedLaunchCount : 0;
      setPreviousLaunchCount(previous);
      await storeSet(LAUNCH_COUNT_KEY, previous + 1);
      if (activeRef.current) setSettingsLoaded(true);
    })();
  }, [macos, applyAutoCheck]);

  // Automatic checks never open the dialog and never report a problem.
  const runAutomaticCheck = useCallback(() => {
    const before = phaseRef.current.kind;
    if (before !== "idle" && before !== "up-to-date") return;
    void checkForUpdate(false)
      .then((result) => {
        if (!activeRef.current || result.kind !== "available") return;
        const now = phaseRef.current.kind;
        if (now === "idle" || now === "up-to-date") setPhase(result);
      })
      .catch(() => {});
  }, [setPhase]);

  useEffect(() => {
    if (!macos) return;
    const timeout = window.setTimeout(runAutomaticCheck, AUTOMATIC_CHECK_DELAY_MS);
    const interval = window.setInterval(runAutomaticCheck, AUTOMATIC_CHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [macos, runAutomaticCheck]);

  const checkNow = useCallback(() => {
    if (!macos) return;
    const before = phaseRef.current.kind;
    if (before === "checking" || before === "downloading") return;
    setProblem(null);
    setPhase({ kind: "checking" });
    void checkForUpdate(true)
      .then((result) => {
        if (!activeRef.current || phaseRef.current.kind !== "checking") return;
        setPhase(result.kind === "skipped" ? IDLE : result);
      })
      .catch((error: unknown) => {
        if (!activeRef.current || phaseRef.current.kind !== "checking") return;
        setPhase(IDLE);
        // Busy means another check is in flight; Check Again stays available.
        if (isBusy(error)) return;
        console.warn("[updates] Check failed:", error);
        setProblem("Couldn't check for updates. Try again later.");
      });
  }, [macos, setPhase]);

  // Check for Updates… always asks again: an update found earlier may have
  // been replaced or withdrawn since. A download in progress is only shown.
  const openDialog = useCallback(() => {
    if (!macos) return;
    showDialog(true);
    checkNow();
  }, [macos, showDialog, checkNow]);

  // The toolbar marker shows the update already found without asking again,
  // so a package downloaded earlier is kept for Install and Restart.
  const showUpdate = useCallback(() => {
    if (!macos) return;
    showDialog(true);
    const now = phaseRef.current.kind;
    if (now !== "available" && now !== "downloading") checkNow();
  }, [macos, showDialog, checkNow]);

  // Closing while a download runs only hides the dialog; the header marker
  // reopens it. A hidden download never restarts the app by itself.
  const closeDialog = useCallback(() => {
    if (!macos) return;
    showDialog(false);
    setProblem(null);
    if (phaseRef.current.kind === "up-to-date") setPhase(IDLE);
  }, [macos, showDialog, setPhase]);

  const saveAutoCheck = useCallback(async (value: boolean): Promise<boolean> => {
    const previous = autoCheckRef.current;
    autoCheckChangedRef.current = true;
    applyAutoCheck(value);
    dismissQuestion();
    if (await storeSet(AUTO_CHECK_KEY, value)) return true;
    // Settings keeps an unsaved value in memory, and the native gate reads
    // it. Put the old value back so memory, disk and the checkbox agree.
    void storeSet(AUTO_CHECK_KEY, previous);
    if (activeRef.current) applyAutoCheck(previous);
    argsRef.current.notifyError("Couldn't save that choice. Try again.");
    return false;
  }, [applyAutoCheck, dismissQuestion]);

  const setAutoCheck = useCallback((value: boolean) => {
    if (macos) void saveAutoCheck(value);
  }, [macos, saveAutoCheck]);

  const answerQuestion = useCallback((turnOn: boolean) => {
    if (!macos) return;
    if (!turnOn) {
      dismissQuestion();
      return;
    }
    // The native gate reads the saved setting, so the save comes first.
    void saveAutoCheck(true).then((saved) => {
      if (saved && activeRef.current) runAutomaticCheck();
    });
  }, [macos, dismissQuestion, saveAutoCheck, runAutomaticCheck]);

  const install = useCallback(() => {
    if (!macos) return;
    const available = phaseRef.current;
    if (available.kind !== "available" || !available.installable) return;
    setProblem(null);
    setPhase({ kind: "downloading", current: available.current, version: available.version, percent: null });
    void (async () => {
      let stopProgress = () => {};
      try {
        stopProgress = await listen<ProgressPayload>(UPDATE_PROGRESS_EVENT, (event) => {
          const now = phaseRef.current;
          if (!activeRef.current || now.kind !== "downloading") return;
          setPhase({ ...now, percent: downloadPercent(event.payload.downloaded, event.payload.total) });
        });
        await downloadUpdate();
      } catch (error) {
        stopProgress();
        if (!activeRef.current) return;
        // The update stays available either way, so the button can be pressed again.
        setPhase(available);
        if (isBusy(error)) return;
        console.warn("[updates] Download failed:", error);
        setProblem("Couldn't download the update. Try again later.");
        showDialog(true);
        return;
      }
      stopProgress();
      if (!activeRef.current) return;
      setPhase(available);
      // The user hid the dialog during the download: keep the package and
      // wait for them to press Install and Restart again.
      if (!dialogOpenRef.current) return;
      showDialog(false);
      if (argsRef.current.requestRestartForUpdate() === "busy") {
        setProblem("Bindars is finishing another file action. Try again in a moment.");
        showDialog(true);
      }
    })();
  }, [macos, setPhase, showDialog]);

  const openDownloadPage = useCallback(() => {
    void openUrl(RELEASES_URL).catch(() => {});
  }, []);

  // The update stays available after a failed install: native code keeps the
  // downloaded package, so trying again does not download it a second time.
  const reportInstallFailure = useCallback((error: unknown) => {
    if (!macos || !activeRef.current) return;
    console.warn("[updates] Install failed:", error);
    setProblem(installFailureMessage(error));
    showDialog(true);
  }, [macos, showDialog]);

  const markerVisible = phase.kind === "available" || phase.kind === "downloading";
  const askVisible = macos && settingsLoaded && questionVisible
    && shouldAskAboutUpdates(previousLaunchCount, autoCheck);

  return {
    /** This platform can check for and install updates from inside the app. */
    supported: macos,
    phase,
    problem,
    dialogOpen,
    autoCheck,
    markerVisible,
    askVisible,
    openDialog,
    showUpdate,
    closeDialog,
    checkNow,
    setAutoCheck,
    answerQuestion,
    install,
    openDownloadPage,
    reportInstallFailure,
  };
}
