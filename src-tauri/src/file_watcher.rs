use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};

use notify::{self, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::document_io::canonicalize_markdown_path;
use crate::file_errors::{run_blocking_file_io, NativeFileError, NativeFileOperation};

const FILE_CHANGED_EVENT: &str = "file-changed";
const FILE_WATCHER_UNAVAILABLE_EVENT: &str = "bindars://file-watcher-unavailable";

struct WatcherState {
    path: PathBuf,
    _watcher: notify::RecommendedWatcher,
    stop_tx: mpsc::Sender<()>,
}

#[derive(Default)]
struct FileWatcherState {
    current: Option<WatcherState>,
    latest_request_id: u64,
    desired_path: Option<PathBuf>,
}

pub(crate) struct FileWatcher(Mutex<FileWatcherState>);

impl FileWatcher {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(FileWatcherState::default()))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileWatcherPathEvent {
    path: String,
}

#[derive(Debug, PartialEq, Eq)]
enum WatcherNotification {
    Changed,
    Unavailable(String),
}

fn classify_watcher_result(
    result: Result<notify::Event, notify::Error>,
    watched_path: &Path,
) -> Option<WatcherNotification> {
    match result {
        Ok(event) => {
            if event.need_rescan() {
                return Some(WatcherNotification::Unavailable(
                    "the watcher backend reported that filesystem events may have been missed"
                        .to_string(),
                ));
            }
            use notify::EventKind;
            let relevant_kind = matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            );
            let relevant_path = event
                .paths
                .iter()
                .any(|path| dunce::simplified(path) == watched_path);
            (relevant_kind && relevant_path).then_some(WatcherNotification::Changed)
        }
        Err(error) => Some(WatcherNotification::Unavailable(error.to_string())),
    }
}

fn emit_watcher_unavailable(app: &tauri::AppHandle, path: &str, detail: &str) {
    log::warn!(
        target: env!("CARGO_CRATE_NAME"),
        "The native document watcher became unavailable: {detail}"
    );
    if let Err(error) = app.emit(
        FILE_WATCHER_UNAVAILABLE_EVENT,
        FileWatcherPathEvent {
            path: path.to_string(),
        },
    ) {
        log::warn!(
            target: env!("CARGO_CRATE_NAME"),
            "Failed to notify the frontend that the document watcher became unavailable: {error}"
        );
    }
}

fn receive_watcher_notifications(
    stop_rx: &mpsc::Receiver<()>,
    event_rx: &mpsc::Receiver<WatcherNotification>,
    debounce_window: std::time::Duration,
    mut emit: impl FnMut(WatcherNotification),
) {
    let idle_poll = std::time::Duration::from_millis(100);
    'notifications: loop {
        if stop_rx.try_recv().is_ok() {
            return;
        }

        match event_rx.recv_timeout(idle_poll) {
            Ok(WatcherNotification::Changed) => {
                let deadline = std::time::Instant::now() + debounce_window;
                loop {
                    if stop_rx.try_recv().is_ok() {
                        return;
                    }
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match event_rx.recv_timeout(remaining) {
                        Ok(WatcherNotification::Changed) => continue,
                        Ok(WatcherNotification::Unavailable(detail)) => {
                            // The fallback read subsumes changes already queued
                            // in this debounce window. Keep receiving because a
                            // rescan notice does not terminate the native watch.
                            emit(WatcherNotification::Unavailable(detail));
                            continue 'notifications;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if stop_rx.try_recv().is_ok() {
                    return;
                }
                emit(WatcherNotification::Changed);
            }
            Ok(WatcherNotification::Unavailable(detail)) => {
                emit(WatcherNotification::Unavailable(detail));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[tauri::command]
pub(crate) async fn watch_file(path: String, app: tauri::AppHandle) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || watch_file_impl(path, app)).await
}

fn watch_file_impl(path: String, app: tauri::AppHandle) -> Result<(), NativeFileError> {
    let state = app.state::<FileWatcher>();
    let requested_path = PathBuf::from(&path);
    let request_id = {
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        begin_watch_request(&mut guard, &requested_path)
    };
    let canonical_path = canonicalize_markdown_path(&requested_path)?;

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (event_tx, event_rx) = mpsc::channel::<WatcherNotification>();

    let watched_path = canonical_path.clone();
    let watched_path_for_event = canonical_path.to_string_lossy().into_owned();
    let mut watcher =
        notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if let Some(notification) = classify_watcher_result(result, &watched_path) {
                let _ = event_tx.send(notification);
            }
        })
        .map_err(|error| {
            NativeFileError::unknown(
                NativeFileOperation::WatchDocument,
                "Bindars could not start watching this document for changes.",
                error.to_string(),
            )
        })?;

    // Watch parent directory for better compatibility with atomic writes.
    let parent = canonical_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::WatchDocument,
            "Cannot determine the document folder.",
        )
    })?;
    watcher
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|error| {
            NativeFileError::unknown(
                NativeFileOperation::WatchDocument,
                "Bindars could not watch this document for changes.",
                error.to_string(),
            )
        })?;

    // Spawn debounce thread: coalesce events within 500ms, then emit.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        receive_watcher_notifications(
            &stop_rx,
            &event_rx,
            std::time::Duration::from_millis(500),
            |notification| match notification {
                WatcherNotification::Changed => {
                    if let Err(error) = app_handle.emit(
                        FILE_CHANGED_EVENT,
                        FileWatcherPathEvent {
                            path: watched_path_for_event.clone(),
                        },
                    ) {
                        log::warn!(
                            target: env!("CARGO_CRATE_NAME"),
                            "Failed to notify the frontend that the document changed: {error}"
                        );
                    }
                }
                WatcherNotification::Unavailable(detail) => {
                    emit_watcher_unavailable(&app_handle, &watched_path_for_event, &detail);
                }
            },
        );
    });

    let old_watcher = {
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        if !should_install_watch_request(&guard, request_id, &requested_path) {
            let _ = stop_tx.send(());
            return Ok(());
        }

        // Install only after this request is still known to be latest. The old
        // native watcher is stopped and dropped after releasing the state lock.
        let old = guard.current.take();
        guard.current = Some(WatcherState {
            path: canonical_path,
            _watcher: watcher,
            stop_tx,
        });
        old
    };
    if let Some(old) = old_watcher {
        let _ = old.stop_tx.send(());
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn unwatch_file(
    path: String,
    app: tauri::AppHandle,
) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || {
        unwatch_file_impl(path, app);
        Ok(())
    })
    .await
}

fn unwatch_file_impl(path: String, app: tauri::AppHandle) {
    let state = app.state::<FileWatcher>();
    let requested_path = PathBuf::from(path);
    let old_watcher = {
        let mut guard = state.0.lock().unwrap_or_else(|error| error.into_inner());
        clear_desired_watch_path_if_requested(&mut guard, &requested_path);
        if !should_unwatch_path(
            guard.current.as_ref().map(|watcher| watcher.path.as_path()),
            &requested_path,
        ) {
            return;
        }
        guard.current.take()
    };
    if let Some(old) = old_watcher {
        let _ = old.stop_tx.send(());
    }
}

fn path_identity(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}

fn begin_watch_request(state: &mut FileWatcherState, requested_path: &Path) -> u64 {
    state.latest_request_id = state.latest_request_id.wrapping_add(1);
    state.desired_path = Some(path_identity(requested_path));
    state.latest_request_id
}

fn should_install_watch_request(
    state: &FileWatcherState,
    request_id: u64,
    requested_path: &Path,
) -> bool {
    state.latest_request_id == request_id
        && state
            .desired_path
            .as_deref()
            .is_some_and(|desired_path| desired_path == path_identity(requested_path))
}

fn should_clear_desired_watch_path(state: &FileWatcherState, requested_path: &Path) -> bool {
    state
        .desired_path
        .as_deref()
        .is_some_and(|desired_path| desired_path == path_identity(requested_path))
}

fn clear_desired_watch_path_if_requested(
    state: &mut FileWatcherState,
    requested_path: &Path,
) -> bool {
    if !should_clear_desired_watch_path(state, requested_path) {
        return false;
    }

    state.latest_request_id = state.latest_request_id.wrapping_add(1);
    state.desired_path = None;
    true
}

fn should_unwatch_path(current_path: Option<&Path>, requested_path: &Path) -> bool {
    let Some(current_path) = current_path else {
        return false;
    };

    path_identity(requested_path) == current_path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_callback_errors_become_unavailable_notifications() {
        let watched_path = Path::new("/tmp/bindars-watch-current.md");
        let notification = classify_watcher_result(
            Err(notify::Error::generic("provider watcher dropped")),
            watched_path,
        );

        assert_eq!(
            notification,
            Some(WatcherNotification::Unavailable(
                "provider watcher dropped".to_string()
            ))
        );
    }

    #[test]
    fn watcher_rescan_flags_become_unavailable_notifications() {
        use notify::event::Flag;
        use notify::EventKind;

        let watched_path = Path::new("/tmp/bindars-watch-current.md");
        let event = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);

        assert!(matches!(
            classify_watcher_result(Ok(event), watched_path),
            Some(WatcherNotification::Unavailable(detail))
                if detail.contains("events may have been missed")
        ));
    }

    #[test]
    fn watcher_health_inside_debounce_does_not_terminate_later_change_delivery() {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let (emission_tx, emission_rx) = mpsc::channel();
        event_tx
            .send(WatcherNotification::Changed)
            .expect("queue initial change");
        event_tx
            .send(WatcherNotification::Unavailable(
                "events may have been missed".to_string(),
            ))
            .expect("queue health notification");
        event_tx
            .send(WatcherNotification::Changed)
            .expect("queue later change");

        let receiver_stop_tx = stop_tx.clone();
        let receiver = std::thread::spawn(move || {
            let mut emission_count = 0;
            receive_watcher_notifications(
                &stop_rx,
                &event_rx,
                std::time::Duration::from_millis(10),
                |notification| {
                    emission_tx
                        .send(notification)
                        .expect("forward watcher notification");
                    emission_count += 1;
                    if emission_count == 2 {
                        let _ = receiver_stop_tx.send(());
                    }
                },
            );
        });

        let mut emissions = Vec::new();
        let mut receive_error = None;
        for _ in 0..2 {
            match emission_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(notification) => emissions.push(notification),
                Err(error) => {
                    receive_error = Some(error);
                    break;
                }
            }
        }
        let _ = stop_tx.send(());
        receiver.join().expect("watcher receiver thread exits");
        if let Some(error) = receive_error {
            panic!("watcher receiver did not emit the complete sequence: {error}");
        }

        assert_eq!(
            emissions,
            [
                WatcherNotification::Unavailable("events may have been missed".to_string()),
                WatcherNotification::Changed,
            ]
        );
    }

    #[test]
    fn should_unwatch_path_matches_current_watcher_path() {
        let current = Path::new("/tmp/bindars-watch-current.md");
        let requested = Path::new("/tmp/bindars-watch-current.md");

        assert!(should_unwatch_path(Some(current), requested));
    }

    #[test]
    fn should_unwatch_path_rejects_different_path() {
        let current = Path::new("/tmp/bindars-watch-current.md");
        let requested = Path::new("/tmp/bindars-watch-other.md");

        assert!(!should_unwatch_path(Some(current), requested));
    }

    #[test]
    fn should_unwatch_path_is_noop_without_current_watcher() {
        let requested = Path::new("/tmp/bindars-watch-current.md");

        assert!(!should_unwatch_path(None, requested));
    }

    #[test]
    fn should_install_watch_request_rejects_stale_request() {
        let mut state = FileWatcherState::default();
        let first = Path::new("/tmp/bindars-watch-a.md");
        let second = Path::new("/tmp/bindars-watch-b.md");

        let first_request = begin_watch_request(&mut state, first);
        let second_request = begin_watch_request(&mut state, second);

        assert!(!should_install_watch_request(&state, first_request, first));
        assert!(should_install_watch_request(&state, second_request, second));
    }

    #[test]
    fn unwatch_for_desired_path_invalidates_pending_watch_request() {
        let mut state = FileWatcherState::default();
        let requested = Path::new("/tmp/bindars-watch-current.md");
        let request = begin_watch_request(&mut state, requested);

        assert!(clear_desired_watch_path_if_requested(&mut state, requested));

        assert!(!should_install_watch_request(&state, request, requested));
    }

    #[test]
    fn unwatch_for_different_path_does_not_invalidate_pending_watch_request() {
        let mut state = FileWatcherState::default();
        let requested = Path::new("/tmp/bindars-watch-current.md");
        let other = Path::new("/tmp/bindars-watch-other.md");
        let request = begin_watch_request(&mut state, requested);

        assert!(!clear_desired_watch_path_if_requested(&mut state, other));

        assert!(should_install_watch_request(&state, request, requested));
    }
}
