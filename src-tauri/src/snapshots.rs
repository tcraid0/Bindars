use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use super::{
    is_markdown_path, read_markdown_contents, stable_hash_hex, write_contents_atomic_private,
    NativeFileError, NativeFileOperation, MAX_MARKDOWN_BYTES, MAX_MARKDOWN_SIZE_MIB,
};

const SNAPSHOT_SCHEMA_VERSION: u8 = 1;
const SNAPSHOT_MERGE_WINDOW_MS: u64 = 10_000;
const TEN_MINUTES_MS: u64 = 10 * 60 * 1_000;
const ONE_HOUR_MS: u64 = 6 * TEN_MINUTES_MS;
const ONE_DAY_MS: u64 = 24 * ONE_HOUR_MS;
const ONE_WEEK_MS: u64 = 7 * ONE_DAY_MS;
const SNAPSHOT_DENSE_WINDOW_MS: u64 = TEN_MINUTES_MS;
const SNAPSHOT_HOURLY_START_MS: u64 = ONE_HOUR_MS;
const SNAPSHOT_DAILY_START_MS: u64 = ONE_DAY_MS;
const SNAPSHOT_WEEKLY_START_MS: u64 = 30 * ONE_DAY_MS;
const SNAPSHOT_MAX_AGE_MS: u64 = 90 * ONE_DAY_MS;
const SNAPSHOT_MAX_COUNT: usize = 100;
const SNAPSHOT_MAX_BYTES: u64 = 256 * 1024 * 1024;
const SNAPSHOT_IDENTITY_MAX_BYTES: u64 = 64 * 1024;
const SNAPSHOT_ACCESS_ERROR_MESSAGE: &str = "Bindars could not access recovery data.";

fn snapshot_access_error(detail: impl Into<String>) -> NativeFileError {
    let detail = detail.into();
    log::warn!("Recovery-data operation failed: {detail}");
    NativeFileError::unknown(
        NativeFileOperation::AccessRecoveryData,
        SNAPSHOT_ACCESS_ERROR_MESSAGE,
        detail,
    )
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SnapshotDocument {
    File { path: String, name: String },
    Draft { id: String, name: String },
}

impl SnapshotDocument {
    fn validate(&self) -> Result<(), String> {
        let name = self.name();
        if name.trim().is_empty() || name.len() > 255 {
            return Err("Snapshot document name must be between 1 and 255 bytes.".to_string());
        }

        match self {
            Self::File { path, .. } => {
                let path = Path::new(path);
                if !path.is_absolute() {
                    return Err("Snapshot file path must be absolute.".to_string());
                }
                if !is_markdown_path(path) {
                    return Err("Snapshot file must use .md, .markdown, or .fountain.".to_string());
                }
            }
            Self::Draft { id, .. } => {
                if id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                {
                    return Err(
                        "Snapshot draft id must contain only letters, numbers, '-' or '_'."
                            .to_string(),
                    );
                }
            }
        }

        Ok(())
    }

    fn name(&self) -> &str {
        match self {
            Self::File { name, .. } | Self::Draft { name, .. } => name,
        }
    }

    fn storage_key(&self) -> String {
        match self {
            Self::File { path, .. } => {
                format!("file-{}", stable_hash_hex(path.as_bytes()))
            }
            Self::Draft { id, .. } => {
                format!("draft-{}", stable_hash_hex(id.as_bytes()))
            }
        }
    }

    fn has_same_source(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::File { path: left, .. }, Self::File { path: right, .. }) => left == right,
            (Self::Draft { id: left, .. }, Self::Draft { id: right, .. }) => left == right,
            _ => false,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotIdentity {
    version: u8,
    document: SnapshotDocument,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotEntry {
    id: String,
    created_at_ms: u64,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotWriteResult {
    snapshot: SnapshotEntry,
    merged: bool,
    unchanged: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotDraft {
    id: String,
    name: String,
    latest_snapshot_at_ms: u64,
    snapshot_count: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotDraftList {
    drafts: Vec<SnapshotDraft>,
    skipped_count: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotStorageStats {
    stream_count: usize,
    snapshot_count: usize,
    total_bytes: u64,
    skipped_count: usize,
}

#[derive(Debug, Clone)]
struct SnapshotFile {
    entry: SnapshotEntry,
    path: PathBuf,
}

#[tauri::command]
pub(crate) async fn write_document_snapshot(
    app: tauri::AppHandle,
    document: SnapshotDocument,
    content: String,
    preserve_previous: Option<bool>,
) -> Result<SnapshotWriteResult, NativeFileError> {
    let root = snapshots_root(&app)?;
    let now_ms = current_time_ms();
    run_blocking_snapshot(move || {
        harden_snapshot_data_once(&root);
        if preserve_previous.unwrap_or(false) {
            write_snapshot_at_with_merge(&root, &document, &content, now_ms, false)
        } else {
            write_snapshot_at(&root, &document, &content, now_ms)
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_document_snapshots(
    app: tauri::AppHandle,
    document: SnapshotDocument,
) -> Result<Vec<SnapshotEntry>, NativeFileError> {
    let root = snapshots_root(&app)?;
    run_blocking_snapshot(move || {
        harden_snapshot_data_once(&root);
        list_snapshot_files(&root, &document)
            .map(|files| files.into_iter().map(|file| file.entry).collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn read_document_snapshot(
    app: tauri::AppHandle,
    document: SnapshotDocument,
    snapshot_id: String,
) -> Result<String, NativeFileError> {
    let root = snapshots_root(&app)?;
    run_blocking_snapshot(move || {
        harden_snapshot_data_once(&root);
        read_snapshot_at(&root, &document, &snapshot_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_snapshot_drafts(
    app: tauri::AppHandle,
) -> Result<SnapshotDraftList, NativeFileError> {
    let root = snapshots_root(&app)?;
    let now_ms = current_time_ms();
    run_blocking_snapshot(move || {
        harden_snapshot_data_once(&root);
        list_drafts_at(&root, now_ms)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_snapshot_storage_stats(
    app: tauri::AppHandle,
) -> Result<SnapshotStorageStats, NativeFileError> {
    let root = snapshots_root(&app)?;
    run_blocking_snapshot(move || snapshot_storage_stats_at(&root)).await
}

#[tauri::command]
pub(crate) async fn retire_snapshot_draft(
    app: tauri::AppHandle,
    document: SnapshotDocument,
) -> Result<(), NativeFileError> {
    let root = snapshots_root(&app)?;
    run_blocking_snapshot(move || retire_draft_at(&root, &document)).await
}

#[tauri::command]
pub(crate) async fn clear_snapshot_history(app: tauri::AppHandle) -> Result<(), NativeFileError> {
    let app_data = app_data_root(&app)?;
    run_blocking_snapshot(move || clear_history_under(&app_data)).await
}

async fn run_blocking_snapshot<T, F>(task: F) -> Result<T, NativeFileError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let result = tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| snapshot_access_error(format!("Snapshot task failed: {error}")))?;
    result.map_err(snapshot_access_error)
}

fn app_data_root(app: &tauri::AppHandle) -> Result<PathBuf, NativeFileError> {
    app.path().app_data_dir().map_err(|error| {
        snapshot_access_error(format!("Failed to resolve app-data directory: {error}"))
    })
}

fn snapshots_root(app: &tauri::AppHandle) -> Result<PathBuf, NativeFileError> {
    app_data_root(app).map(|path| path.join("snapshots").join("v1"))
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn write_snapshot_at(
    root: &Path,
    document: &SnapshotDocument,
    content: &str,
    now_ms: u64,
) -> Result<SnapshotWriteResult, String> {
    write_snapshot_at_with_merge(root, document, content, now_ms, true)
}

fn write_snapshot_at_with_merge(
    root: &Path,
    document: &SnapshotDocument,
    content: &str,
    raw_now_ms: u64,
    merge_with_previous: bool,
) -> Result<SnapshotWriteResult, String> {
    document.validate()?;
    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "Snapshot is too large. Maximum supported size is {MAX_MARKDOWN_SIZE_MIB} MiB."
        ));
    }

    let stream_dir = root.join(document.storage_key());
    create_private_stream_dir(&stream_dir)?;
    ensure_identity(&stream_dir, document)?;

    let existing = collect_snapshot_files(&stream_dir)?;
    if let Some(latest) = existing.first() {
        // The stable hash is intentionally non-cryptographic, so it is never
        // sufficient evidence that two buffers are equal.
        if read_markdown_contents(&latest.path).is_ok_and(|saved| saved == content) {
            return Ok(SnapshotWriteResult {
                snapshot: latest.entry.clone(),
                merged: false,
                unchanged: true,
            });
        }
    }

    let merged = merge_with_previous
        && existing.first().is_some_and(|latest| {
            raw_now_ms.saturating_sub(latest.entry.created_at_ms) <= SNAPSHOT_MERGE_WINDOW_MS
        });
    let effective_now_ms = if let Some(latest) = existing.first() {
        let next_observed_ms = latest
            .entry
            .created_at_ms
            .checked_add(1)
            .ok_or_else(|| "Snapshot timestamp limit exhausted.".to_string())?;
        raw_now_ms.max(next_observed_ms)
    } else {
        raw_now_ms
    };

    let content_hash = stable_hash_hex(content.as_bytes());
    let (snapshot_id, snapshot_path) =
        unused_snapshot_path(&stream_dir, effective_now_ms, &content_hash)?;
    write_contents_atomic_private(&snapshot_path, content, ".bindars-snapshot-tmp")?;

    if merged {
        let latest = &existing[0];
        if latest.path != snapshot_path {
            fs::remove_file(&latest.path)
                .map_err(|error| format!("Failed to merge prior snapshot: {error}"))?;
        }
    }

    prune_stream(&stream_dir, effective_now_ms)?;

    Ok(SnapshotWriteResult {
        snapshot: SnapshotEntry {
            id: snapshot_id,
            created_at_ms: effective_now_ms,
            size: content.len() as u64,
        },
        merged,
        unchanged: false,
    })
}

fn list_snapshot_files(
    root: &Path,
    document: &SnapshotDocument,
) -> Result<Vec<SnapshotFile>, String> {
    document.validate()?;
    let stream_dir = root.join(document.storage_key());
    if !stream_dir.exists() {
        return Ok(Vec::new());
    }
    verify_identity(&stream_dir, document)?;
    collect_snapshot_files(&stream_dir)
}

fn read_snapshot_at(
    root: &Path,
    document: &SnapshotDocument,
    snapshot_id: &str,
) -> Result<String, String> {
    parse_snapshot_id(snapshot_id).ok_or_else(|| "Invalid snapshot id.".to_string())?;
    let stream_dir = root.join(document.storage_key());
    verify_identity(&stream_dir, document)?;
    let snapshot_path = stream_dir.join(snapshot_id);
    read_markdown_contents(&snapshot_path)
        .map_err(|error| format!("Failed to read snapshot: {error}"))
}

fn retire_draft_at(root: &Path, document: &SnapshotDocument) -> Result<(), String> {
    document.validate()?;
    if !matches!(document, SnapshotDocument::Draft { .. }) {
        return Err("Only draft snapshot streams can be retired.".to_string());
    }

    let stream_dir = root.join(document.storage_key());
    refuse_symlinked_owned_chain(&stream_dir)?;
    match inspect_chain_entry(&stream_dir) {
        Ok(ChainEntry::Missing) => return Ok(()),
        Ok(_) => {}
        Err(error) => return Err(format!("Failed to inspect draft snapshot stream: {error}")),
    }
    verify_identity(&stream_dir, document)?;
    fs::remove_dir_all(&stream_dir)
        .map_err(|error| format!("Failed to retire draft snapshot stream: {error}"))
}

// The deletion target is rebuilt component-by-component from the app-data
// directory only — a caller can never select it. Every component below
// app-data must be a real directory: a symlinked `snapshots` or `v1` would
// let the recursive delete escape Bindars' own tree, so it aborts instead.
fn clear_history_under(app_data_dir: &Path) -> Result<(), String> {
    let mut history = app_data_dir.to_path_buf();
    for component in ["snapshots", "v1"] {
        history.push(component);
        match inspect_chain_entry(&history) {
            Ok(ChainEntry::Missing) => return Ok(()),
            Ok(ChainEntry::Symlink) => {
                return Err(
                    "Recovery history location is a symlink, so nothing was deleted.".to_string(),
                );
            }
            Ok(ChainEntry::NotADirectory) => {
                return Err(
                    "Recovery history is not a directory, so nothing was deleted.".to_string(),
                );
            }
            Ok(ChainEntry::RealDir) => {}
            Err(error) => return Err(format!("Failed to inspect recovery history: {error}")),
        }
    }
    fs::remove_dir_all(&history)
        .map_err(|error| format!("Failed to clear recovery history: {error}"))
}

// A chain component is inspected without following a final symlink, so a
// redirected `snapshots` or `v1` is seen as the link itself, never its
// target. Callers apply their own policy per kind: clearing refuses symlinks
// and non-directories, hardening silently skips, writing refuses and repairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChainEntry {
    Missing,
    RealDir,
    Symlink,
    NotADirectory,
}

fn inspect_chain_entry(path: &Path) -> std::io::Result<ChainEntry> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(ChainEntry::Symlink),
        Ok(metadata) if metadata.is_dir() => Ok(ChainEntry::RealDir),
        Ok(_) => Ok(ChainEntry::NotADirectory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ChainEntry::Missing),
        Err(error) => Err(error),
    }
}

// Bindars owns the stream directory, an ancestor named `v1`, and its parent
// named `snapshots`. The name guards keep arbitrary ancestors (the app-data
// directory itself, a temp directory in tests) from being policed or
// chmodded, so an app-data tree relocated behind a symlink keeps working.
fn owned_chain(stream_dir: &Path) -> Vec<PathBuf> {
    use std::ffi::OsStr;

    let mut owned = vec![stream_dir.to_path_buf()];
    if let Some(v1) = stream_dir
        .parent()
        .filter(|parent| parent.file_name() == Some(OsStr::new("v1")))
    {
        owned.push(v1.to_path_buf());
        if let Some(snapshots) = v1
            .parent()
            .filter(|parent| parent.file_name() == Some(OsStr::new("snapshots")))
        {
            owned.push(snapshots.to_path_buf());
        }
    }
    owned
}

const OWNED_CHAIN_SYMLINK_REFUSAL: &str =
    "Recovery snapshot location is a symlink, so nothing was changed.";

// Every mutation of a snapshot stream — writing, retiring, clearing — must
// refuse before touching anything through a symlinked owned component, because
// the tree behind the link is not the one Bindars created. This standalone
// walk is for mutations that must not create or repair anything (retirement);
// `create_private_stream_dir` integrates the same refusal into its own walk
// because there the chain may need mode repair before deeper components are
// even inspectable, and `clear_history_under` applies it with clear-specific
// messages.
fn refuse_symlinked_owned_chain(stream_dir: &Path) -> Result<(), String> {
    for component in owned_chain(stream_dir).iter().rev() {
        match inspect_chain_entry(component) {
            Ok(ChainEntry::Symlink) => return Err(OWNED_CHAIN_SYMLINK_REFUSAL.to_string()),
            // Nothing can exist below a missing or non-directory component.
            Ok(ChainEntry::Missing) | Ok(ChainEntry::NotADirectory) => return Ok(()),
            Ok(ChainEntry::RealDir) => {}
            Err(error) => return Err(format!("Failed to inspect snapshot location: {error}")),
        }
    }
    Ok(())
}

// Walks the chain root-first, handling one component completely before
// descending into the next. Order matters twice: a symlinked owned component
// must be refused before anything is created or chmodded below it, and an
// existing owned directory must be repaired to exactly 0o700 before its
// children are touched — the umask filters the requested creation mode, so a
// mode like 0o600 left behind by an earlier launch would otherwise block
// traversal forever. Missing components are created one at a time and set to
// exactly 0o700 immediately, before the walk descends into them. Like the
// other snapshot operations, this defends against a persistently redirected
// chain, not against a same-user race between inspection and mutation.
fn create_private_stream_dir(stream_dir: &Path) -> Result<(), String> {
    let owned = owned_chain(stream_dir);
    let mut chain: Vec<&Path> = stream_dir.ancestors().collect();
    chain.reverse();
    for component in chain {
        match inspect_chain_entry(component) {
            Ok(ChainEntry::RealDir) => {
                #[cfg(unix)]
                {
                    if owned.iter().any(|dir| dir == component) {
                        ensure_exact_private_dir_mode(component).map_err(|error| {
                            format!("Failed to repair snapshot directory permissions: {error}")
                        })?;
                    }
                }
            }
            Ok(ChainEntry::Symlink) => {
                if owned.iter().any(|dir| dir == component) {
                    return Err(OWNED_CHAIN_SYMLINK_REFUSAL.to_string());
                }
            }
            Ok(ChainEntry::Missing) => {
                match fs::create_dir(component) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!("Failed to create snapshot directory: {error}"))
                    }
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(component, fs::Permissions::from_mode(0o700)).map_err(
                        |error| format!("Failed to set private directory permissions: {error}"),
                    )?;
                }
            }
            Ok(ChainEntry::NotADirectory) => {
                return Err(format!(
                    "Failed to create snapshot directory: {} is not a directory.",
                    component.display()
                ));
            }
            Err(error) => return Err(format!("Failed to inspect snapshot directory: {error}")),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_exact_private_dir_mode(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && metadata.permissions().mode() & 0o777 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

// Recovery data written before Bindars enforced private modes may be
// group/world readable. Tightening is best-effort: a failure here must never
// block a recovery write, and the warning is logged at most once per launch.
fn harden_snapshot_data_once(root: &Path) {
    static HARDEN: std::sync::Once = std::sync::Once::new();
    HARDEN.call_once(|| {
        let failures = harden_existing_snapshot_data(root);
        if failures > 0 {
            eprintln!(
                "[snapshots] Could not tighten permissions on {failures} existing recovery entries."
            );
        }
    });
}

#[cfg(unix)]
fn harden_existing_snapshot_data(root: &Path) -> usize {
    use std::os::unix::fs::PermissionsExt;

    // Returns false only on a real failure. Symlinks are skipped so a chmod
    // can never reach outside the snapshot tree, and already-private entries
    // are left untouched (a stricter manual mode is not loosened).
    fn tighten_owner_only(path: &Path) -> bool {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
        };
        if metadata.file_type().is_symlink() || metadata.permissions().mode() & 0o077 == 0 {
            return true;
        }
        let mode = if metadata.is_dir() { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).is_ok()
    }

    let mut failures = 0;
    if let Some(parent) = root.parent() {
        // A symlinked `snapshots` ancestor is not the tree Bindars created;
        // walking through it would chmod unrelated files. Skip hardening
        // entirely — the same boundary rule `clear_history_under` and
        // `create_private_stream_dir` enforce.
        if matches!(inspect_chain_entry(parent), Ok(ChainEntry::Symlink)) {
            return 0;
        }
        // Bindars creates the `snapshots` parent alongside `v1` and owns
        // nothing else there; tighten it even when `v1` is currently absent
        // (for example right after a clear), because this pass runs only once
        // per launch. The name guard keeps an arbitrary parent (for example a
        // shared temp directory in tests) from ever being chmodded.
        if parent.file_name() == Some(std::ffi::OsStr::new("snapshots"))
            && !tighten_owner_only(parent)
        {
            failures += 1;
        }
    }
    match inspect_chain_entry(root) {
        Ok(ChainEntry::RealDir) => {}
        _ => return failures,
    }
    if !tighten_owner_only(root) {
        failures += 1;
    }
    let streams = match fs::read_dir(root) {
        Ok(streams) => streams,
        Err(_) => return failures + 1,
    };
    for stream in streams.flatten() {
        let stream_path = stream.path();
        if !tighten_owner_only(&stream_path) {
            failures += 1;
        }
        let is_stream_dir = fs::symlink_metadata(&stream_path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        if !is_stream_dir {
            continue;
        }
        let files = match fs::read_dir(&stream_path) {
            Ok(files) => files,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        for file in files.flatten() {
            if !tighten_owner_only(&file.path()) {
                failures += 1;
            }
        }
    }
    failures
}

// Windows relies on the per-user app-data ACLs instead of Unix mode bits.
#[cfg(not(unix))]
fn harden_existing_snapshot_data(_root: &Path) -> usize {
    0
}

// Listing stays read-only so a forward clock jump can never destroy recovery history.
fn list_drafts_at(root: &Path, now_ms: u64) -> Result<SnapshotDraftList, String> {
    if !root.exists() {
        return Ok(SnapshotDraftList {
            drafts: Vec::new(),
            skipped_count: 0,
        });
    }

    let entries = fs::read_dir(root)
        .map_err(|error| format!("Failed to list snapshot directory: {error}"))?;
    let mut drafts = Vec::new();
    let mut skipped_count = 0;

    for entry in entries {
        let Ok(entry) = entry else {
            skipped_count += 1;
            continue;
        };
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            skipped_count += 1;
            continue;
        };
        if !file_name.starts_with("draft-") || !path.is_dir() {
            continue;
        }

        let Ok(identity) = read_identity(&path) else {
            skipped_count += 1;
            continue;
        };
        if identity.version != SNAPSHOT_SCHEMA_VERSION
            || identity.document.validate().is_err()
            || identity.document.storage_key() != file_name
        {
            skipped_count += 1;
            continue;
        }
        let SnapshotDocument::Draft { id, name } = identity.document else {
            skipped_count += 1;
            continue;
        };
        let Ok(snapshots) = collect_snapshot_files(&path) else {
            skipped_count += 1;
            continue;
        };
        let Some(latest) = snapshots.first() else {
            continue;
        };
        if now_ms.saturating_sub(latest.entry.created_at_ms) > SNAPSHOT_MAX_AGE_MS {
            continue;
        }
        drafts.push(SnapshotDraft {
            id,
            name,
            latest_snapshot_at_ms: latest.entry.created_at_ms,
            snapshot_count: snapshots.len(),
        });
    }

    drafts.sort_by(|left, right| {
        right
            .latest_snapshot_at_ms
            .cmp(&left.latest_snapshot_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(SnapshotDraftList {
        drafts,
        skipped_count,
    })
}

// Storage reporting is deliberately read-only and never follows symlinks.
// Unknown or unreadable entries make the total incomplete instead of risking
// inspection outside Bindars' owned recovery tree.
fn snapshot_storage_stats_at(root: &Path) -> Result<SnapshotStorageStats, String> {
    let empty = || SnapshotStorageStats {
        stream_count: 0,
        snapshot_count: 0,
        total_bytes: 0,
        skipped_count: 0,
    };
    let snapshots_dir = root
        .parent()
        .ok_or_else(|| "Cannot determine recovery storage directory.".to_string())?;

    for path in [snapshots_dir, root] {
        match inspect_chain_entry(path) {
            Ok(ChainEntry::Missing) => return Ok(empty()),
            Ok(ChainEntry::Symlink) => {
                return Err(
                    "Recovery storage location is a symlink, so it was not inspected.".to_string(),
                );
            }
            Ok(ChainEntry::NotADirectory) => {
                return Err(
                    "Recovery storage location is not a directory, so it was not inspected."
                        .to_string(),
                );
            }
            Ok(ChainEntry::RealDir) => {}
            Err(error) => return Err(format!("Failed to inspect recovery storage: {error}")),
        }
    }

    let entries =
        fs::read_dir(root).map_err(|error| format!("Failed to list recovery storage: {error}"))?;
    let mut stats = empty();

    for stream_entry in entries {
        let stream_entry = match stream_entry {
            Ok(entry) => entry,
            Err(_) => {
                stats.skipped_count = stats.skipped_count.saturating_add(1);
                continue;
            }
        };
        let stream_path = stream_entry.path();
        match fs::symlink_metadata(&stream_path) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            _ => {
                stats.skipped_count = stats.skipped_count.saturating_add(1);
                continue;
            }
        }
        stats.stream_count = stats.stream_count.saturating_add(1);

        let files = match fs::read_dir(&stream_path) {
            Ok(files) => files,
            Err(_) => {
                stats.skipped_count = stats.skipped_count.saturating_add(1);
                continue;
            }
        };
        for file_entry in files {
            let file_entry = match file_entry {
                Ok(entry) => entry,
                Err(_) => {
                    stats.skipped_count = stats.skipped_count.saturating_add(1);
                    continue;
                }
            };
            let path = file_entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                _ => {
                    stats.skipped_count = stats.skipped_count.saturating_add(1);
                    continue;
                }
            };
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                stats.skipped_count = stats.skipped_count.saturating_add(1);
                continue;
            };
            let is_snapshot = parse_snapshot_id(name).is_some();
            if name != "identity.json" && !is_snapshot {
                stats.skipped_count = stats.skipped_count.saturating_add(1);
                continue;
            }

            stats.total_bytes = stats.total_bytes.saturating_add(metadata.len());
            if is_snapshot {
                stats.snapshot_count = stats.snapshot_count.saturating_add(1);
            }
        }
    }

    Ok(stats)
}

fn ensure_identity(stream_dir: &Path, document: &SnapshotDocument) -> Result<(), String> {
    let identity_path = stream_dir.join("identity.json");
    if identity_path.exists() {
        let identity = read_identity(stream_dir)?;
        if !identity.document.has_same_source(document) {
            return Err("Snapshot identity hash collision detected.".to_string());
        }
        if identity.version != SNAPSHOT_SCHEMA_VERSION {
            return Err(format!(
                "Unsupported snapshot identity version: {}.",
                identity.version
            ));
        }
        if identity.version == SNAPSHOT_SCHEMA_VERSION && identity.document == *document {
            return Ok(());
        }
    }

    let identity = SnapshotIdentity {
        version: SNAPSHOT_SCHEMA_VERSION,
        document: document.clone(),
    };
    let json = serde_json::to_string_pretty(&identity)
        .map_err(|error| format!("Failed to encode snapshot identity: {error}"))?;
    write_contents_atomic_private(&identity_path, &json, ".bindars-snapshot-identity-tmp")
}

fn verify_identity(stream_dir: &Path, document: &SnapshotDocument) -> Result<(), String> {
    document.validate()?;
    if !stream_dir.is_dir() {
        return Err("Snapshot stream was not found.".to_string());
    }
    let identity = read_identity(stream_dir)?;
    if identity.version != SNAPSHOT_SCHEMA_VERSION || !identity.document.has_same_source(document) {
        return Err("Snapshot stream identity does not match this document.".to_string());
    }
    Ok(())
}

fn read_identity(stream_dir: &Path) -> Result<SnapshotIdentity, String> {
    let path = stream_dir.join("identity.json");
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Failed to inspect snapshot identity: {error}"))?;
    if metadata.len() > SNAPSHOT_IDENTITY_MAX_BYTES {
        return Err("Snapshot identity is too large.".to_string());
    }
    let json = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read snapshot identity: {error}"))?;
    serde_json::from_str(&json)
        .map_err(|error| format!("Failed to decode snapshot identity: {error}"))
}

fn collect_snapshot_files(stream_dir: &Path) -> Result<Vec<SnapshotFile>, String> {
    let entries =
        fs::read_dir(stream_dir).map_err(|error| format!("Failed to list snapshots: {error}"))?;
    let mut snapshots = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to inspect snapshot entry: {error}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some((created_at_ms, _)) = parse_snapshot_id(id) else {
            continue;
        };
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Failed to inspect snapshot file: {error}"))?;
        snapshots.push(SnapshotFile {
            entry: SnapshotEntry {
                id: id.to_string(),
                created_at_ms,
                size: metadata.len(),
            },
            path,
        });
    }

    snapshots.sort_by(|left, right| {
        right
            .entry
            .created_at_ms
            .cmp(&left.entry.created_at_ms)
            .then_with(|| right.entry.id.cmp(&left.entry.id))
    });
    Ok(snapshots)
}

fn parse_snapshot_id(id: &str) -> Option<(u64, &str)> {
    let stem = id.strip_suffix(".md")?;
    let mut parts = stem.split('-');
    let timestamp = parts.next()?;
    let hash = parts.next()?;
    let collision_suffix = parts.next();
    if timestamp.len() != 20
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || hash.len() != 16
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || parts.next().is_some()
        || collision_suffix.is_some_and(|suffix| {
            suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return None;
    }
    Some((timestamp.parse().ok()?, hash))
}

fn unused_snapshot_path(
    stream_dir: &Path,
    now_ms: u64,
    content_hash: &str,
) -> Result<(String, PathBuf), String> {
    let base = format!("{now_ms:020}-{content_hash}");
    let mut collision_index = 0_u64;
    loop {
        let id = if collision_index == 0 {
            format!("{base}.md")
        } else {
            format!("{base}-{collision_index}.md")
        };
        let path = stream_dir.join(&id);
        if !path.exists() {
            return Ok((id, path));
        }
        collision_index = collision_index
            .checked_add(1)
            .ok_or_else(|| "Snapshot id collision limit exhausted.".to_string())?;
    }
}

fn prune_stream(stream_dir: &Path, now_ms: u64) -> Result<(), String> {
    let snapshots = collect_snapshot_files(stream_dir)?;
    let retained_ids = retained_snapshot_ids(&snapshots, now_ms);
    for snapshot in snapshots {
        if retained_ids.contains(&snapshot.entry.id) {
            continue;
        }
        fs::remove_file(&snapshot.path)
            .map_err(|error| format!("Failed to prune snapshot: {error}"))?;
    }
    Ok(())
}

fn retained_snapshot_ids(snapshots: &[SnapshotFile], now_ms: u64) -> HashSet<String> {
    let mut newest_first = snapshots.iter().collect::<Vec<_>>();
    newest_first.sort_by(|left, right| {
        right
            .entry
            .created_at_ms
            .cmp(&left.entry.created_at_ms)
            .then_with(|| right.entry.id.cmp(&left.entry.id))
    });
    let mut retained = Vec::new();
    let mut occupied_buckets = HashSet::new();

    for snapshot in newest_first {
        let age = now_ms.saturating_sub(snapshot.entry.created_at_ms);
        let bucket = retention_bucket(age);
        let should_keep = if age <= SNAPSHOT_DENSE_WINDOW_MS {
            true
        } else if let Some(bucket) = bucket {
            occupied_buckets.insert(bucket)
        } else {
            false
        };
        if should_keep {
            retained.push(snapshot);
        }
    }

    while retained.len() > SNAPSHOT_MAX_COUNT {
        retained.pop();
    }

    let mut total_bytes = retained
        .iter()
        .map(|snapshot| snapshot.entry.size)
        .sum::<u64>();
    while retained.len() > 1 && total_bytes > SNAPSHOT_MAX_BYTES {
        if let Some(removed) = retained.pop() {
            total_bytes = total_bytes.saturating_sub(removed.entry.size);
        }
    }

    retained
        .into_iter()
        .map(|snapshot| snapshot.entry.id.clone())
        .collect()
}

fn retention_bucket(age_ms: u64) -> Option<(u8, u64)> {
    if age_ms <= SNAPSHOT_DENSE_WINDOW_MS {
        None
    } else if age_ms <= SNAPSHOT_HOURLY_START_MS {
        Some((1, age_ms / TEN_MINUTES_MS))
    } else if age_ms <= SNAPSHOT_DAILY_START_MS {
        Some((2, age_ms / ONE_HOUR_MS))
    } else if age_ms <= SNAPSHOT_WEEKLY_START_MS {
        Some((3, age_ms / ONE_DAY_MS))
    } else if age_ms <= SNAPSHOT_MAX_AGE_MS {
        Some((4, age_ms / ONE_WEEK_MS))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::unique_temp_dir;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(prefix: &str) -> Self {
            Self(unique_temp_dir(prefix))
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn file_document() -> SnapshotDocument {
        SnapshotDocument::File {
            path: std::env::temp_dir()
                .join("draft.md")
                .to_string_lossy()
                .into_owned(),
            name: "draft.md".to_string(),
        }
    }

    fn draft_document(id: &str) -> SnapshotDocument {
        SnapshotDocument::Draft {
            id: id.to_string(),
            name: "Untitled.md".to_string(),
        }
    }

    fn snapshot_file(id: usize, created_at_ms: u64, size: u64) -> SnapshotFile {
        let hash = format!("{id:016x}");
        let snapshot_id = format!("{created_at_ms:020}-{hash}.md");
        SnapshotFile {
            entry: SnapshotEntry {
                id: snapshot_id.clone(),
                created_at_ms,
                size,
            },
            path: PathBuf::from(snapshot_id),
        }
    }

    fn snapshot_contents(root: &Path, document: &SnapshotDocument) -> Vec<String> {
        list_snapshot_files(root, document)
            .expect("list snapshots")
            .iter()
            .map(|snapshot| {
                read_snapshot_at(root, document, &snapshot.entry.id).expect("read snapshot")
            })
            .collect()
    }

    #[test]
    fn snapshot_access_error_keeps_native_detail_out_of_its_user_message() {
        let detail = "/private/recovery/snapshots: No such file or directory";

        let error = snapshot_access_error(detail);

        assert_eq!(error.category, crate::NativeFileErrorCategory::Unknown);
        assert_eq!(error.operation, NativeFileOperation::AccessRecoveryData);
        assert_eq!(error.message, SNAPSHOT_ACCESS_ERROR_MESSAGE);
        assert_eq!(error.detail, detail);
        assert!(!error.message.contains("/private/recovery"));
    }

    #[test]
    fn write_snapshot_creates_missing_app_data_directories() {
        let root = TestDir::new("snapshot-create");

        let result = write_snapshot_at(root.path(), &file_document(), "first words", 1_000)
            .expect("snapshot should write");

        assert_eq!(result.snapshot.size, 11);
        assert!(root.path().join(file_document().storage_key()).is_dir());
    }

    #[test]
    fn write_snapshot_reports_an_unusable_app_data_root_without_overwriting_it() {
        let root = TestDir::new("snapshot-unusable-root");
        fs::write(root.path(), "not a directory").expect("create unusable root");

        let error = write_snapshot_at(root.path(), &file_document(), "first words", 1_000)
            .expect_err("snapshot should fail");

        assert!(error.starts_with("Failed to create snapshot directory:"));
        assert_eq!(
            fs::read_to_string(root.path()).expect("root file should survive"),
            "not a directory"
        );
    }

    #[test]
    fn write_snapshot_merges_rapid_distinct_content() {
        let root = TestDir::new("snapshot-merge");
        let document = file_document();
        write_snapshot_at(root.path(), &document, "first", 1_000).expect("first snapshot");

        let result =
            write_snapshot_at(root.path(), &document, "second", 9_000).expect("merged snapshot");
        let snapshots = list_snapshot_files(root.path(), &document).expect("list snapshots");

        assert!(result.merged && snapshots.len() == 1);
        assert_eq!(
            read_snapshot_at(root.path(), &document, &snapshots[0].entry.id)
                .expect("read merged snapshot"),
            "second"
        );
    }

    #[test]
    fn write_snapshot_keeps_versions_outside_merge_window() {
        let root = TestDir::new("snapshot-versions");
        let document = file_document();
        write_snapshot_at(root.path(), &document, "first", 1_000).expect("first snapshot");

        write_snapshot_at(root.path(), &document, "second", 11_001).expect("second snapshot");
        let snapshots = list_snapshot_files(root.path(), &document).expect("list snapshots");

        assert_eq!(snapshots.len(), 2);
    }

    #[test]
    fn monotonic_timestamps_keep_the_restore_backup_when_the_raw_clock_is_tied() {
        let root = TestDir::new("snapshot-monotonic-tie");
        let document = file_document();
        let raw_now_ms = 1_000;
        let backup = "before restore";
        let restored = "restored words";
        let automatic = "new automatic words";
        let backup_old_id = format!("{raw_now_ms:020}-{}.md", stable_hash_hex(backup.as_bytes()));
        let restored_old_id = format!(
            "{raw_now_ms:020}-{}.md",
            stable_hash_hex(restored.as_bytes())
        );
        assert!(
            backup_old_id > restored_old_id,
            "the old equal-timestamp ordering must choose the backup first"
        );

        write_snapshot_at_with_merge(root.path(), &document, backup, raw_now_ms, false)
            .expect("backup snapshot");
        write_snapshot_at_with_merge(root.path(), &document, restored, raw_now_ms, false)
            .expect("restored checkpoint");
        let result = write_snapshot_at(root.path(), &document, automatic, raw_now_ms + 1)
            .expect("automatic snapshot");
        let contents = snapshot_contents(root.path(), &document);

        assert!(result.merged);
        assert_eq!(contents, vec![automatic, backup]);
    }

    #[test]
    fn write_snapshot_reports_timestamp_exhaustion_without_deleting_the_latest_snapshot() {
        let root = TestDir::new("snapshot-timestamp-exhaustion");
        let document = file_document();
        write_snapshot_at_with_merge(root.path(), &document, "latest words", u64::MAX, false)
            .expect("latest snapshot");

        let error = write_snapshot_at_with_merge(
            root.path(),
            &document,
            "different words",
            u64::MAX,
            false,
        )
        .expect_err("timestamp exhaustion must fail");
        let snapshots = list_snapshot_files(root.path(), &document).expect("list snapshots");

        assert_eq!(error, "Snapshot timestamp limit exhausted.");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            read_snapshot_at(root.path(), &document, &snapshots[0].entry.id)
                .expect("read latest snapshot"),
            "latest words"
        );
    }

    #[test]
    fn preserved_restore_boundary_does_not_merge_rapid_snapshots() {
        let root = TestDir::new("snapshot-preserved-boundary");
        let document = file_document();
        write_snapshot_at(root.path(), &document, "before restore", 1_000)
            .expect("backup snapshot");

        let result =
            write_snapshot_at_with_merge(root.path(), &document, "restored words", 2_000, false)
                .expect("restored snapshot");
        let snapshots = list_snapshot_files(root.path(), &document).expect("list snapshots");
        let contents = snapshot_contents(root.path(), &document);

        assert!(!result.merged);
        assert_eq!(snapshots.len(), 2);
        assert_eq!(contents, vec!["restored words", "before restore"]);
    }

    #[test]
    fn preserved_periodic_checkpoints_retain_each_interval() {
        let root = TestDir::new("snapshot-periodic-checkpoints");
        let document = file_document();

        for (created_at_ms, content) in [
            (0, "first checkpoint"),
            (SNAPSHOT_MERGE_WINDOW_MS, "second checkpoint"),
            (2 * SNAPSHOT_MERGE_WINDOW_MS, "third checkpoint"),
        ] {
            write_snapshot_at_with_merge(root.path(), &document, content, created_at_ms, false)
                .expect("periodic checkpoint");
        }

        let snapshots = list_snapshot_files(root.path(), &document).expect("list snapshots");

        assert_eq!(snapshots.len(), 3);
    }

    #[test]
    fn write_snapshot_skips_identical_consecutive_content() {
        let root = TestDir::new("snapshot-identical");
        let document = file_document();
        write_snapshot_at(root.path(), &document, "same", 1_000).expect("first snapshot");

        let result = write_snapshot_at(root.path(), &document, "same", 20_000)
            .expect("unchanged snapshot result");
        let snapshots = list_snapshot_files(root.path(), &document).expect("list snapshots");

        assert!(result.unchanged && snapshots.len() == 1);
    }

    #[test]
    fn unused_snapshot_path_uses_a_suffix_when_timestamp_and_hash_path_exists() {
        let root = TestDir::new("snapshot-id-collision");
        let document = file_document();
        let stream_dir = root.path().join(document.storage_key());
        fs::create_dir_all(&stream_dir).expect("create stream");
        ensure_identity(&stream_dir, &document).expect("write identity");
        let hash = stable_hash_hex(b"new words");
        fs::write(
            stream_dir.join(format!("{:020}-{hash}.md", 0)),
            "different words",
        )
        .expect("write colliding path");

        let (snapshot_id, snapshot_path) = unused_snapshot_path(&stream_dir, 0, &hash)
            .expect("snapshot should avoid existing path");

        assert!(snapshot_id.ends_with("-1.md"));
        assert_eq!(snapshot_path, stream_dir.join(snapshot_id));
    }

    #[test]
    fn retention_keeps_all_dense_recent_snapshots() {
        let now = ONE_DAY_MS;
        let snapshots = (0..20)
            .map(|index| snapshot_file(index, now - index as u64 * 20_000, 10))
            .collect::<Vec<_>>();

        let retained = retained_snapshot_ids(&snapshots, now);

        assert_eq!(retained.len(), snapshots.len());
    }

    #[test]
    fn retention_thins_older_snapshots_by_age_bucket() {
        let now = 40 * ONE_DAY_MS;
        let snapshots = vec![
            snapshot_file(1, now - 11 * 60 * 1_000, 10),
            snapshot_file(2, now - 12 * 60 * 1_000, 10),
            snapshot_file(3, now - 2 * ONE_HOUR_MS, 10),
            snapshot_file(4, now - 2 * ONE_HOUR_MS - 1_000, 10),
            snapshot_file(5, now - 2 * ONE_DAY_MS, 10),
            snapshot_file(6, now - 2 * ONE_DAY_MS - 1_000, 10),
            snapshot_file(7, now - 35 * ONE_DAY_MS, 10),
            snapshot_file(8, now - 35 * ONE_DAY_MS - 1_000, 10),
        ];

        let retained = retained_snapshot_ids(&snapshots, now);

        assert_eq!(retained.len(), 4);
    }

    #[test]
    fn retention_drops_snapshots_older_than_the_maximum_age() {
        let now = 100 * ONE_DAY_MS;
        let snapshots = vec![
            snapshot_file(1, now - 89 * ONE_DAY_MS, 10),
            snapshot_file(2, now - 91 * ONE_DAY_MS, 10),
        ];

        let retained = retained_snapshot_ids(&snapshots, now);

        assert!(retained.contains(&snapshots[0].entry.id));
        assert!(!retained.contains(&snapshots[1].entry.id));
    }

    #[test]
    fn retention_enforces_count_cap_after_thinning() {
        let now = ONE_DAY_MS;
        let snapshots = (0..120)
            .map(|index| snapshot_file(index, now - index as u64 * 1_000, 1))
            .collect::<Vec<_>>();

        let retained = retained_snapshot_ids(&snapshots, now);

        assert_eq!(retained.len(), SNAPSHOT_MAX_COUNT);
    }

    #[test]
    fn retention_enforces_byte_cap_without_dropping_newest() {
        let now = ONE_DAY_MS;
        let snapshots = vec![
            snapshot_file(1, now, SNAPSHOT_MAX_BYTES),
            snapshot_file(2, now - 1_000, 1),
        ];

        let retained = retained_snapshot_ids(&snapshots, now);

        assert_eq!(retained.len(), 1);
    }

    #[test]
    fn clock_rollback_still_merges_with_latest_snapshot() {
        let root = TestDir::new("snapshot-clock-rollback");
        let document = file_document();
        write_snapshot_at_with_merge(root.path(), &document, "boundary", 19_000, false)
            .expect("boundary snapshot");
        write_snapshot_at_with_merge(root.path(), &document, "future", 20_000, false)
            .expect("future snapshot");

        let result = write_snapshot_at(root.path(), &document, "clock moved", 10_000)
            .expect("clock rollback snapshot");
        let contents = snapshot_contents(root.path(), &document);

        assert!(result.merged);
        assert_eq!(result.snapshot.created_at_ms, 20_001);
        assert_eq!(contents, vec!["clock moved", "boundary"]);
    }

    #[test]
    fn read_snapshot_rejects_path_traversal_ids() {
        let root = TestDir::new("snapshot-traversal");

        let error = read_snapshot_at(root.path(), &file_document(), "../identity.json")
            .expect_err("path traversal must fail");

        assert_eq!(error, "Invalid snapshot id.");
    }

    #[test]
    fn list_drafts_returns_recoverable_crash_orphans() {
        let root = TestDir::new("snapshot-drafts");
        write_snapshot_at(root.path(), &draft_document("draft-1"), "recover me", 5_000)
            .expect("draft snapshot");

        let result = list_drafts_at(root.path(), 6_000).expect("list drafts");

        assert_eq!(result.drafts[0].id, "draft-1");
    }

    #[test]
    fn list_drafts_returns_empty_when_app_data_is_missing() {
        let root = TestDir::new("snapshot-missing");

        let result = list_drafts_at(root.path(), 6_000).expect("missing root should be empty");

        assert!(result.drafts.is_empty());
    }

    #[test]
    fn list_drafts_hides_expired_streams_without_deleting_recovery_data() {
        let root = TestDir::new("snapshot-expired-draft");
        let document = draft_document("expired-draft");
        write_snapshot_at(root.path(), &document, "expired words", 1_000).expect("draft snapshot");
        let stream_dir = root.path().join(document.storage_key());

        let result = list_drafts_at(root.path(), 1_001 + SNAPSHOT_MAX_AGE_MS).expect("list drafts");

        assert!(result.drafts.is_empty());
        assert!(stream_dir.is_dir());
    }

    #[test]
    fn list_drafts_keeps_streams_at_the_retention_horizon() {
        let root = TestDir::new("snapshot-horizon-draft");
        let document = draft_document("horizon-draft");
        write_snapshot_at(root.path(), &document, "still recoverable", 1_000)
            .expect("draft snapshot");
        let stream_dir = root.path().join(document.storage_key());

        let result = list_drafts_at(root.path(), 1_000 + SNAPSHOT_MAX_AGE_MS).expect("list drafts");

        assert_eq!(result.drafts[0].id, "horizon-draft");
        assert!(stream_dir.is_dir());
    }

    #[test]
    fn retire_draft_removes_only_the_validated_draft_stream() {
        let root = TestDir::new("snapshot-retire-draft");
        let retired = draft_document("retired-draft");
        let retained = draft_document("retained-draft");
        write_snapshot_at(root.path(), &retired, "retire me", 1_000)
            .expect("retired draft snapshot");
        write_snapshot_at(root.path(), &retained, "keep me", 1_000)
            .expect("retained draft snapshot");

        retire_draft_at(root.path(), &retired).expect("retire draft");

        assert!(!root.path().join(retired.storage_key()).exists());
        assert!(root.path().join(retained.storage_key()).exists());
    }

    #[cfg(unix)]
    fn staged_outside_draft_stream(outside_root: &Path, document: &SnapshotDocument) -> PathBuf {
        // A draft stream that an older Bindars could have written through the
        // link: a valid matching identity plus a content file.
        let outside_stream = outside_root.join(document.storage_key());
        fs::create_dir_all(&outside_stream).expect("create outside stream");
        fs::write(outside_stream.join("precious.md"), "keep me").expect("write outside file");
        let identity = SnapshotIdentity {
            version: SNAPSHOT_SCHEMA_VERSION,
            document: document.clone(),
        };
        fs::write(
            outside_stream.join("identity.json"),
            serde_json::to_string(&identity).expect("encode identity"),
        )
        .expect("write outside identity");
        outside_stream
    }

    #[cfg(unix)]
    #[test]
    fn retire_draft_refuses_a_symlinked_snapshots_ancestor() {
        let app_data = TestDir::new("snapshot-retire-ancestor-symlink");
        let outside = TestDir::new("snapshot-retire-ancestor-outside");
        let document = draft_document("victim-draft");
        let outside_stream = staged_outside_draft_stream(&outside.path().join("v1"), &document);
        fs::create_dir_all(app_data.path()).expect("create app-data");
        std::os::unix::fs::symlink(outside.path(), app_data.path().join("snapshots"))
            .expect("symlink snapshots parent");

        let error = retire_draft_at(&app_data.path().join("snapshots").join("v1"), &document)
            .expect_err("a symlinked snapshots ancestor must refuse retirement");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read_to_string(outside_stream.join("precious.md"))
                .expect("outside stream contents should survive"),
            "keep me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn retire_draft_refuses_a_symlinked_v1() {
        let app_data = TestDir::new("snapshot-retire-v1-symlink");
        let outside = TestDir::new("snapshot-retire-v1-outside");
        let document = draft_document("victim-draft");
        let outside_stream = staged_outside_draft_stream(outside.path(), &document);
        let snapshots_parent = app_data.path().join("snapshots");
        fs::create_dir_all(&snapshots_parent).expect("create snapshots parent");
        std::os::unix::fs::symlink(outside.path(), snapshots_parent.join("v1"))
            .expect("symlink v1");

        let error = retire_draft_at(&snapshots_parent.join("v1"), &document)
            .expect_err("a symlinked v1 must refuse retirement");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read_to_string(outside_stream.join("precious.md"))
                .expect("outside stream contents should survive"),
            "keep me"
        );
    }

    #[test]
    fn retire_draft_rejects_file_snapshot_streams() {
        let root = TestDir::new("snapshot-retire-file");

        let error = retire_draft_at(root.path(), &file_document())
            .expect_err("file stream retirement must fail");

        assert_eq!(error, "Only draft snapshot streams can be retired.");
    }

    #[test]
    fn retire_draft_is_idempotent_when_the_stream_is_already_absent() {
        let root = TestDir::new("snapshot-retire-missing");

        retire_draft_at(root.path(), &draft_document("already-retired"))
            .expect("missing draft retirement should succeed");
    }

    #[test]
    fn ensure_identity_rejects_hash_collisions() {
        let root = TestDir::new("snapshot-collision");
        fs::create_dir_all(root.path()).expect("create stream");
        ensure_identity(root.path(), &file_document()).expect("first identity");
        let other = SnapshotDocument::File {
            path: std::env::temp_dir()
                .join("other.md")
                .to_string_lossy()
                .into_owned(),
            name: "other.md".to_string(),
        };

        let error = ensure_identity(root.path(), &other).expect_err("collision must fail");

        assert_eq!(error, "Snapshot identity hash collision detected.");
    }

    #[test]
    fn ensure_identity_does_not_downgrade_an_unknown_schema() {
        let root = TestDir::new("snapshot-newer-schema");
        fs::create_dir_all(root.path()).expect("create stream");
        let identity = SnapshotIdentity {
            version: SNAPSHOT_SCHEMA_VERSION + 1,
            document: file_document(),
        };
        fs::write(
            root.path().join("identity.json"),
            serde_json::to_string(&identity).expect("encode identity"),
        )
        .expect("write identity");

        let error = ensure_identity(root.path(), &file_document())
            .expect_err("unknown schema must not be replaced");

        assert_eq!(error, "Unsupported snapshot identity version: 2.");
    }

    #[cfg(unix)]
    fn unix_mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::symlink_metadata(path)
            .expect("inspect mode")
            .permissions()
            .mode()
    }

    #[cfg(unix)]
    #[test]
    fn write_snapshot_creates_owner_only_directories_and_files() {
        let root = TestDir::new("snapshot-private-create");
        let document = file_document();

        write_snapshot_at(root.path(), &document, "private words", 1_000)
            .expect("snapshot should write");

        let stream_dir = root.path().join(document.storage_key());
        assert_eq!(unix_mode(root.path()) & 0o077, 0);
        assert_eq!(unix_mode(&stream_dir) & 0o077, 0);
        let mut file_count = 0;
        for entry in fs::read_dir(&stream_dir).expect("list stream") {
            let path = entry.expect("stream entry").path();
            assert_eq!(
                unix_mode(&path) & 0o077,
                0,
                "expected owner-only mode for {path:?}"
            );
            file_count += 1;
        }
        assert_eq!(file_count, 2, "expected the snapshot and identity files");
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_snapshot_data_tightens_legacy_modes_including_the_snapshots_parent() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-harden-legacy");
        let snapshots_parent = app_data.path().join("snapshots");
        let root = snapshots_parent.join("v1");
        let document = file_document();
        write_snapshot_at(&root, &document, "legacy words", 1_000).expect("snapshot should write");
        let stream_dir = root.join(document.storage_key());
        fs::set_permissions(&snapshots_parent, fs::Permissions::from_mode(0o755))
            .expect("loosen snapshots parent");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).expect("loosen root");
        fs::set_permissions(&stream_dir, fs::Permissions::from_mode(0o755)).expect("loosen stream");
        for entry in fs::read_dir(&stream_dir).expect("list stream") {
            let path = entry.expect("stream entry").path();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("loosen file");
        }

        let failures = harden_existing_snapshot_data(&root);

        assert_eq!(failures, 0);
        assert_eq!(unix_mode(&snapshots_parent) & 0o077, 0);
        assert_eq!(unix_mode(&root) & 0o077, 0);
        assert_eq!(unix_mode(&stream_dir) & 0o077, 0);
        for entry in fs::read_dir(&stream_dir).expect("list hardened stream") {
            let path = entry.expect("stream entry").path();
            assert_eq!(
                unix_mode(&path) & 0o077,
                0,
                "expected owner-only mode for {path:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_snapshot_data_refuses_a_symlinked_snapshots_ancestor() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-harden-ancestor-symlink");
        let outside = TestDir::new("snapshot-harden-ancestor-outside");
        let outside_v1 = outside.path().join("v1");
        let outside_stream = outside_v1.join("stream");
        fs::create_dir_all(&outside_stream).expect("create outside tree");
        let outside_file = outside_stream.join("unrelated.md");
        fs::write(&outside_file, "not ours").expect("write outside file");
        fs::set_permissions(&outside_v1, fs::Permissions::from_mode(0o755))
            .expect("mode outside v1");
        fs::set_permissions(&outside_stream, fs::Permissions::from_mode(0o755))
            .expect("mode outside stream");
        fs::set_permissions(&outside_file, fs::Permissions::from_mode(0o644))
            .expect("mode outside file");
        fs::create_dir_all(app_data.path()).expect("create app-data");
        std::os::unix::fs::symlink(outside.path(), app_data.path().join("snapshots"))
            .expect("symlink snapshots parent");

        let failures = harden_existing_snapshot_data(&app_data.path().join("snapshots").join("v1"));

        assert_eq!(failures, 0);
        assert_eq!(unix_mode(&outside_v1) & 0o777, 0o755);
        assert_eq!(unix_mode(&outside_stream) & 0o777, 0o755);
        assert_eq!(unix_mode(&outside_file) & 0o777, 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_snapshot_data_tightens_the_parent_when_v1_is_absent() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-harden-parent-only");
        let snapshots_parent = app_data.path().join("snapshots");
        fs::create_dir_all(&snapshots_parent).expect("create snapshots parent");
        fs::set_permissions(&snapshots_parent, fs::Permissions::from_mode(0o755))
            .expect("loosen snapshots parent");

        let failures = harden_existing_snapshot_data(&snapshots_parent.join("v1"));

        assert_eq!(failures, 0);
        assert_eq!(unix_mode(&snapshots_parent) & 0o077, 0);
    }

    #[cfg(unix)]
    #[test]
    fn write_snapshot_normalizes_directory_modes_to_exactly_owner_rwx() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-normalize-modes");
        let snapshots_parent = app_data.path().join("snapshots");
        let root = snapshots_parent.join("v1");
        let document = file_document();
        let stream_dir = root.join(document.storage_key());
        fs::create_dir_all(&stream_dir).expect("pre-create stream chain");
        for (path, mode) in [
            (&snapshots_parent, 0o770),
            (&root, 0o750),
            (&stream_dir, 0o300),
        ] {
            fs::set_permissions(path, fs::Permissions::from_mode(mode))
                .expect("preset anomalous mode");
        }

        write_snapshot_at(&root, &document, "normalized words", 1_000)
            .expect("snapshot should write");

        assert_eq!(unix_mode(&snapshots_parent) & 0o777, 0o700);
        assert_eq!(unix_mode(&root) & 0o777, 0o700);
        assert_eq!(unix_mode(&stream_dir) & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn write_snapshot_refuses_a_symlinked_snapshots_ancestor() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-write-ancestor-symlink");
        let outside = TestDir::new("snapshot-write-ancestor-outside");
        let document = file_document();
        let outside_v1 = outside.path().join("v1");
        let outside_stream = outside_v1.join(document.storage_key());
        fs::create_dir_all(&outside_stream).expect("create outside tree");
        let outside_snapshot = outside_stream.join(format!("{:020}-{:016x}.md", 500, 0));
        fs::write(&outside_snapshot, "not ours").expect("write snapshot-shaped outside file");
        fs::set_permissions(&outside_v1, fs::Permissions::from_mode(0o755))
            .expect("mode outside v1");
        fs::set_permissions(&outside_stream, fs::Permissions::from_mode(0o755))
            .expect("mode outside stream");
        fs::create_dir_all(app_data.path()).expect("create app-data");
        std::os::unix::fs::symlink(outside.path(), app_data.path().join("snapshots"))
            .expect("symlink snapshots parent");

        let error = write_snapshot_at(
            &app_data.path().join("snapshots").join("v1"),
            &document,
            "escaped words",
            1_000,
        )
        .expect_err("a symlinked snapshots ancestor must refuse the write");

        assert!(error.contains("symlink"));
        assert_eq!(unix_mode(&outside_v1) & 0o777, 0o755);
        assert_eq!(unix_mode(&outside_stream) & 0o777, 0o755);
        assert!(!outside_stream.join("identity.json").exists());
        assert_eq!(
            fs::read_to_string(&outside_snapshot)
                .expect("snapshot-shaped outside file should survive"),
            "not ours"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_snapshot_refuses_a_symlinked_v1() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-write-v1-symlink");
        let outside = TestDir::new("snapshot-write-v1-outside");
        let document = file_document();
        let outside_stream = outside.path().join(document.storage_key());
        fs::create_dir_all(&outside_stream).expect("create outside tree");
        let outside_snapshot = outside_stream.join(format!("{:020}-{:016x}.md", 500, 0));
        fs::write(&outside_snapshot, "not ours").expect("write snapshot-shaped outside file");
        fs::set_permissions(outside.path(), fs::Permissions::from_mode(0o755))
            .expect("mode outside dir");
        fs::set_permissions(&outside_stream, fs::Permissions::from_mode(0o755))
            .expect("mode outside stream");
        let snapshots_parent = app_data.path().join("snapshots");
        fs::create_dir_all(&snapshots_parent).expect("create snapshots parent");
        std::os::unix::fs::symlink(outside.path(), snapshots_parent.join("v1"))
            .expect("symlink v1");

        let error = write_snapshot_at(
            &snapshots_parent.join("v1"),
            &document,
            "escaped words",
            1_000,
        )
        .expect_err("a symlinked v1 must refuse the write");

        assert!(error.contains("symlink"));
        assert_eq!(unix_mode(outside.path()) & 0o777, 0o755);
        assert_eq!(unix_mode(&outside_stream) & 0o777, 0o755);
        assert!(!outside_stream.join("identity.json").exists());
        assert_eq!(
            fs::read_to_string(&outside_snapshot)
                .expect("snapshot-shaped outside file should survive"),
            "not ours"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_snapshot_repairs_untraversable_owned_directories_before_descending() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = TestDir::new("snapshot-repair-untraversable");
        let snapshots_parent = app_data.path().join("snapshots");
        let root = snapshots_parent.join("v1");
        fs::create_dir_all(&root).expect("pre-create chain");
        // A hostile umask at creation time leaves modes like these: 0600 has
        // no owner-execute, so nothing below it is reachable until repaired.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).expect("read-only v1");
        fs::set_permissions(&snapshots_parent, fs::Permissions::from_mode(0o600))
            .expect("untraversable snapshots");
        let document = file_document();

        write_snapshot_at(&root, &document, "healed words", 1_000)
            .expect("the write should repair the chain and succeed");

        assert_eq!(unix_mode(&snapshots_parent) & 0o777, 0o700);
        assert_eq!(unix_mode(&root) & 0o777, 0o700);
        assert_eq!(unix_mode(&root.join(document.storage_key())) & 0o777, 0o700);
    }

    // Runs only as a subprocess of write_snapshot_succeeds_under_a_hostile_umask:
    // the umask is process-global, so flipping it inside this parallel test
    // process would corrupt every concurrently running test.
    #[cfg(unix)]
    #[test]
    #[ignore = "subprocess helper for write_snapshot_succeeds_under_a_hostile_umask"]
    fn umask_subprocess_helper_writes_one_snapshot() {
        let root = PathBuf::from(
            std::env::var("BINDARS_UMASK_TEST_ROOT").expect("BINDARS_UMASK_TEST_ROOT must be set"),
        )
        .join("snapshots")
        .join("v1");

        write_snapshot_at(&root, &file_document(), "masked words", 1_000)
            .expect("write under a hostile umask should succeed");
    }

    #[cfg(unix)]
    #[test]
    fn write_snapshot_succeeds_under_a_hostile_umask() {
        let app_data = TestDir::new("snapshot-hostile-umask");
        fs::create_dir_all(app_data.path()).expect("create app-data");
        let exe = std::env::current_exe().expect("locate test binary");

        // umask 0177 turns a requested 0o700 directory into 0o600, which is
        // untraversable; creation must succeed anyway by fixing each mode
        // immediately after each mkdir.
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(
                "umask 0177 && exec \"$0\" \
                 --exact snapshots::tests::umask_subprocess_helper_writes_one_snapshot --ignored",
            )
            .arg(&exe)
            .env("BINDARS_UMASK_TEST_ROOT", app_data.path())
            .output()
            .expect("spawn umask subprocess");

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "subprocess failed:\n{stdout}\n{stderr}"
        );
        assert!(
            stdout.contains("1 passed"),
            "the helper test must actually run:\n{stdout}\n{stderr}"
        );
        let snapshots_parent = app_data.path().join("snapshots");
        let root = snapshots_parent.join("v1");
        let stream_dir = root.join(file_document().storage_key());
        assert_eq!(unix_mode(&snapshots_parent) & 0o777, 0o700);
        assert_eq!(unix_mode(&root) & 0o777, 0o700);
        assert_eq!(unix_mode(&stream_dir) & 0o777, 0o700);
        for entry in fs::read_dir(&stream_dir).expect("list stream") {
            let path = entry.expect("stream entry").path();
            assert_eq!(
                unix_mode(&path) & 0o777,
                0o600,
                "expected 0600 for {path:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_snapshot_data_leaves_a_parent_not_named_snapshots_alone() {
        use std::os::unix::fs::PermissionsExt;

        let parent = TestDir::new("snapshot-harden-parent-guard");
        let root = parent.path().join("v1");
        write_snapshot_at(&root, &file_document(), "guarded words", 1_000)
            .expect("snapshot should write");
        fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o755))
            .expect("loosen parent");

        let failures = harden_existing_snapshot_data(&root);

        assert_eq!(failures, 0);
        assert_eq!(unix_mode(parent.path()) & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_snapshot_data_is_harmless_without_a_root() {
        let root = TestDir::new("snapshot-harden-missing");

        assert_eq!(harden_existing_snapshot_data(root.path()), 0);
        assert!(!root.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn harden_existing_snapshot_data_never_chmods_through_symlinks() {
        use std::os::unix::fs::PermissionsExt;

        let root = TestDir::new("snapshot-harden-symlink");
        fs::create_dir_all(root.path()).expect("create root");
        let outside = TestDir::new("snapshot-harden-outside");
        fs::create_dir_all(outside.path()).expect("create outside dir");
        let outside_file = outside.path().join("document.md");
        fs::write(&outside_file, "outside words").expect("write outside file");
        fs::set_permissions(outside.path(), fs::Permissions::from_mode(0o755))
            .expect("mode outside dir");
        fs::set_permissions(&outside_file, fs::Permissions::from_mode(0o644))
            .expect("mode outside file");
        std::os::unix::fs::symlink(outside.path(), root.path().join("draft-linked"))
            .expect("symlink into root");

        let failures = harden_existing_snapshot_data(root.path());

        assert_eq!(failures, 0);
        assert_eq!(unix_mode(outside.path()) & 0o777, 0o755);
        assert_eq!(unix_mode(&outside_file) & 0o777, 0o644);
    }

    #[test]
    fn storage_stats_count_streams_snapshots_and_logical_file_bytes() {
        let app_data = TestDir::new("snapshot-storage-stats");
        let root = app_data.path().join("snapshots").join("v1");
        let file = file_document();
        let draft = draft_document("storage-draft");
        let file_write =
            write_snapshot_at(&root, &file, "file words", 1_000).expect("file snapshot");
        let draft_write =
            write_snapshot_at(&root, &draft, "draft words", 2_000).expect("draft snapshot");
        let expected_bytes = [
            root.join(file.storage_key()).join("identity.json"),
            root.join(file.storage_key()).join(file_write.snapshot.id),
            root.join(draft.storage_key()).join("identity.json"),
            root.join(draft.storage_key()).join(draft_write.snapshot.id),
        ]
        .iter()
        .map(|path| fs::metadata(path).expect("recovery file metadata").len())
        .sum();

        let stats = snapshot_storage_stats_at(&root).expect("storage stats");

        assert_eq!(
            stats,
            SnapshotStorageStats {
                stream_count: 2,
                snapshot_count: 2,
                total_bytes: expected_bytes,
                skipped_count: 0,
            }
        );
    }

    #[test]
    fn storage_stats_are_empty_when_recovery_storage_is_missing() {
        let app_data = TestDir::new("snapshot-storage-stats-missing");
        let root = app_data.path().join("snapshots").join("v1");

        let stats = snapshot_storage_stats_at(&root).expect("missing storage stats");

        assert_eq!(
            stats,
            SnapshotStorageStats {
                stream_count: 0,
                snapshot_count: 0,
                total_bytes: 0,
                skipped_count: 0,
            }
        );
        assert!(!app_data.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn storage_stats_never_follow_symlinked_streams() {
        let app_data = TestDir::new("snapshot-storage-stats-stream-symlink");
        let outside = TestDir::new("snapshot-storage-stats-stream-outside");
        let root = app_data.path().join("snapshots").join("v1");
        let document = file_document();
        let write =
            write_snapshot_at(&root, &document, "safe words", 1_000).expect("safe snapshot");
        fs::create_dir_all(outside.path()).expect("create outside stream");
        fs::write(outside.path().join("identity.json"), "outside identity")
            .expect("write outside identity");
        fs::write(
            outside
                .path()
                .join("00000000000000002000-deadbeefdeadbeef.md"),
            "outside words",
        )
        .expect("write outside snapshot");
        std::os::unix::fs::symlink(outside.path(), root.join("linked-stream"))
            .expect("link outside stream");
        let stream = root.join(document.storage_key());
        let expected_bytes = fs::metadata(stream.join("identity.json"))
            .expect("identity metadata")
            .len()
            + fs::metadata(stream.join(write.snapshot.id))
                .expect("snapshot metadata")
                .len();

        let stats = snapshot_storage_stats_at(&root).expect("storage stats");

        assert_eq!(
            stats,
            SnapshotStorageStats {
                stream_count: 1,
                snapshot_count: 1,
                total_bytes: expected_bytes,
                skipped_count: 1,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn storage_stats_never_follow_symlinked_files_inside_a_real_stream() {
        let app_data = TestDir::new("snapshot-storage-stats-file-symlink");
        let outside = TestDir::new("snapshot-storage-stats-file-outside");
        let root = app_data.path().join("snapshots").join("v1");
        let document = file_document();
        let write =
            write_snapshot_at(&root, &document, "safe words", 1_000).expect("safe snapshot");
        let stream = root.join(document.storage_key());
        fs::create_dir_all(outside.path()).expect("create outside directory");
        let outside_snapshot = outside
            .path()
            .join("00000000000000002000-deadbeefdeadbeef.md");
        fs::write(&outside_snapshot, "outside words").expect("write outside snapshot");
        std::os::unix::fs::symlink(
            &outside_snapshot,
            stream.join("00000000000000003000-feedfacefeedface.md"),
        )
        .expect("link outside snapshot");
        let expected_bytes = fs::metadata(stream.join("identity.json"))
            .expect("identity metadata")
            .len()
            + fs::metadata(stream.join(write.snapshot.id))
                .expect("snapshot metadata")
                .len();

        let stats = snapshot_storage_stats_at(&root).expect("storage stats");

        assert_eq!(
            stats,
            SnapshotStorageStats {
                stream_count: 1,
                snapshot_count: 1,
                total_bytes: expected_bytes,
                skipped_count: 1,
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn storage_stats_refuse_a_symlinked_v1() {
        let app_data = TestDir::new("snapshot-storage-stats-v1-symlink");
        let outside = TestDir::new("snapshot-storage-stats-v1-outside");
        let snapshots_dir = app_data.path().join("snapshots");
        fs::create_dir_all(&snapshots_dir).expect("create snapshots directory");
        fs::create_dir_all(outside.path()).expect("create outside directory");
        fs::write(outside.path().join("precious.md"), "keep me").expect("write outside file");
        std::os::unix::fs::symlink(outside.path(), snapshots_dir.join("v1")).expect("symlink v1");

        let error = snapshot_storage_stats_at(&snapshots_dir.join("v1"))
            .expect_err("symlinked storage must fail");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read_to_string(outside.path().join("precious.md"))
                .expect("outside file should survive"),
            "keep me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn storage_stats_refuse_a_symlinked_snapshots_ancestor() {
        let app_data = TestDir::new("snapshot-storage-stats-ancestor-symlink");
        let outside = TestDir::new("snapshot-storage-stats-ancestor-outside");
        let outside_v1 = outside.path().join("v1");
        fs::create_dir_all(&outside_v1).expect("create outside v1");
        fs::write(outside_v1.join("precious.md"), "keep me").expect("write outside file");
        fs::create_dir_all(app_data.path()).expect("create app-data");
        std::os::unix::fs::symlink(outside.path(), app_data.path().join("snapshots"))
            .expect("symlink snapshots ancestor");

        let error = snapshot_storage_stats_at(&app_data.path().join("snapshots").join("v1"))
            .expect_err("symlinked snapshots ancestor must fail");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read_to_string(outside_v1.join("precious.md"))
                .expect("outside file should survive"),
            "keep me"
        );
    }

    #[test]
    fn clear_history_removes_only_the_v1_tree() {
        let app_data = TestDir::new("snapshot-clear");
        let root = app_data.path().join("snapshots").join("v1");
        write_snapshot_at(&root, &file_document(), "clear me", 1_000).expect("file snapshot");
        write_snapshot_at(&root, &draft_document("draft-1"), "clear me too", 1_000)
            .expect("draft snapshot");
        let app_data_neighbor = app_data.path().join("settings.json");
        fs::write(&app_data_neighbor, "{}").expect("write app-data neighbor");
        let snapshots_neighbor = app_data.path().join("snapshots").join("v2-preview");
        fs::write(&snapshots_neighbor, "future schema").expect("write snapshots neighbor");

        clear_history_under(app_data.path()).expect("clear history");

        assert!(!root.exists());
        assert_eq!(
            fs::read_to_string(&app_data_neighbor).expect("app-data neighbor should survive"),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(&snapshots_neighbor).expect("snapshots neighbor should survive"),
            "future schema"
        );
    }

    #[test]
    fn clear_history_succeeds_when_no_history_exists() {
        let missing_app_data = TestDir::new("snapshot-clear-missing");
        clear_history_under(missing_app_data.path())
            .expect("missing app-data should clear cleanly");

        let empty_app_data = TestDir::new("snapshot-clear-empty");
        fs::create_dir_all(empty_app_data.path()).expect("create app-data");
        clear_history_under(empty_app_data.path())
            .expect("app-data without snapshots should clear cleanly");
    }

    #[cfg(unix)]
    #[test]
    fn clear_history_refuses_a_symlinked_v1() {
        let app_data = TestDir::new("snapshot-clear-symlink");
        let target = app_data.path().join("real-data");
        fs::create_dir_all(&target).expect("create target");
        fs::write(target.join("precious.md"), "keep me").expect("write target file");
        fs::create_dir_all(app_data.path().join("snapshots")).expect("create snapshots");
        std::os::unix::fs::symlink(&target, app_data.path().join("snapshots").join("v1"))
            .expect("symlink v1");

        let error = clear_history_under(app_data.path()).expect_err("symlinked v1 must fail");

        assert!(error.contains("symlink"));
        assert_eq!(
            fs::read_to_string(target.join("precious.md")).expect("target should survive"),
            "keep me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn clear_history_refuses_a_symlinked_snapshots_ancestor() {
        let app_data = TestDir::new("snapshot-clear-ancestor-symlink");
        let outside = TestDir::new("snapshot-clear-outside");
        let outside_v1 = outside.path().join("v1");
        fs::create_dir_all(&outside_v1).expect("create outside v1");
        fs::write(outside_v1.join("unrelated.md"), "not ours").expect("write outside file");
        fs::create_dir_all(app_data.path()).expect("create app-data");
        std::os::unix::fs::symlink(outside.path(), app_data.path().join("snapshots"))
            .expect("symlink snapshots parent");

        let error = clear_history_under(app_data.path())
            .expect_err("a symlinked snapshots ancestor must fail");

        assert!(error.contains("symlink"));
        assert!(outside_v1.is_dir());
        assert_eq!(
            fs::read_to_string(outside_v1.join("unrelated.md"))
                .expect("outside file should survive"),
            "not ours"
        );
    }

    #[test]
    fn snapshots_resume_after_clearing_history() {
        let app_data = TestDir::new("snapshot-clear-resume");
        let root = app_data.path().join("snapshots").join("v1");
        let document = file_document();
        write_snapshot_at(&root, &document, "before clear", 1_000).expect("first snapshot");
        clear_history_under(app_data.path()).expect("clear history");

        write_snapshot_at(&root, &document, "after clear", 2_000).expect("snapshot after clear");

        let snapshots = list_snapshot_files(&root, &document).expect("list snapshots");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            read_snapshot_at(&root, &document, &snapshots[0].entry.id)
                .expect("read resumed snapshot"),
            "after clear"
        );
    }
}
