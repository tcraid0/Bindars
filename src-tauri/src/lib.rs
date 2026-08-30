use base64::{engine::general_purpose::STANDARD, Engine as _};
use notify::{self, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use walkdir::WalkDir;

mod snapshots;
#[cfg(test)]
mod test_support;

use snapshots::{
    clear_snapshot_history, get_snapshot_storage_stats, list_document_snapshots,
    list_snapshot_drafts, read_document_snapshot, retire_snapshot_draft, write_document_snapshot,
};

#[cfg(target_os = "macos")]
const NATIVE_OPEN_AVAILABLE_EVENT: &str = "bindars://native-open-available";

#[cfg(target_os = "macos")]
const NATIVE_QUIT_REQUESTED_EVENT: &str = "bindars://quit-requested";

/// Identifier of the custom macOS Quit menu item that routes through the
/// frontend unsaved-change guard instead of AppKit's immediate termination.
#[cfg(target_os = "macos")]
const QUIT_MENU_ITEM_ID: &str = "bindars-quit";

/// One pending operating-system open request. A newer valid request replaces
/// the older one until the frontend atomically takes it.
#[derive(Default)]
struct PendingOpenPath(Mutex<Option<PathBuf>>);

impl PendingOpenPath {
    fn replace_if_supported(&self, path: PathBuf) -> bool {
        if !is_markdown_path(&path) {
            return false;
        }
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(path);
        true
    }

    fn take(&self) -> Option<PathBuf> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

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

struct FileWatcher(Mutex<FileWatcherState>);

const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
const MAX_MARKDOWN_SIZE_MIB: u64 = MAX_MARKDOWN_BYTES / (1024 * 1024);
const MAX_EXPORT_HTML_BYTES: u64 = 30 * 1024 * 1024;
const MAX_EXPORT_HTML_SIZE_MIB: u64 = MAX_EXPORT_HTML_BYTES / (1024 * 1024);
const MAX_EXPORT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_EXPORT_IMAGE_SIZE_MIB: u64 = MAX_EXPORT_IMAGE_BYTES / (1024 * 1024);
const DEFAULT_WORKSPACE_MAX_FILES: usize = 5_000;
const ABSOLUTE_WORKSPACE_MAX_FILES: usize = 20_000;
const MAX_WORKSPACE_DEPTH: usize = 32;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileMeta {
    path: String,
    rel_path: String,
    name: String,
    mtime_ms: u64,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceListResult {
    files: Vec<WorkspaceFileMeta>,
    skipped_count: usize,
    limit_hit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFileResult {
    canonical_path: String,
    name: String,
    content: String,
    revision: FileRevision,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileChangedEvent {
    path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileRevision {
    mtime_ms: u64,
    size: u64,
    content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConditionalWriteResult {
    conflict: bool,
    current_revision: FileRevision,
    canonical_path: String,
    name: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum NativeFileErrorCategory {
    NotFound,
    PermissionDenied,
    ReadOnly,
    ResourceUnavailable,
    InvalidInput,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum NativeFileOperation {
    FileTask,
    ResolveDocument,
    InspectDocument,
    OpenDocument,
    ReadDocument,
    DecodeDocument,
    ValidateDocument,
    CheckRevision,
    InspectSavedDocument,
    InspectWriteTarget,
    ResolveWriteParent,
    InspectWriteParent,
    SaveDocument,
    CreateTemporaryFile,
    WriteTemporaryFile,
    PreservePermissions,
    SyncTemporaryFile,
    ReplaceFile,
    ExportFile,
    ResolveWorkspace,
    InspectWorkspace,
    ResolveImage,
    InspectImage,
    ValidateImage,
    ReadImage,
    WatchDocument,
    OpenExternally,
    SaveRecoveryData,
    AccessRecoveryData,
}

impl NativeFileOperation {
    fn description(self) -> &'static str {
        match self {
            Self::FileTask => "complete the file operation",
            Self::ResolveDocument => "locate the document",
            Self::InspectDocument => "inspect the document",
            Self::OpenDocument => "open the document",
            Self::ReadDocument => "read the document",
            Self::DecodeDocument => "decode the document",
            Self::ValidateDocument => "validate the document",
            Self::CheckRevision => "check the document revision",
            Self::InspectSavedDocument => "inspect the saved document",
            Self::InspectWriteTarget => "inspect the write target",
            Self::ResolveWriteParent => "locate the destination folder",
            Self::InspectWriteParent => "inspect the destination folder",
            Self::SaveDocument => "save the document",
            Self::CreateTemporaryFile => "create the temporary file",
            Self::WriteTemporaryFile => "write the temporary file",
            Self::PreservePermissions => "preserve file permissions",
            Self::SyncTemporaryFile => "sync the temporary file",
            Self::ReplaceFile => "replace the destination file",
            Self::ExportFile => "export the file",
            Self::ResolveWorkspace => "locate the workspace",
            Self::InspectWorkspace => "inspect the workspace",
            Self::ResolveImage => "locate the image",
            Self::InspectImage => "inspect the image",
            Self::ValidateImage => "validate the image",
            Self::ReadImage => "read the image",
            Self::WatchDocument => "watch the document",
            Self::OpenExternally => "open the document with its default application",
            Self::SaveRecoveryData => "save recovery data",
            Self::AccessRecoveryData => "access recovery data",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NativeFileError {
    category: NativeFileErrorCategory,
    operation: NativeFileOperation,
    message: String,
    detail: String,
}

impl NativeFileError {
    fn invalid(operation: NativeFileOperation, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            category: NativeFileErrorCategory::InvalidInput,
            operation,
            detail: message.clone(),
            message,
        }
    }

    fn unknown(
        operation: NativeFileOperation,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            category: NativeFileErrorCategory::Unknown,
            operation,
            message: message.into(),
            detail: detail.into(),
        }
    }

    fn read_only(operation: NativeFileOperation, path: &Path) -> Self {
        Self {
            category: NativeFileErrorCategory::ReadOnly,
            operation,
            message: "This file is read-only and was not changed.".to_string(),
            detail: format!(
                "The destination has no POSIX write bits: {}",
                path.display()
            ),
        }
    }

    fn from_io(operation: NativeFileOperation, path: &Path, error: std::io::Error) -> Self {
        let category = match error.kind() {
            std::io::ErrorKind::NotFound => NativeFileErrorCategory::NotFound,
            std::io::ErrorKind::PermissionDenied => NativeFileErrorCategory::PermissionDenied,
            std::io::ErrorKind::ReadOnlyFilesystem => NativeFileErrorCategory::ReadOnly,
            std::io::ErrorKind::TimedOut => NativeFileErrorCategory::ResourceUnavailable,
            _ => NativeFileErrorCategory::Unknown,
        };
        let message = match (category, operation) {
            (NativeFileErrorCategory::NotFound, NativeFileOperation::ResolveDocument) => {
                "This file is no longer available.".to_string()
            }
            (NativeFileErrorCategory::NotFound, NativeFileOperation::ResolveWorkspace) => {
                "The workspace folder is no longer available.".to_string()
            }
            (NativeFileErrorCategory::PermissionDenied, _) => {
                format!(
                    "Bindars does not have permission to {}.",
                    operation.description()
                )
            }
            (NativeFileErrorCategory::ReadOnly, _) => {
                format!(
                    "The destination is read-only, so Bindars could not {}.",
                    operation.description()
                )
            }
            (NativeFileErrorCategory::ResourceUnavailable, _) => {
                format!(
                    "The resource is temporarily unavailable, so Bindars could not {}.",
                    operation.description()
                )
            }
            _ => format!("Bindars could not {}.", operation.description()),
        };
        Self {
            category,
            operation,
            message,
            detail: format!("{}: {error}", path.display()),
        }
    }

    #[cfg(test)]
    fn contains(&self, needle: &str) -> bool {
        self.message.contains(needle) || self.detail.contains(needle)
    }
}

impl std::fmt::Display for NativeFileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[tauri::command]
fn take_pending_open_path(state: tauri::State<'_, Arc<PendingOpenPath>>) -> Option<String> {
    let path = state.take()?;
    match path.into_os_string().into_string() {
        Ok(path) => Some(path),
        Err(_) => {
            log::warn!("Ignoring a native open path that is not valid UTF-8");
            None
        }
    }
}

async fn run_blocking_file_io<T, F>(task: F) -> Result<T, NativeFileError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, NativeFileError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| {
            NativeFileError::unknown(
                NativeFileOperation::FileTask,
                "Bindars could not complete the file operation.",
                error.to_string(),
            )
        })?
}

#[tauri::command]
async fn read_markdown_file(path: String) -> Result<String, NativeFileError> {
    run_blocking_file_io(move || read_markdown_file_impl(path)).await
}

fn read_markdown_file_impl(path: String) -> Result<String, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    read_markdown_contents(&canonical_path)
}

#[tauri::command]
async fn resolve_markdown_path(path: String) -> Result<String, NativeFileError> {
    run_blocking_file_io(move || resolve_markdown_path_impl(path)).await
}

fn resolve_markdown_path_impl(path: String) -> Result<String, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    Ok(canonical_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_markdown_file(path: String) -> Result<OpenFileResult, NativeFileError> {
    run_blocking_file_io(move || open_markdown_file_impl(path)).await
}

fn open_markdown_file_impl(path: String) -> Result<OpenFileResult, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    let content = read_markdown_contents(&canonical_path)?;
    let revision = read_file_revision(&canonical_path)?;
    let (canonical_path, name) = markdown_file_identity(&canonical_path);

    Ok(OpenFileResult {
        canonical_path,
        name,
        content,
        revision,
    })
}

/// Compatibility write command retained for non-editor writes and tests.
/// Editor save flows should use `write_markdown_file_if_unmodified`.
#[tauri::command]
async fn write_markdown_file(path: String, content: String) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || write_markdown_file_impl(path, content)).await
}

fn write_markdown_file_impl(path: String, content: String) -> Result<(), NativeFileError> {
    let requested_path = PathBuf::from(&path);
    let canonical_path = canonicalize_markdown_write_path(&requested_path)?;

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    write_markdown_contents_atomic(&canonical_path, &content)?;
    Ok(())
}

#[tauri::command]
async fn write_markdown_file_if_unmodified(
    path: String,
    content: String,
    expected_revision: Option<FileRevision>,
    force: Option<bool>,
) -> Result<ConditionalWriteResult, NativeFileError> {
    run_blocking_file_io(move || {
        write_markdown_file_if_unmodified_impl(path, content, expected_revision, force)
    })
    .await
}

fn write_markdown_file_if_unmodified_impl(
    path: String,
    content: String,
    expected_revision: Option<FileRevision>,
    force: Option<bool>,
) -> Result<ConditionalWriteResult, NativeFileError> {
    let requested_path = PathBuf::from(&path);

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    let force_save = force.unwrap_or(false);
    if force_save {
        let write_path = resolve_markdown_write_target(&requested_path)?;
        write_markdown_contents_atomic(&write_path, &content)?;
        return successful_write_result(&write_path, &content);
    }

    let canonical_path = canonicalize_markdown_write_path(&requested_path)?;
    let current_revision = read_file_revision(&canonical_path)?;
    let expected = expected_revision.ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::CheckRevision,
            "Missing expected revision for conditional write.",
        )
    })?;
    if expected != current_revision {
        return Ok(conditional_write_result(
            &canonical_path,
            true,
            current_revision,
        ));
    }

    write_markdown_contents_atomic(&canonical_path, &content)?;
    successful_write_result(&canonical_path, &content)
}

#[tauri::command]
async fn export_html_file(path: String, content: String) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || export_html_file_impl(path, content)).await
}

fn export_html_file_impl(path: String, content: String) -> Result<(), NativeFileError> {
    let requested_path = PathBuf::from(&path);

    // Only allow .html extension for export
    match requested_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") => {}
        _ => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::ExportFile,
                "Export file must have .html or .htm extension.",
            ));
        }
    }

    if content.len() as u64 > MAX_EXPORT_HTML_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ExportFile,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_EXPORT_HTML_SIZE_MIB
            ),
        ));
    }

    // Resolve parent directory to ensure it exists
    let parent = requested_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveWriteParent,
            "Cannot determine the destination folder.",
        )
    })?;
    canonicalize_directory_path(
        parent,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;

    write_contents_atomic(
        &requested_path,
        &content,
        ".bindars-export",
        NativeFileOperation::ExportFile,
    )
}

#[tauri::command]
async fn open_markdown_file_externally(
    path: String,
    app: tauri::AppHandle,
) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || {
        let canonical_path = resolve_external_markdown_path_impl(path)?;
        app.opener()
            .open_path(canonical_path, None::<String>)
            .map_err(|error| {
                NativeFileError::unknown(
                    NativeFileOperation::OpenExternally,
                    "Bindars could not open the document with its default application.",
                    error.to_string(),
                )
            })
    })
    .await
}

fn resolve_external_markdown_path_impl(path: String) -> Result<String, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    Ok(canonical_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn read_image_file_as_base64(
    path: String,
    document_path: String,
) -> Result<String, NativeFileError> {
    run_blocking_file_io(move || read_image_file_as_base64_impl(path, document_path)).await
}

fn read_image_file_as_base64_impl(
    path: String,
    document_path: String,
) -> Result<String, NativeFileError> {
    // Both paths come from the WebView, so this narrows file access as defense
    // in depth; it is not an authorization boundary by itself.
    let requested_document_path = PathBuf::from(document_path);
    let canonical_document_path = canonicalize_markdown_path(&requested_document_path)?;
    let document_directory = canonical_document_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveImage,
            "Cannot determine the document folder.",
        )
    })?;

    let requested_path = PathBuf::from(&path);
    let canonical_path = dunce::canonicalize(&requested_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ResolveImage, &requested_path, error)
    })?;
    let metadata = fs::metadata(&canonical_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectImage, &canonical_path, error)
    })?;

    if !metadata.is_file() {
        return Err(NativeFileError::invalid(
            NativeFileOperation::InspectImage,
            "Path is not a file.",
        ));
    }

    if !canonical_path.starts_with(document_directory) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateImage,
            "Image must be inside the open document's folder.",
        ));
    }

    if !is_supported_export_image_path(&canonical_path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateImage,
            "Not a supported image type.",
        ));
    }

    if metadata.len() > MAX_EXPORT_IMAGE_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateImage,
            format!(
                "Image is too large. Maximum supported size is {} MiB.",
                MAX_EXPORT_IMAGE_SIZE_MIB
            ),
        ));
    }

    let bytes = fs::read(&canonical_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ReadImage, &canonical_path, error)
    })?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
async fn export_markdown_file(path: String, content: String) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || export_markdown_file_impl(path, content)).await
}

fn export_markdown_file_impl(path: String, content: String) -> Result<(), NativeFileError> {
    let requested_path = PathBuf::from(&path);

    // Only allow .md/.markdown extension for export
    match requested_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") => {}
        _ => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::ExportFile,
                "Export file must have .md or .markdown extension.",
            ));
        }
    }

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ExportFile,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    // Resolve parent directory to ensure it exists
    let parent = requested_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveWriteParent,
            "Cannot determine the destination folder.",
        )
    })?;
    canonicalize_directory_path(
        parent,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;

    write_contents_atomic(
        &requested_path,
        &content,
        ".bindars-export-md",
        NativeFileOperation::ExportFile,
    )
}

#[tauri::command]
async fn watch_file(path: String, app: tauri::AppHandle) -> Result<(), NativeFileError> {
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
    let (event_tx, event_rx) = mpsc::channel::<()>();

    let watched_path = canonical_path.clone();
    let watched_path_for_event = canonical_path.to_string_lossy().into_owned();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                use notify::EventKind;
                if matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                ) && event
                    .paths
                    .iter()
                    .any(|path| dunce::simplified(path) == watched_path.as_path())
                {
                    let _ = event_tx.send(());
                }
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
        let idle_poll = std::time::Duration::from_millis(100);
        loop {
            if stop_rx.try_recv().is_ok() {
                return;
            }

            match event_rx.recv_timeout(idle_poll) {
                Ok(()) => {
                    let deadline =
                        std::time::Instant::now() + std::time::Duration::from_millis(500);
                    loop {
                        if stop_rx.try_recv().is_ok() {
                            return;
                        }
                        let remaining =
                            deadline.saturating_duration_since(std::time::Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        match event_rx.recv_timeout(remaining) {
                            Ok(()) => continue,
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if stop_rx.try_recv().is_ok() {
                        return;
                    }
                    let _ = app_handle.emit(
                        "file-changed",
                        FileChangedEvent {
                            path: watched_path_for_event.clone(),
                        },
                    );
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
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
async fn unwatch_file(path: String, app: tauri::AppHandle) -> Result<(), NativeFileError> {
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

#[tauri::command]
async fn list_workspace_markdown_files(
    root: String,
    max_files: Option<usize>,
) -> Result<WorkspaceListResult, NativeFileError> {
    run_blocking_file_io(move || list_workspace_markdown_files_impl(root, max_files)).await
}

fn list_workspace_markdown_files_impl(
    root: String,
    max_files: Option<usize>,
) -> Result<WorkspaceListResult, NativeFileError> {
    let root_path = PathBuf::from(root);
    let canonical_root = canonicalize_directory_path(
        &root_path,
        NativeFileOperation::ResolveWorkspace,
        NativeFileOperation::InspectWorkspace,
    )?;
    let limit = max_files
        .unwrap_or(DEFAULT_WORKSPACE_MAX_FILES)
        .min(ABSOLUTE_WORKSPACE_MAX_FILES);

    let mut files_by_rel = BTreeMap::<String, WorkspaceFileMeta>::new();
    let mut skipped_count: usize = 0;
    let mut limit_hit = false;

    for entry_result in WalkDir::new(&canonical_root)
        .follow_links(false)
        .max_depth(MAX_WORKSPACE_DEPTH)
        .into_iter()
    {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };

        let path = entry.path();
        if !entry.file_type().is_file() || !is_markdown_path(path) {
            continue;
        }

        // Resolve to the true target and ensure it stays inside the workspace root.
        let canonical_file = match dunce::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        if !canonical_file.starts_with(&canonical_root) {
            skipped_count += 1;
            continue;
        }

        let metadata = match fs::metadata(&canonical_file) {
            Ok(m) if m.is_file() => m,
            _ => {
                skipped_count += 1;
                continue;
            }
        };

        let rel_path = match canonical_file.strip_prefix(&canonical_root) {
            Ok(rel) => rel,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        let rel_path_string = rel_path.to_string_lossy().into_owned();

        let name = canonical_file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if name.is_empty() {
            skipped_count += 1;
            continue;
        }

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        files_by_rel.insert(
            rel_path_string.clone(),
            WorkspaceFileMeta {
                path: canonical_file.to_string_lossy().into_owned(),
                rel_path: rel_path_string,
                name,
                mtime_ms,
                size: metadata.len(),
            },
        );

        if files_by_rel.len() > limit {
            limit_hit = true;
            if let Some(last_key) = files_by_rel.keys().next_back().cloned() {
                files_by_rel.remove(&last_key);
            }
        }
    }

    let files = files_by_rel.into_values().collect();
    Ok(WorkspaceListResult {
        files,
        skipped_count,
        limit_hit,
    })
}

fn canonicalize_markdown_path(path: &Path) -> Result<PathBuf, NativeFileError> {
    let canonical_path = dunce::canonicalize(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ResolveDocument, path, error)
    })?;
    let metadata = fs::metadata(&canonical_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectDocument, &canonical_path, error)
    })?;

    if !metadata.is_file() {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "The selected document path is not a regular file.",
        ));
    }

    if !is_markdown_path(&canonical_path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Not a supported file type (.md, .markdown, or .fountain).",
        ));
    }

    Ok(canonical_path)
}

fn remap_invalid_write_target_error(error: NativeFileError) -> NativeFileError {
    if error.category == NativeFileErrorCategory::InvalidInput {
        NativeFileError {
            operation: NativeFileOperation::InspectWriteTarget,
            ..error
        }
    } else {
        error
    }
}

fn canonicalize_markdown_write_path(path: &Path) -> Result<PathBuf, NativeFileError> {
    canonicalize_markdown_path(path).map_err(remap_invalid_write_target_error)
}

fn markdown_file_identity(path: &Path) -> (String, String) {
    let canonical_path = path.to_string_lossy().into_owned();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| canonical_path.clone());
    (canonical_path, name)
}

fn conditional_write_result(
    path: &Path,
    conflict: bool,
    current_revision: FileRevision,
) -> ConditionalWriteResult {
    let (canonical_path, name) = markdown_file_identity(path);
    ConditionalWriteResult {
        conflict,
        current_revision,
        canonical_path,
        name,
    }
}

fn canonicalize_directory_path(
    path: &Path,
    resolve_operation: NativeFileOperation,
    inspect_operation: NativeFileOperation,
) -> Result<PathBuf, NativeFileError> {
    let canonical_path = dunce::canonicalize(path)
        .map_err(|error| NativeFileError::from_io(resolve_operation, path, error))?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|error| NativeFileError::from_io(inspect_operation, &canonical_path, error))?;

    if !metadata.is_dir() {
        return Err(NativeFileError::invalid(
            inspect_operation,
            "The selected path must be a directory.",
        ));
    }

    Ok(canonical_path)
}

fn resolve_markdown_write_target(path: &Path) -> Result<PathBuf, NativeFileError> {
    if !is_markdown_path(path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Not a supported file type (.md, .markdown, or .fountain).",
        ));
    }

    let parent = path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveWriteParent,
            "Cannot determine the destination folder.",
        )
    })?;
    let canonical_parent = canonicalize_directory_path(
        parent,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;
    let file_name = path.file_name().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Cannot determine the destination file name.",
        )
    })?;

    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return canonicalize_markdown_path(path).map_err(|error| {
                if error.category == NativeFileErrorCategory::NotFound {
                    NativeFileError::invalid(
                        NativeFileOperation::InspectWriteTarget,
                        "The selected document symlink has no available target. Choose a different Save As location.",
                    )
                } else {
                    remap_invalid_write_target_error(error)
                }
            });
        }
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::InspectWriteTarget,
                "The destination must be a regular file or a supported document symlink.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(NativeFileError::from_io(
                NativeFileOperation::InspectWriteTarget,
                path,
                error,
            ));
        }
    }

    Ok(canonical_parent.join(file_name))
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

fn read_markdown_contents(path: &Path) -> Result<String, NativeFileError> {
    let file = fs::File::open(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::OpenDocument, path, error)
    })?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();

    reader
        .by_ref()
        .take(MAX_MARKDOWN_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::ReadDocument, path, error)
        })?;

    if buffer.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "File is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    String::from_utf8(buffer).map_err(|_| {
        NativeFileError::invalid(
            NativeFileOperation::DecodeDocument,
            "File must be valid UTF-8 text.",
        )
    })
}

fn modified_time_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn stable_hash_hex(bytes: &[u8]) -> String {
    // Stable FNV-1a provides deterministic, non-security-sensitive identifiers.
    // Snapshot keys are paired with source identity, and snapshot dedupe compares bytes.
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

fn read_file_revision(path: &Path) -> Result<FileRevision, NativeFileError> {
    let metadata = fs::metadata(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::CheckRevision, path, error)
    })?;
    let bytes = fs::read(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::CheckRevision, path, error)
    })?;

    if bytes.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "File is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    Ok(FileRevision {
        mtime_ms: modified_time_ms(&metadata),
        size: bytes.len() as u64,
        content_hash: stable_hash_hex(&bytes),
    })
}

fn read_written_file_revision(path: &Path, content: &str) -> Result<FileRevision, NativeFileError> {
    let metadata = fs::metadata(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectSavedDocument, path, error)
    })?;

    // The size and hash intentionally describe the exact snapshot Bindars wrote.
    // If another process replaces the file before this metadata read, the hybrid
    // revision will not bless those external bytes on the next conditional save.
    Ok(FileRevision {
        mtime_ms: modified_time_ms(&metadata),
        size: content.len() as u64,
        content_hash: stable_hash_hex(content.as_bytes()),
    })
}

fn successful_write_result(
    path: &Path,
    content: &str,
) -> Result<ConditionalWriteResult, NativeFileError> {
    let revision = read_written_file_revision(path, content)?;
    Ok(conditional_write_result(path, false, revision))
}

fn write_markdown_contents_atomic(path: &Path, content: &str) -> Result<(), NativeFileError> {
    write_contents_atomic(
        path,
        content,
        ".bindars-tmp",
        NativeFileOperation::SaveDocument,
    )
}

fn write_contents_atomic(
    path: &Path,
    content: &str,
    tmp_prefix: &str,
    read_only_operation: NativeFileOperation,
) -> Result<(), NativeFileError> {
    write_contents_atomic_impl(path, content, tmp_prefix, false, read_only_operation)
}

/// Atomic write for recovery data. The temporary file is created owner-only on
/// Unix so plaintext snapshot bytes are never group/world readable, even
/// briefly. Ordinary documents and exports keep an existing destination's Unix
/// permissions through `write_contents_atomic`.
fn write_contents_atomic_private(
    path: &Path,
    content: &str,
    tmp_prefix: &str,
) -> Result<(), String> {
    write_contents_atomic_impl(
        path,
        content,
        tmp_prefix,
        true,
        NativeFileOperation::SaveRecoveryData,
    )
    .map_err(|error| {
        log::warn!(
            "Recovery-data write failed during {:?}: {}",
            error.operation,
            error.detail
        );
        error.message
    })
}

#[cfg(unix)]
fn atomic_temp_creation_mode(
    owner_only: bool,
    existing_permissions: Option<&fs::Permissions>,
) -> u32 {
    use std::os::unix::fs::PermissionsExt;

    if owner_only {
        0o600
    } else {
        existing_permissions
            .map(|permissions| permissions.mode() & 0o777)
            .unwrap_or(0o666)
    }
}

fn open_atomic_temp_file(
    path: &Path,
    owner_only: bool,
    existing_permissions: Option<&fs::Permissions>,
) -> std::io::Result<fs::File> {
    let mut open_options = fs::OpenOptions::new();
    open_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(atomic_temp_creation_mode(owner_only, existing_permissions));
    }
    #[cfg(not(unix))]
    let _ = (owner_only, existing_permissions);
    open_options.open(path)
}

fn write_contents_atomic_impl(
    path: &Path,
    content: &str,
    tmp_prefix: &str,
    owner_only: bool,
    read_only_operation: NativeFileOperation,
) -> Result<(), NativeFileError> {
    let parent = path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            read_only_operation,
            "Cannot determine the destination folder.",
        )
    })?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(
        "{}-{}-{}-{}",
        tmp_prefix,
        std::process::id(),
        nanos,
        sequence
    );
    let tmp_path = parent.join(&tmp_name);

    // This is a best-effort preflight. A different process can still change the
    // destination between inspection and replacement; rename never follows a
    // final-component symlink, so that race cannot redirect the write elsewhere.
    #[cfg(unix)]
    let existing_permissions = if owner_only {
        None
    } else {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(NativeFileError::invalid(
                    NativeFileOperation::InspectWriteTarget,
                    "The destination cannot be a symbolic link.",
                ));
            }
            Ok(metadata) if metadata.file_type().is_file() => {
                if metadata.permissions().readonly() {
                    return Err(NativeFileError::read_only(read_only_operation, path));
                }
                Some(metadata.permissions())
            }
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(NativeFileError::from_io(
                    NativeFileOperation::InspectWriteTarget,
                    path,
                    error,
                ));
            }
        }
    };
    #[cfg(not(unix))]
    let existing_permissions = None::<fs::Permissions>;

    let mut tmp_file = open_atomic_temp_file(&tmp_path, owner_only, existing_permissions.as_ref())
        .map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::CreateTemporaryFile, &tmp_path, error)
        })?;

    #[cfg(unix)]
    if owner_only {
        use std::os::unix::fs::PermissionsExt;
        // The creation mode is filtered by the umask, which can only remove
        // bits; this normalizes stragglers like 0o400 back to exactly 0o600.
        if let Err(e) = tmp_file.set_permissions(fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp_path);
            return Err(NativeFileError::from_io(
                NativeFileOperation::PreservePermissions,
                &tmp_path,
                e,
            ));
        }
    }

    let write_result = (|| -> Result<(), NativeFileError> {
        tmp_file.write_all(content.as_bytes()).map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::WriteTemporaryFile, &tmp_path, error)
        })?;
        #[cfg(unix)]
        if let Some(permissions) = existing_permissions {
            tmp_file.set_permissions(permissions).map_err(|error| {
                NativeFileError::from_io(NativeFileOperation::PreservePermissions, &tmp_path, error)
            })?;
        }
        tmp_file.sync_all().map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::SyncTemporaryFile, &tmp_path, error)
        })?;
        Ok(())
    })();
    drop(tmp_file);

    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(error);
    }

    // The temporary file is on the destination volume. `rename` atomically replaces
    // files on Unix and uses Windows replacement APIs without a delete gap.
    fs::rename(&tmp_path, path).map_err(|error| {
        let _ = fs::remove_file(&tmp_path);
        NativeFileError::from_io(NativeFileOperation::ReplaceFile, path, error)
    })?;

    Ok(())
}

fn is_markdown_path(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => {
            ext.eq_ignore_ascii_case("md")
                || ext.eq_ignore_ascii_case("markdown")
                || ext.eq_ignore_ascii_case("fountain")
        }
        None => false,
    }
}

#[cfg(any(windows, target_os = "linux", test))]
fn cli_open_path_from_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Option<PathBuf> {
    let path = args.into_iter().nth(1).map(PathBuf::from)?;
    if !path.exists() || !is_markdown_path(&path) {
        return None;
    }

    let canonical_path = dunce::canonicalize(&path).ok()?;
    if is_markdown_path(&canonical_path) {
        return Some(canonical_path);
    }

    // Preserve a supported symlink path when its canonical target is not
    // supported. The normal open command then reports the same validation error
    // as macOS instead of the native intake silently dropping the launch.
    Some(path)
}

#[cfg(any(windows, target_os = "linux"))]
fn initial_cli_open_path() -> Option<PathBuf> {
    cli_open_path_from_args(std::env::args_os())
}

#[cfg(target_os = "macos")]
fn first_supported_opened_path(urls: &[tauri::Url]) -> Option<PathBuf> {
    let mut selected = None;
    let mut extra_supported = 0usize;

    for url in urls {
        if url.scheme() != "file" {
            log::warn!(
                "Ignoring native open URL with unsupported scheme '{}'",
                url.scheme()
            );
            continue;
        }

        let Ok(path) = url.to_file_path() else {
            log::warn!("Ignoring native file URL that cannot be converted to a local path");
            continue;
        };

        if !is_markdown_path(&path) {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("<none>");
            log::warn!(
                "Ignoring native open path with unsupported extension '{}'",
                extension
            );
            continue;
        }

        if selected.is_none() {
            selected = Some(path);
        } else {
            extra_supported += 1;
        }
    }

    if extra_supported > 0 {
        log::info!(
            "Ignoring {extra_supported} additional supported native open path(s) from one event"
        );
    }

    selected
}

#[cfg(target_os = "macos")]
fn reveal_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Cannot reveal the main window for a native open request");
        return;
    };

    if let Err(error) = window.show() {
        log::warn!("Failed to show the main window: {error}");
    }
    if let Err(error) = window.unminimize() {
        log::warn!("Failed to unminimize the main window: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("Failed to focus the main window: {error}");
    }
}

/// Window-state persistence flags. Visibility is deliberately excluded: a
/// window hidden through the macOS close guard must not relaunch invisibly
/// with no Dock-restore path. Size, position, maximized, fullscreen, and
/// decorations keep their useful restoration behavior.
#[cfg(desktop)]
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE
}

#[cfg(target_os = "macos")]
fn is_predefined_quit_text(text: &str) -> bool {
    text.trim().to_ascii_lowercase().starts_with("quit")
}

/// Builds the default macOS menu with the predefined Quit item replaced by a
/// custom item. The predefined item terminates through AppKit
/// (`sel!(terminate:)`) without any Tauri or webview event, which would bypass
/// the frontend unsaved-change guard, so a replacement failure is an error
/// instead of a silent fallback to the data-loss path.
#[cfg(target_os = "macos")]
fn default_menu_with_guarded_quit(
    app: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuItem, MenuItemKind};

    let menu = tauri::menu::Menu::default(app)?;
    let app_submenu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) => Some(submenu),
        _ => None,
    });
    let Some(app_submenu) = app_submenu else {
        return Err(std::io::Error::other("the default menu has no application submenu").into());
    };

    let predefined_quit = app_submenu
        .items()?
        .into_iter()
        .find_map(|item| match &item {
            MenuItemKind::Predefined(predefined) => {
                let Ok(text) = predefined.text() else {
                    return None;
                };
                if is_predefined_quit_text(&text) {
                    Some(item)
                } else {
                    None
                }
            }
            _ => None,
        });
    let Some(predefined_quit) = predefined_quit else {
        return Err(std::io::Error::other(
            "the default application submenu has no predefined Quit item",
        )
        .into());
    };
    app_submenu.remove(&predefined_quit)?;

    let quit_text = format!("Quit {}", app.package_info().name);
    let quit_item =
        MenuItem::with_id(app, QUIT_MENU_ITEM_ID, quit_text, true, Some("CmdOrCtrl+Q"))?;
    app_submenu.append(&quit_item)?;

    Ok(menu)
}

/// Forwards the custom Quit menu item to the frontend guard. The window is
/// revealed first so a resulting Save/Discard/Cancel dialog can never open in
/// a hidden window. The process exits only when the frontend guard completes
/// and invokes `exit_after_guarded_quit`.
#[cfg(target_os = "macos")]
fn handle_macos_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if event.id() != QUIT_MENU_ITEM_ID {
        return;
    }
    reveal_main_window(app);
    if let Err(error) = app.emit_to("main", NATIVE_QUIT_REQUESTED_EVENT, ()) {
        log::warn!("Failed to notify the frontend of a quit request: {error}");
    }
}

/// Exits the application. Reachable only through the frontend guard's
/// terminal continuation: nothing in this app prevents `ExitRequested`, so a
/// failed or cancelled guard can never reach this command.
#[tauri::command]
fn exit_after_guarded_quit(app: tauri::AppHandle) {
    app.exit(0);
}

fn is_supported_export_image_path(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
        ),
        None => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending_open_path = Arc::new(PendingOpenPath::default());

    #[cfg(any(windows, target_os = "linux"))]
    if let Some(path) = initial_cli_open_path() {
        let accepted = pending_open_path.replace_if_supported(path);
        debug_assert!(accepted);
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&pending_open_path))
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            resolve_markdown_path,
            open_markdown_file,
            // Keep simple write API for non-editor callsites.
            write_markdown_file,
            write_markdown_file_if_unmodified,
            export_html_file,
            open_markdown_file_externally,
            read_image_file_as_base64,
            export_markdown_file,
            take_pending_open_path,
            exit_after_guarded_quit,
            watch_file,
            unwatch_file,
            list_workspace_markdown_files,
            write_document_snapshot,
            list_document_snapshots,
            read_document_snapshot,
            list_snapshot_drafts,
            get_snapshot_storage_stats,
            retire_snapshot_draft,
            clear_snapshot_history
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(window_state_flags())
                    .build(),
            )?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.manage(FileWatcher(Mutex::new(FileWatcherState::default())));

            Ok(())
        });

    // The predefined macOS Quit item terminates through AppKit without any
    // frontend event, which would bypass the unsaved-change guard. Install a
    // menu whose Quit item routes through the guard instead. On other
    // platforms no menu is installed, matching the previous behavior.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(default_menu_with_guarded_quit)
        .on_menu_event(handle_macos_menu_event);

    let app = builder.build(tauri::generate_context!());

    match app {
        Ok(app) => {
            #[cfg(target_os = "macos")]
            let mut runtime_ready = false;

            app.run(move |app_handle, event| {
                #[cfg(target_os = "macos")]
                match event {
                    tauri::RunEvent::Ready => {
                        runtime_ready = true;
                    }
                    tauri::RunEvent::Reopen { .. } => {
                        // Clicking the Dock icon brings the hidden or minimized
                        // main window back; the app keeps running after close.
                        reveal_main_window(app_handle);
                    }
                    tauri::RunEvent::Opened { urls } => {
                        let Some(path) = first_supported_opened_path(&urls) else {
                            return;
                        };
                        let accepted = pending_open_path.replace_if_supported(path);
                        debug_assert!(accepted);

                        if runtime_ready {
                            reveal_main_window(app_handle);
                            if let Err(error) = app_handle.emit_to(
                                "main",
                                NATIVE_OPEN_AVAILABLE_EVENT,
                                (),
                            ) {
                                log::warn!(
                                    "Failed to notify the frontend of a native open request: {error}"
                                );
                            }
                        }
                    }
                    _ => {}
                }

                #[cfg(not(target_os = "macos"))]
                let _ = (app_handle, event);
            });
        }
        Err(error) => {
            eprintln!("error while building tauri application: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::first_supported_opened_path;
    #[cfg(target_os = "macos")]
    use super::is_predefined_quit_text;
    #[cfg(desktop)]
    use super::window_state_flags;
    use super::{
        begin_watch_request, clear_desired_watch_path_if_requested, cli_open_path_from_args,
        export_html_file_impl, export_markdown_file_impl, is_markdown_path,
        list_workspace_markdown_files_impl, open_atomic_temp_file, open_markdown_file_impl,
        read_file_revision, read_image_file_as_base64_impl, read_markdown_file_impl,
        read_written_file_revision, resolve_external_markdown_path_impl,
        resolve_markdown_path_impl, should_install_watch_request, should_unwatch_path,
        stable_hash_hex, write_contents_atomic, write_contents_atomic_private,
        write_markdown_file_if_unmodified_impl, write_markdown_file_impl, FileWatcherState,
        NativeFileError, NativeFileErrorCategory, NativeFileOperation, PendingOpenPath,
        MAX_EXPORT_HTML_BYTES, MAX_EXPORT_IMAGE_BYTES, MAX_MARKDOWN_BYTES, STANDARD,
    };
    use crate::test_support::{cleanup_temp_path, unique_temp_dir, unique_temp_path};
    use base64::Engine;
    use std::fs::{self, File};
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};

    #[test]
    fn accepts_markdown_extensions_case_insensitively() {
        assert!(is_markdown_path(Path::new("/tmp/note.md")));
        assert!(is_markdown_path(Path::new("/tmp/note.MD")));
        assert!(is_markdown_path(Path::new("/tmp/note.markdown")));
        assert!(is_markdown_path(Path::new("/tmp/note.MARKDOWN")));
        assert!(is_markdown_path(Path::new("/tmp/script.fountain")));
        assert!(is_markdown_path(Path::new("/tmp/script.FOUNTAIN")));
    }

    #[test]
    fn rejects_non_markdown_extensions() {
        assert!(!is_markdown_path(Path::new("/tmp/note.txt")));
        assert!(!is_markdown_path(Path::new("/tmp/note")));
    }

    #[test]
    fn pending_open_path_is_one_shot_and_latest_valid_request_wins() {
        let pending = PendingOpenPath::default();
        assert!(pending.replace_if_supported(PathBuf::from("/tmp/first.md")));
        assert!(pending.replace_if_supported(PathBuf::from("/tmp/latest.markdown")));

        assert_eq!(pending.take(), Some(PathBuf::from("/tmp/latest.markdown")));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn unsupported_open_does_not_clear_a_pending_supported_path() {
        let pending = PendingOpenPath::default();
        assert!(pending.replace_if_supported(PathBuf::from("/tmp/keep.md")));
        assert!(!pending.replace_if_supported(PathBuf::from("/tmp/ignore.txt")));
        assert_eq!(pending.take(), Some(PathBuf::from("/tmp/keep.md")));
    }

    #[test]
    fn the_same_path_can_be_opened_again_in_a_later_event() {
        let pending = PendingOpenPath::default();
        let path = PathBuf::from("/tmp/reopen.md");
        assert!(pending.replace_if_supported(path.clone()));
        assert_eq!(pending.take(), Some(path.clone()));
        assert!(pending.replace_if_supported(path.clone()));
        assert_eq!(pending.take(), Some(path));
    }

    #[test]
    #[cfg(desktop)]
    fn window_state_persistence_excludes_visibility_but_keeps_useful_state() {
        use tauri_plugin_window_state::StateFlags;

        let flags = window_state_flags();

        // A window hidden through the macOS close guard must never relaunch
        // invisibly, so visibility is excluded from persistence.
        assert!(!flags.contains(StateFlags::VISIBLE));
        // Size, position, maximized, and fullscreen restoration stay useful.
        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(flags.contains(StateFlags::FULLSCREEN));
        assert!(flags.contains(StateFlags::DECORATIONS));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn predefined_quit_items_are_identified_by_text() {
        // muda titles the default macOS Quit item "Quit <app name>".
        assert!(is_predefined_quit_text("Quit Bindars"));
        assert!(is_predefined_quit_text("  quit io.github.tcraid0.bindars "));
        // Nothing else in the default application submenu starts with "quit":
        // About, Services, Hide, Hide Others, and separators never match.
        assert!(!is_predefined_quit_text("Hide Bindars"));
        assert!(!is_predefined_quit_text("Hide Others"));
        assert!(!is_predefined_quit_text("About Bindars"));
        assert!(!is_predefined_quit_text("Services"));
        assert!(!is_predefined_quit_text(""));
    }

    #[test]
    fn cli_open_uses_only_the_first_existing_supported_argument() {
        let first = temp_path("md");
        let second = temp_path("fountain");
        fs::write(&first, "# First").expect("write first CLI fixture");
        fs::write(&second, "Title: Second").expect("write second CLI fixture");
        let args = [
            std::ffi::OsString::from("bindars"),
            first.clone().into_os_string(),
            second.clone().into_os_string(),
        ];

        assert_eq!(
            cli_open_path_from_args(args),
            Some(dunce::canonicalize(&first).expect("canonical first CLI fixture"))
        );
        cleanup(&first);
        cleanup(&second);
    }

    #[test]
    fn cli_open_ignores_missing_and_unsupported_first_arguments() {
        let unsupported = temp_path("txt");
        fs::write(&unsupported, "not supported").expect("write unsupported CLI fixture");
        let unsupported_args = [
            std::ffi::OsString::from("bindars"),
            unsupported.clone().into_os_string(),
        ];
        let missing_args = [
            std::ffi::OsString::from("bindars"),
            temp_path("md").into_os_string(),
        ];

        assert_eq!(cli_open_path_from_args(unsupported_args), None);
        assert_eq!(cli_open_path_from_args(missing_args), None);
        cleanup(&unsupported);
    }

    #[cfg(unix)]
    #[test]
    fn cli_open_preserves_a_supported_symlink_path_for_normal_open_validation() {
        let unsupported_target = temp_path("txt");
        let supported_link = temp_path("md");
        fs::write(&unsupported_target, "not supported").expect("write CLI symlink target");
        symlink(&unsupported_target, &supported_link).expect("create supported CLI symlink");
        let args = [
            std::ffi::OsString::from("bindars"),
            supported_link.clone().into_os_string(),
        ];

        let selected = cli_open_path_from_args(args).expect("select supported CLI link");
        assert_eq!(selected, supported_link);

        let pending = PendingOpenPath::default();
        assert!(pending.replace_if_supported(selected));
        let delivered = pending.take().expect("deliver supported CLI link");
        let error = open_markdown_file_impl(delivered.to_string_lossy().into_owned())
            .expect_err("unsupported canonical target should reach normal open validation");
        assert!(error.contains("Not a supported file type"));

        cleanup(&supported_link);
        cleanup(&unsupported_target);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_decode_unicode_and_spaces_without_requiring_the_file_to_exist() {
        let urls = [
            tauri::Url::parse("https://example.com/ignored.md").expect("remote URL"),
            tauri::Url::parse("file:///tmp/Caf%C3%A9%20Notes.md").expect("file URL"),
        ];

        assert_eq!(
            first_supported_opened_path(&urls),
            Some(PathBuf::from("/tmp/Café Notes.md"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_choose_the_first_supported_local_file() {
        let urls = [
            tauri::Url::parse("file:///tmp/ignored.txt").expect("unsupported file URL"),
            tauri::Url::parse("file:///tmp/first.fountain").expect("first supported URL"),
            tauri::Url::parse("file:///tmp/second.md").expect("second supported URL"),
        ];

        assert_eq!(
            first_supported_opened_path(&urls),
            Some(PathBuf::from("/tmp/first.fountain"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_reject_remote_file_hosts() {
        let urls =
            [tauri::Url::parse("file://example.com/tmp/remote.md").expect("remote file URL")];
        assert_eq!(first_supported_opened_path(&urls), None);
    }

    #[test]
    fn reads_valid_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, "# Hello\n\nMarkdown").expect("write fixture");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
        assert_eq!(result.expect("read markdown"), "# Hello\n\nMarkdown");

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn open_markdown_file_returns_canonical_path_and_content() {
        let target = temp_path("md");
        let link = temp_path("md");
        fs::write(&target, "# Open from command\n").expect("write fixture");
        symlink(&target, &link).expect("create symlink");

        let result =
            open_markdown_file_impl(link.to_string_lossy().into_owned()).expect("open markdown");

        assert_eq!(result.content, "# Open from command\n");
        assert_eq!(
            result.name,
            target.file_name().and_then(|v| v.to_str()).unwrap_or("")
        );
        assert_eq!(
            PathBuf::from(result.canonical_path),
            fs::canonicalize(&target).expect("canonical target")
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn reads_valid_fountain_file() {
        let path = temp_path("fountain");
        fs::write(&path, "INT. OFFICE - DAY\n\nSARAH\nHello world.").expect("write fixture");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
        assert_eq!(
            result.expect("read fountain"),
            "INT. OFFICE - DAY\n\nSARAH\nHello world."
        );

        cleanup(&path);
    }

    #[test]
    fn rejects_missing_markdown_file() {
        let path = temp_path("md");
        let error = read_markdown_file_impl(path.to_string_lossy().into_owned())
            .expect_err("missing file should error");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);
        assert_eq!(error.message, "This file is no longer available.");
    }

    #[test]
    fn rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn open_markdown_file_rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = open_markdown_file_impl(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn rejects_oversized_markdown_file() {
        let path = temp_path("md");
        let file = File::create(&path).expect("create fixture");
        file.set_len(MAX_MARKDOWN_BYTES + 1)
            .expect("expand fixture");

        let error = read_markdown_file_impl(path.to_string_lossy().into_owned())
            .expect_err("oversized file should error");
        assert!(
            error.contains("File is too large"),
            "unexpected error for {}: {error}",
            path.display()
        );

        cleanup(&path);
    }

    #[test]
    fn rejects_non_utf8_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, [0xFF_u8, 0xFE_u8, 0xFD_u8]).expect("write non-utf8 fixture");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("non-utf8 markdown should error")
            .contains("valid UTF-8"));

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_markdown_symlink_to_non_markdown_target() {
        let target = temp_path("txt");
        let link = temp_path("md");

        fs::write(&target, "plain text").expect("write target fixture");
        symlink(&target, &link).expect("create symlink");

        let result = read_markdown_file_impl(link.to_string_lossy().into_owned());
        assert!(result
            .expect_err("symlink target should be validated")
            .contains("Not a supported file type"));

        cleanup(&link);
        cleanup(&target);
    }

    #[cfg(unix)]
    #[test]
    fn reads_markdown_symlink_to_markdown_target() {
        let target = temp_path("md");
        let link = temp_path("md");

        fs::write(&target, "# Hello from symlink\n").expect("write target fixture");
        symlink(&target, &link).expect("create symlink");

        let result = read_markdown_file_impl(link.to_string_lossy().into_owned());
        assert_eq!(
            result.expect("read symlinked markdown"),
            "# Hello from symlink\n"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_markdown_path_returns_canonical_path() {
        let target = temp_path("md");
        let link = temp_path("md");

        fs::write(&target, "# canonical").expect("write target fixture");
        symlink(&target, &link).expect("create symlink");

        let resolved =
            resolve_markdown_path_impl(link.to_string_lossy().into_owned()).expect("resolve path");
        assert_eq!(
            PathBuf::from(resolved),
            fs::canonicalize(&target).expect("canonical target")
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn external_open_resolves_supported_markdown_files() {
        let path = temp_path("md");
        fs::write(&path, "# Open externally").expect("write fixture");

        let resolved = resolve_external_markdown_path_impl(path.to_string_lossy().into_owned())
            .expect("resolve external-open path");

        assert_eq!(
            PathBuf::from(resolved),
            dunce::canonicalize(&path).expect("canonical fixture")
        );

        cleanup(&path);
    }

    #[test]
    fn external_open_rejects_non_markdown_files() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = resolve_external_markdown_path_impl(path.to_string_lossy().into_owned());

        assert!(result
            .expect_err("external open should reject non-markdown files")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn writes_to_existing_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");

        let result = write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Updated\n\nNew content".to_string(),
        );
        assert!(result.is_ok());

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# Updated\n\nNew content");

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_markdown_write_preserves_existing_unix_permissions() {
        let path = temp_path("md");
        fs::write(&path, "# Private").expect("write fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640))
            .expect("set fixture permissions");

        write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Still private".to_string(),
        )
        .expect("write markdown");

        let mode = fs::metadata(&path)
            .expect("inspect written file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_temp_starts_with_the_existing_documents_private_mode() {
        let root = temp_dir("atomic-temp-private-mode");
        fs::create_dir(&root).expect("create fixture root");
        let destination = root.join("private.md");
        let temporary = root.join(".bindars-mode-test");
        fs::write(&destination, "private").expect("write private fixture");
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
            .expect("set private mode");
        let existing_permissions = fs::metadata(&destination)
            .expect("inspect private fixture")
            .permissions();

        let temporary_file = open_atomic_temp_file(&temporary, false, Some(&existing_permissions))
            .expect("create atomic temporary file");
        let temporary_mode = temporary_file
            .metadata()
            .expect("inspect atomic temporary file")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(temporary_mode, 0o600);
        drop(temporary_file);
        cleanup_dir(&root);
    }

    #[test]
    fn conditional_write_succeeds_with_matching_revision() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Updated".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect("conditional write");
        assert!(!result.conflict);

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# Updated");

        cleanup(&path);
    }

    #[test]
    fn conditional_write_detects_external_change_conflict() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::write(&path, "# External change").expect("simulate external write");

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Local edit".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect("conditional write conflict");
        assert!(result.conflict);
        assert_eq!(
            PathBuf::from(&result.canonical_path),
            dunce::canonicalize(&path).expect("canonical fixture")
        );
        assert_eq!(
            result.name,
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
        );

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# External change");

        cleanup(&path);
    }

    #[test]
    fn conditional_write_force_overwrites_after_conflict() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::write(&path, "# External change").expect("simulate external write");

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Forced overwrite".to_string(),
            Some(opened.revision),
            Some(true),
        )
        .expect("forced conditional write");
        assert!(!result.conflict);

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# Forced overwrite");

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_through_supported_symlink_preserves_link() {
        let target = temp_path("md");
        let link = temp_path("md");
        fs::write(&target, "# Original").expect("write target fixture");
        symlink(&target, &link).expect("create supported symlink");

        write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "# Updated".to_string(),
            None,
            Some(true),
        )
        .expect("forced write should follow supported symlink");

        assert!(fs::symlink_metadata(&link)
            .expect("inspect link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).expect("read target"),
            "# Updated"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_rejects_supported_symlink_to_unsupported_target() {
        let target = temp_path("txt");
        let link = temp_path("md");
        fs::write(&target, "outside type").expect("write unsupported target");
        symlink(&target, &link).expect("create supported-looking symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "must not write".to_string(),
            None,
            Some(true),
        )
        .expect_err("forced write must validate the symlink target");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert!(error.contains("Not a supported file type"));
        assert!(fs::symlink_metadata(&link)
            .expect("inspect link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).expect("read target"),
            "outside type"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_rejects_dangling_document_symlink_without_replacing_it() {
        let missing_target = temp_path("md");
        let link = temp_path("md");
        symlink(&missing_target, &link).expect("create dangling symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "must not replace link".to_string(),
            None,
            Some(true),
        )
        .expect_err("dangling symlink should require another Save As destination");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect dangling link")
            .file_type()
            .is_symlink());
        assert!(!missing_target.exists());

        cleanup(&link);
        cleanup(&missing_target);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_reports_a_symlinked_directory_as_an_invalid_write_target() {
        let root = temp_dir("symlinked-document-directory");
        fs::create_dir(&root).expect("create fixture root");
        let target = root.join("target.md");
        let link = root.join("link.md");
        fs::create_dir(&target).expect("create target directory");
        symlink(&target, &link).expect("create directory symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "must not replace link".to_string(),
            None,
            Some(true),
        )
        .expect_err("symlinked directory should require another Save As destination");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect directory link")
            .file_type()
            .is_symlink());
        assert!(target.is_dir());

        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn conditional_write_reports_a_replaced_directory_symlink_as_an_invalid_write_target() {
        let root = temp_dir("conditional-symlinked-document-directory");
        fs::create_dir(&root).expect("create fixture root");
        let link = root.join("document.md");
        let directory = root.join("replacement.md");
        fs::write(&link, "original").expect("write original document");
        let opened = open_markdown_file_impl(link.to_string_lossy().into_owned())
            .expect("open original document");
        fs::remove_file(&link).expect("remove original document");
        fs::create_dir(&directory).expect("create replacement directory");
        symlink(&directory, &link).expect("replace document with directory symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "local edits must survive".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect_err("directory symlink should require Save As recovery");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect replacement link")
            .file_type()
            .is_symlink());
        assert!(directory.is_dir());

        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_existing_read_only_target_before_replacement() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444))
            .expect("make fixture read-only");

        let error = write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Must remain".to_string(),
        )
        .expect_err("read-only target should be refused");

        assert!(error.contains("read-only"));
        assert_eq!(error.category, NativeFileErrorCategory::ReadOnly);
        assert_eq!(error.operation, NativeFileOperation::SaveDocument);
        assert_eq!(
            fs::read_to_string(&path).expect("read unchanged file"),
            "# Original"
        );
        let temporary_files = fs::read_dir(path.parent().expect("fixture parent"))
            .expect("list fixture parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bindars-tmp")
            })
            .count();
        assert_eq!(temporary_files, 0);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
            .expect("restore fixture permissions");
        cleanup(&path);
    }

    #[test]
    fn failed_replacement_removes_its_sibling_temporary_file() {
        let root = temp_dir("atomic-replace-cleanup");
        fs::create_dir(&root).expect("create fixture root");
        let destination_directory = root.join("destination.md");
        fs::create_dir(&destination_directory).expect("create replacement obstacle");

        let error = write_contents_atomic(
            &destination_directory,
            "temporary content",
            ".bindars-cleanup-test",
            NativeFileOperation::SaveDocument,
        )
        .expect_err("a file cannot replace an existing directory");

        assert_eq!(error.operation, NativeFileOperation::ReplaceFile);
        let leftovers = fs::read_dir(&root)
            .expect("list fixture root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bindars-cleanup-test")
            })
            .count();
        assert_eq!(leftovers, 0);

        cleanup_dir(&root);
    }

    #[test]
    fn private_atomic_write_returns_safe_text_without_diagnostic_path() {
        let root = temp_dir("private-write-safe-error");
        let path = root.join("missing").join("snapshot.md");

        let error = write_contents_atomic_private(&path, "private", ".snapshot-test")
            .expect_err("missing parent should reject private write");

        assert!(error.contains("Bindars could not create the temporary file"));
        assert!(!error.contains(&root.to_string_lossy().into_owned()));
        assert!(!error.contains("No such file or directory"));
    }

    #[test]
    fn concurrent_writes_to_distinct_files_in_one_directory_do_not_collide() {
        let root = temp_dir("atomic-concurrent-destinations");
        fs::create_dir(&root).expect("create fixture root");
        let mut threads = Vec::new();

        for index in 0..16 {
            let path = root.join(format!("document-{index}.md"));
            fs::write(&path, "initial").expect("write concurrent fixture");
            threads.push(std::thread::spawn(move || {
                write_markdown_file_impl(
                    path.to_string_lossy().into_owned(),
                    format!("updated-{index}"),
                )
            }));
        }

        for thread in threads {
            thread
                .join()
                .expect("write thread should not panic")
                .expect("concurrent write should succeed");
        }
        for index in 0..16 {
            assert_eq!(
                fs::read_to_string(root.join(format!("document-{index}.md")))
                    .expect("read concurrent result"),
                format!("updated-{index}")
            );
        }
        assert_eq!(
            fs::read_dir(&root)
                .expect("list fixture root")
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bindars-tmp"))
                .count(),
            0
        );

        cleanup_dir(&root);
    }

    #[test]
    fn write_preserves_decomposed_unicode_filename_identity() {
        let root = temp_dir("atomic-nfd-name");
        fs::create_dir(&root).expect("create fixture root");
        let path = root.join("Cafe\u{301}.md");
        fs::write(&path, "initial").expect("write NFD fixture");

        let result = write_markdown_file_if_unmodified_impl(
            path.to_string_lossy().into_owned(),
            "updated".to_string(),
            None,
            Some(true),
        )
        .expect("write NFD document");

        assert_eq!(
            fs::read_to_string(&path).expect("read NFD result"),
            "updated"
        );
        assert_eq!(
            PathBuf::from(result.canonical_path),
            dunce::canonicalize(&path).expect("canonical NFD path")
        );

        cleanup_dir(&root);
    }

    #[test]
    fn native_io_error_categories_are_conservative() {
        let path = Path::new("/tmp/category.md");
        let cases = [
            (
                std::io::ErrorKind::NotFound,
                NativeFileErrorCategory::NotFound,
            ),
            (
                std::io::ErrorKind::PermissionDenied,
                NativeFileErrorCategory::PermissionDenied,
            ),
            (
                std::io::ErrorKind::ReadOnlyFilesystem,
                NativeFileErrorCategory::ReadOnly,
            ),
            (
                std::io::ErrorKind::TimedOut,
                NativeFileErrorCategory::ResourceUnavailable,
            ),
            (
                std::io::ErrorKind::Interrupted,
                NativeFileErrorCategory::Unknown,
            ),
            (
                std::io::ErrorKind::WouldBlock,
                NativeFileErrorCategory::Unknown,
            ),
        ];

        for (kind, expected) in cases {
            let error = NativeFileError::from_io(
                NativeFileOperation::SaveDocument,
                path,
                std::io::Error::from(kind),
            );
            assert_eq!(error.category, expected, "unexpected category for {kind:?}");
        }
    }

    #[test]
    fn missing_document_error_keeps_the_path_out_of_its_user_message() {
        let path = Path::new("/private/documents/missing.md");

        let error = NativeFileError::from_io(
            NativeFileOperation::ResolveDocument,
            path,
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );

        assert_eq!(error.message, "This file is no longer available.");
        assert!(!error.message.contains("/private/documents"));
        assert!(error.detail.contains("/private/documents/missing.md"));
    }

    #[test]
    fn missing_workspace_error_keeps_the_path_out_of_its_user_message() {
        let path = Path::new("/private/workspaces/missing");

        let error = NativeFileError::from_io(
            NativeFileOperation::ResolveWorkspace,
            path,
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );

        assert_eq!(
            error.message,
            "The workspace folder is no longer available."
        );
        assert!(!error.message.contains("/private/workspaces"));
        assert!(error.detail.contains("/private/workspaces/missing"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn force_create_reports_unwritable_parent_without_leaving_a_temporary_file() {
        let root = temp_dir("atomic-unwritable-parent");
        fs::create_dir(&root).expect("create fixture root");
        let path = root.join("new.md");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555))
            .expect("make parent unwritable");

        let result = write_markdown_file_if_unmodified_impl(
            path.to_string_lossy().into_owned(),
            "new content".to_string(),
            None,
            Some(true),
        );

        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))
            .expect("restore parent permissions");
        let error = result.expect_err("unwritable parent should reject the save");
        assert_eq!(error.category, NativeFileErrorCategory::PermissionDenied);
        assert_eq!(error.operation, NativeFileOperation::CreateTemporaryFile);
        assert!(!path.exists());
        assert_eq!(
            fs::read_dir(&root)
                .expect("list fixture root")
                .filter_map(Result::ok)
                .count(),
            0
        );

        cleanup_dir(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn inaccessible_ancestor_reports_permission_denied_instead_of_missing() {
        let root = temp_dir("inaccessible-document-ancestor");
        fs::create_dir(&root).expect("create fixture root");
        let path = root.join("document.md");
        fs::write(&path, "content").expect("write fixture document");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o000))
            .expect("make ancestor inaccessible");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());

        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))
            .expect("restore ancestor permissions");
        let error = result.expect_err("inaccessible ancestor should reject the read");
        assert_eq!(error.category, NativeFileErrorCategory::PermissionDenied);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);

        cleanup_dir(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn case_variant_path_characterizes_the_host_volume_without_folding_in_bindars() {
        let root = temp_dir("case-variant-path");
        fs::create_dir(&root).expect("create fixture root");
        let exact = root.join("CaseIdentity.md");
        let variant = root.join("caseidentity.md");
        fs::write(&exact, "content").expect("write case fixture");
        let exact_canonical = dunce::canonicalize(&exact).expect("canonical exact path");

        match dunce::canonicalize(&variant) {
            Ok(variant_canonical) => assert_eq!(variant_canonical, exact_canonical),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        }

        cleanup_dir(&root);
    }

    #[test]
    fn conditional_write_non_force_errors_when_file_was_deleted() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::remove_file(&path).expect("delete fixture");

        let error = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Local edit".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect_err("non-force write should fail for deleted file");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);
        assert_eq!(error.message, "This file is no longer available.");
    }

    #[test]
    fn conditional_write_force_recreates_deleted_file() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::remove_file(&path).expect("delete fixture");

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Forced recreate".to_string(),
            Some(opened.revision),
            Some(true),
        )
        .expect("forced write should recreate file");

        assert!(!result.conflict);
        assert_eq!(
            fs::read_to_string(&path).expect("read recreated file"),
            "# Forced recreate"
        );

        cleanup(&path);
    }

    #[test]
    fn conditional_write_force_creates_missing_markdown_file() {
        let path = temp_path("md");
        let path_str = path.to_string_lossy().into_owned();

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Created".to_string(),
            None,
            Some(true),
        )
        .expect("forced write should create missing markdown file");

        assert!(!result.conflict);
        assert_eq!(
            PathBuf::from(&result.canonical_path),
            dunce::canonicalize(&path).expect("canonical created file")
        );
        assert_eq!(
            result.name,
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
        );
        assert_eq!(result.current_revision.size, "# Created".len() as u64);
        assert_eq!(
            result.current_revision.content_hash,
            stable_hash_hex(b"# Created")
        );
        assert_eq!(
            fs::read_to_string(&path).expect("read created file"),
            "# Created"
        );

        cleanup(&path);
    }

    #[test]
    fn written_revision_keeps_the_saved_snapshot_identity_after_external_replacement() {
        let path = temp_path("md");
        fs::write(&path, "external bytes").expect("write external fixture");

        let revision = read_written_file_revision(&path, "Bindars snapshot")
            .expect("read snapshot-bound revision");

        assert_eq!(revision.size, "Bindars snapshot".len() as u64);
        assert_eq!(revision.content_hash, stable_hash_hex(b"Bindars snapshot"));
        assert_ne!(
            revision,
            read_file_revision(&path).expect("read external revision")
        );

        cleanup(&path);
    }

    #[test]
    fn writes_to_existing_fountain_file() {
        let path = temp_path("fountain");
        fs::write(&path, "INT. ROOM - DAY").expect("write fixture");

        let result = write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "INT. ROOM - NIGHT\n\nJANE\n(whispering)\nGo.".to_string(),
        );
        assert!(result.is_ok());

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "INT. ROOM - NIGHT\n\nJANE\n(whispering)\nGo.");

        cleanup(&path);
    }

    #[test]
    fn write_rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result =
            write_markdown_file_impl(path.to_string_lossy().into_owned(), "new".to_string());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn write_rejects_nonexistent_file() {
        let path = temp_path("md");
        let error =
            write_markdown_file_impl(path.to_string_lossy().into_owned(), "new".to_string())
                .expect_err("missing file should error");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);
        assert_eq!(error.message, "This file is no longer available.");
    }

    #[test]
    fn write_rejects_oversized_content() {
        let path = temp_path("md");
        fs::write(&path, "# Placeholder").expect("write fixture");

        let oversized = "x".repeat((MAX_MARKDOWN_BYTES + 1) as usize);
        let result = write_markdown_file_impl(path.to_string_lossy().into_owned(), oversized);
        assert!(result
            .expect_err("oversized content should error")
            .contains("too large"));

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_symlink_to_non_markdown() {
        let target = temp_path("txt");
        let link = temp_path("md");

        fs::write(&target, "plain text").expect("write target fixture");
        symlink(&target, &link).expect("create symlink");

        let result =
            write_markdown_file_impl(link.to_string_lossy().into_owned(), "new".to_string());
        assert!(result
            .expect_err("symlink target should be validated")
            .contains("Not a supported file type"));

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn write_preserves_unicode_and_whitespace() {
        let path = temp_path("md");
        fs::write(&path, "# Init").expect("write fixture");

        let unicode = "# Héllo 世界\n\n  indented\ttabs\n\n🎉 emoji";
        write_markdown_file_impl(path.to_string_lossy().into_owned(), unicode.to_string())
            .expect("write Unicode and whitespace");

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, unicode);

        cleanup(&path);
    }

    #[test]
    fn list_workspace_finds_markdown_files_recursively() {
        let root = temp_dir("workspace");
        let nested = root.join("docs");
        fs::create_dir_all(&nested).expect("create nested dir");

        let a = root.join("a.md");
        let b = nested.join("b.markdown");
        let c = nested.join("c.txt");
        let d = root.join("script.fountain");

        fs::write(&a, "# A").expect("write a");
        fs::write(&b, "# B").expect("write b");
        fs::write(&c, "plain").expect("write c");
        fs::write(&d, "INT. OFFICE - DAY").expect("write d");

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(50))
                .expect("list workspace files");

        assert_eq!(result.files.len(), 3);
        assert!(result.files.iter().any(|f| f.rel_path == "a.md"));
        assert!(result.files.iter().any(|f| f.rel_path == "docs/b.markdown"));
        assert!(result.files.iter().any(|f| f.rel_path == "script.fountain"));

        cleanup_dir(&root);
    }

    #[test]
    fn list_workspace_respects_limit() {
        let root = temp_dir("workspace-limit");
        fs::create_dir_all(&root).expect("create root");

        for i in 0..4 {
            let file = root.join(format!("{}.md", i));
            fs::write(file, "# x").expect("write fixture");
        }

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(2))
                .expect("list workspace files");

        assert_eq!(result.files.len(), 2);

        cleanup_dir(&root);
    }

    #[test]
    fn list_workspace_limit_is_deterministic_by_rel_path() {
        let root = temp_dir("workspace-limit-deterministic");
        fs::create_dir_all(&root).expect("create root");

        fs::write(root.join("z.md"), "# z").expect("write fixture");
        fs::write(root.join("a.md"), "# a").expect("write fixture");
        fs::write(root.join("m.md"), "# m").expect("write fixture");

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(2))
                .expect("list workspace files");

        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].rel_path, "a.md");
        assert_eq!(result.files[1].rel_path, "m.md");
        assert!(result.limit_hit);

        cleanup_dir(&root);
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

    #[cfg(unix)]
    #[test]
    fn list_workspace_skips_symlink_escape() {
        let root = temp_dir("workspace-symlink");
        fs::create_dir_all(&root).expect("create root");

        let outside = temp_path("md");
        fs::write(&outside, "# outside").expect("write outside");

        let link = root.join("escape.md");
        symlink(&outside, &link).expect("create symlink");

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(20))
                .expect("list workspace files");

        assert!(result.files.is_empty());

        cleanup(&outside);
        cleanup_dir(&root);
    }

    #[test]
    fn export_markdown_accepts_md_extension() {
        let path = temp_path("md");
        let result = export_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Annotations\n".to_string(),
        );
        assert!(result.is_ok());
        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# Annotations\n");
        cleanup(&path);
    }

    #[test]
    fn export_markdown_accepts_markdown_extension() {
        let path = temp_path("markdown");
        let result = export_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Annotations\n".to_string(),
        );
        assert!(result.is_ok());
        cleanup(&path);
    }

    #[test]
    fn export_markdown_overwrites_existing_file() {
        let path = temp_path("md");
        fs::write(&path, "old content").expect("write existing export");

        let result = export_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "new content".to_string(),
        );

        assert!(result.is_ok());
        assert_eq!(
            fs::read_to_string(&path).expect("read overwritten export"),
            "new content"
        );
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_a_symlink_destination_without_replacing_it() {
        let target = temp_path("html");
        let link = temp_path("html");
        fs::write(&target, "original target").expect("write export target");
        symlink(&target, &link).expect("create export symlink");

        let error = export_html_file_impl(
            link.to_string_lossy().into_owned(),
            "<p>replacement</p>".to_string(),
        )
        .expect_err("export should reject a symlink destination");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect export link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).expect("read unchanged export target"),
            "original target"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn export_markdown_rejects_html_extension() {
        let path = temp_path("html");
        let result =
            export_markdown_file_impl(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("html extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
    }

    #[test]
    fn export_markdown_rejects_txt_extension() {
        let path = temp_path("txt");
        let result =
            export_markdown_file_impl(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("txt extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
    }

    #[test]
    fn export_markdown_rejects_oversized_content() {
        let path = temp_path("md");
        let oversized = "x".repeat((MAX_MARKDOWN_BYTES + 1) as usize);
        let result = export_markdown_file_impl(path.to_string_lossy().into_owned(), oversized);
        assert!(result
            .expect_err("oversized content should error")
            .contains("too large"));
    }

    #[test]
    fn export_markdown_rejects_nonexistent_parent() {
        let path = PathBuf::from("/nonexistent-dir-bindars-test/annotations.md");
        let result =
            export_markdown_file_impl(path.to_string_lossy().into_owned(), "content".to_string());
        let error = result.expect_err("missing parent should error");
        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveWriteParent);
    }

    #[test]
    fn export_html_accepts_html_extension() {
        let path = temp_path("html");
        let result = export_html_file_impl(
            path.to_string_lossy().into_owned(),
            "<p>export</p>".to_string(),
        );
        assert!(result.is_ok());

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "<p>export</p>");

        cleanup(&path);
    }

    #[test]
    fn export_html_rejects_non_html_extension() {
        let path = temp_path("md");
        let result = export_html_file_impl(
            path.to_string_lossy().into_owned(),
            "<p>export</p>".to_string(),
        );
        assert!(result
            .expect_err("non-html extension should be rejected")
            .contains("Export file must have .html or .htm extension"));
    }

    #[test]
    fn export_html_rejects_oversized_content() {
        let path = temp_path("html");
        let oversized = "x".repeat((MAX_EXPORT_HTML_BYTES + 1) as usize);
        let result = export_html_file_impl(path.to_string_lossy().into_owned(), oversized);
        assert!(result
            .expect_err("oversized html should error")
            .contains("too large"));
    }

    #[test]
    fn read_image_file_as_base64_reads_supported_image() {
        let root = temp_dir("image-read");
        let image_dir = root.join("images");
        fs::create_dir_all(&image_dir).expect("create image directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = image_dir.join("fixture.png");
        let bytes = [0_u8, 1_u8, 2_u8, 3_u8];
        fs::write(&path, bytes).expect("write image fixture");

        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        )
        .expect("read image");

        assert_eq!(result, STANDARD.encode(bytes));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_missing_file() {
        let root = temp_dir("image-missing");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("missing.png");
        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        let error = result.expect_err("missing image should error");
        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveImage);

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_directory() {
        let root = temp_dir("image-directory");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("image-dir");
        fs::create_dir_all(&path).expect("create directory fixture");
        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("directory should error")
            .contains("Path is not a file"));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_unsupported_extension() {
        let root = temp_dir("image-extension");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("fixture.txt");
        fs::write(&path, "not an image").expect("write fixture");

        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("unsupported image extension should error")
            .contains("Not a supported image type"));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_oversized_image() {
        let root = temp_dir("image-oversized");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("fixture.png");
        let file = File::create(&path).expect("create fixture");
        file.set_len(MAX_EXPORT_IMAGE_BYTES + 1)
            .expect("expand fixture");

        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("oversized image should error")
            .contains("Image is too large"));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_image_outside_document_folder() {
        let root = temp_dir("image-boundary");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let outside_path = temp_path("png");
        fs::write(&outside_path, [0_u8, 1_u8]).expect("write outside image");

        let result = read_image_file_as_base64_impl(
            outside_path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("outside image should be rejected")
            .contains("inside the open document's folder"));

        cleanup(&outside_path);
        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn read_image_file_as_base64_rejects_symlink_escape() {
        let root = temp_dir("image-symlink-boundary");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let outside_path = temp_path("png");
        fs::write(&outside_path, [0_u8, 1_u8]).expect("write outside image");
        let link_path = root.join("linked.png");
        symlink(&outside_path, &link_path).expect("create image symlink");

        let result = read_image_file_as_base64_impl(
            link_path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("symlink escape should be rejected")
            .contains("inside the open document's folder"));

        cleanup(&outside_path);
        cleanup_dir(&root);
    }

    fn temp_path(ext: &str) -> PathBuf {
        unique_temp_path(ext)
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        unique_temp_dir(prefix)
    }

    fn cleanup(path: &Path) {
        cleanup_temp_path(path);
    }

    fn cleanup_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }
}
