use notify::{self, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

/// Stores the file path passed via CLI arg (file association) for the frontend to consume.
struct CliFilePath(Mutex<Option<String>>);

struct WatcherState {
    _watcher: notify::RecommendedWatcher,
    stop_tx: mpsc::Sender<()>,
}

struct FileWatcher(Mutex<Option<WatcherState>>);

const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
const MAX_MARKDOWN_SIZE_MIB: u64 = MAX_MARKDOWN_BYTES / (1024 * 1024);
const DEFAULT_WORKSPACE_MAX_FILES: usize = 5_000;
const ABSOLUTE_WORKSPACE_MAX_FILES: usize = 20_000;
const MAX_WORKSPACE_DEPTH: usize = 32;

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
}

#[tauri::command]
fn get_cli_file_path(state: tauri::State<'_, CliFilePath>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn read_markdown_file(path: String) -> Result<String, String> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    read_markdown_contents(&canonical_path)
}

#[tauri::command]
fn resolve_markdown_path(path: String) -> Result<String, String> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    Ok(canonical_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_markdown_file(path: String) -> Result<OpenFileResult, String> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    let content = read_markdown_contents(&canonical_path)?;
    let revision = read_file_revision(&canonical_path)?;
    let canonical_path_str = canonical_path.to_string_lossy().into_owned();
    let name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| canonical_path_str.clone());

    Ok(OpenFileResult {
        canonical_path: canonical_path_str,
        name,
        content,
        revision,
    })
}

#[tauri::command]
/// Compatibility write command retained for non-editor writes and tests.
/// Editor save flows should use `write_markdown_file_if_unmodified`.
fn write_markdown_file(path: String, content: String) -> Result<(), String> {
    let requested_path = PathBuf::from(&path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "Content is too large. Maximum supported size is {} MiB.",
            MAX_MARKDOWN_SIZE_MIB
        ));
    }

    write_markdown_contents_atomic(&canonical_path, &content)?;
    Ok(())
}

#[tauri::command]
fn write_markdown_file_if_unmodified(
    path: String,
    content: String,
    expected_revision: Option<FileRevision>,
    force: Option<bool>,
) -> Result<ConditionalWriteResult, String> {
    let requested_path = PathBuf::from(&path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "Content is too large. Maximum supported size is {} MiB.",
            MAX_MARKDOWN_SIZE_MIB
        ));
    }

    let current_revision = read_file_revision(&canonical_path)?;
    let force_save = force.unwrap_or(false);
    if !force_save {
        let expected = expected_revision.ok_or_else(|| {
            "Missing expected revision for conditional write.".to_string()
        })?;
        if expected != current_revision {
            return Ok(ConditionalWriteResult {
                conflict: true,
                current_revision,
            });
        }
    }

    write_markdown_contents_atomic(&canonical_path, &content)?;
    let new_revision = read_file_revision(&canonical_path)?;
    Ok(ConditionalWriteResult {
        conflict: false,
        current_revision: new_revision,
    })
}

#[tauri::command]
fn export_html_file(path: String, content: String) -> Result<(), String> {
    let requested_path = PathBuf::from(&path);

    // Only allow .html extension for export
    match requested_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") => {}
        _ => return Err("Export file must have .html or .htm extension.".to_string()),
    }

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "Content is too large. Maximum supported size is {} MiB.",
            MAX_MARKDOWN_SIZE_MIB
        ));
    }

    // Resolve parent directory to ensure it exists
    let parent = requested_path
        .parent()
        .ok_or_else(|| "Cannot determine parent directory.".to_string())?;
    if !parent.exists() {
        return Err("Parent directory does not exist.".to_string());
    }

    // Atomic write: write to temp file then rename.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_name = format!(".binder-export-{}-{}", std::process::id(), nanos);
    let tmp_path = parent.join(&tmp_name);

    let mut tmp_file = fs::File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temporary file: {}", e))?;
    tmp_file.write_all(content.as_bytes()).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to write file: {}", e)
    })?;
    tmp_file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to sync file: {}", e)
    })?;

    fs::rename(&tmp_path, &requested_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to save file: {}", e)
    })?;

    Ok(())
}

#[tauri::command]
fn export_markdown_file(path: String, content: String) -> Result<(), String> {
    let requested_path = PathBuf::from(&path);

    // Only allow .md/.markdown extension for export
    match requested_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") => {}
        _ => return Err("Export file must have .md or .markdown extension.".to_string()),
    }

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "Content is too large. Maximum supported size is {} MiB.",
            MAX_MARKDOWN_SIZE_MIB
        ));
    }

    // Resolve parent directory to ensure it exists
    let parent = requested_path
        .parent()
        .ok_or_else(|| "Cannot determine parent directory.".to_string())?;
    if !parent.exists() {
        return Err("Parent directory does not exist.".to_string());
    }

    // Atomic write: write to temp file then rename.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_name = format!(".binder-export-md-{}-{}", std::process::id(), nanos);
    let tmp_path = parent.join(&tmp_name);

    let mut tmp_file = fs::File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temporary file: {}", e))?;
    tmp_file.write_all(content.as_bytes()).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to write file: {}", e)
    })?;
    tmp_file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to sync file: {}", e)
    })?;

    fs::rename(&tmp_path, &requested_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to save file: {}", e)
    })?;

    Ok(())
}

#[tauri::command]
fn watch_file(
    path: String,
    state: tauri::State<'_, FileWatcher>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let requested_path = PathBuf::from(&path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;

    let mut guard = state.0.lock().unwrap();

    // Stop existing watcher if any.
    if let Some(old) = guard.take() {
        let _ = old.stop_tx.send(());
    }

    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (event_tx, event_rx) = mpsc::channel::<()>();

    let watched_path = canonical_path.clone();
    let watched_path_for_event = canonical_path.to_string_lossy().into_owned();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                use notify::EventKind;
                match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {
                        if event
                            .paths
                            .iter()
                            .any(|path| dunce::simplified(path) == watched_path.as_path())
                        {
                            let _ = event_tx.send(());
                        }
                    }
                    _ => {}
                }
            }
        })
        .map_err(|e| format!("Failed to create file watcher: {}", e))?;

    // Watch parent directory for better compatibility with atomic writes.
    let parent = canonical_path
        .parent()
        .ok_or_else(|| "Cannot determine parent directory.".to_string())?;
    watcher
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

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

    *guard = Some(WatcherState {
        _watcher: watcher,
        stop_tx,
    });

    Ok(())
}

#[tauri::command]
fn unwatch_file(state: tauri::State<'_, FileWatcher>) {
    let mut guard = state.0.lock().unwrap();
    if let Some(old) = guard.take() {
        let _ = old.stop_tx.send(());
    }
}

#[tauri::command]
fn list_workspace_markdown_files(
    root: String,
    max_files: Option<usize>,
) -> Result<WorkspaceListResult, String> {
    let root_path = PathBuf::from(root);
    let canonical_root = canonicalize_directory_path(&root_path)?;
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

fn canonicalize_markdown_path(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }

    let canonical_path =
        dunce::canonicalize(path).map_err(|e| format!("Failed to resolve file path: {}", e))?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|e| format!("Failed to inspect file metadata: {}", e))?;

    if !metadata.is_file() {
        return Err(format!("File not found: {}", path.display()));
    }

    if !is_markdown_path(&canonical_path) {
        return Err("Not a supported file type (.md, .markdown, or .fountain).".to_string());
    }

    Ok(canonical_path)
}

fn canonicalize_directory_path(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("Workspace not found: {}", path.display()));
    }

    let canonical_path = dunce::canonicalize(path)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|e| format!("Failed to inspect workspace metadata: {}", e))?;

    if !metadata.is_dir() {
        return Err("Workspace path must be a directory.".to_string());
    }

    Ok(canonical_path)
}

fn read_markdown_contents(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();

    reader
        .by_ref()
        .take(MAX_MARKDOWN_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    if buffer.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "File is too large. Maximum supported size is {} MiB.",
            MAX_MARKDOWN_SIZE_MIB
        ));
    }

    String::from_utf8(buffer).map_err(|_| "File must be valid UTF-8 text.".to_string())
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
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

fn read_file_revision(path: &Path) -> Result<FileRevision, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to inspect file metadata: {}", e))?;
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file for revision check: {}", e))?;

    if bytes.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "File is too large. Maximum supported size is {} MiB.",
            MAX_MARKDOWN_SIZE_MIB
        ));
    }

    Ok(FileRevision {
        mtime_ms: modified_time_ms(&metadata),
        size: bytes.len() as u64,
        content_hash: stable_hash_hex(&bytes),
    })
}

fn write_markdown_contents_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Cannot determine parent directory.".to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_name = format!(".binder-tmp-{}-{}", std::process::id(), nanos);
    let tmp_path = parent.join(&tmp_name);

    let mut tmp_file = fs::File::create(&tmp_path)
        .map_err(|e| format!("Failed to create temporary file: {}", e))?;
    tmp_file.write_all(content.as_bytes()).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to write file: {}", e)
    })?;
    tmp_file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to sync file: {}", e)
    })?;

    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to save file: {}", e)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            resolve_markdown_path,
            open_markdown_file,
            // Keep simple write API for non-editor callsites.
            write_markdown_file,
            write_markdown_file_if_unmodified,
            export_html_file,
            export_markdown_file,
            get_cli_file_path,
            watch_file,
            unwatch_file,
            list_workspace_markdown_files
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let cli_path = {
                let args: Vec<String> = std::env::args().collect();
                if args.len() > 1 {
                    let path = PathBuf::from(&args[1]);
                    if path.exists() && is_markdown_path(&path) {
                        dunce::canonicalize(&path)
                            .ok()
                            .and_then(|p| p.to_str().map(String::from))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            app.manage(CliFilePath(Mutex::new(cli_path)));
            app.manage(FileWatcher(Mutex::new(None)));

            Ok(())
        })
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        export_markdown_file, is_markdown_path, list_workspace_markdown_files, open_markdown_file,
        read_markdown_file, resolve_markdown_path, write_markdown_file,
        write_markdown_file_if_unmodified, MAX_MARKDOWN_BYTES,
    };
    use std::env;
    use std::fs::{self, File};
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

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
    fn reads_valid_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, "# Hello\n\nMarkdown").expect("write fixture");

        let result = read_markdown_file(path.to_string_lossy().into_owned());
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
            open_markdown_file(link.to_string_lossy().into_owned()).expect("open markdown");

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

        let result = read_markdown_file(path.to_string_lossy().into_owned());
        assert_eq!(
            result.expect("read fountain"),
            "INT. OFFICE - DAY\n\nSARAH\nHello world."
        );

        cleanup(&path);
    }

    #[test]
    fn rejects_missing_markdown_file() {
        let path = temp_path("md");
        let result = read_markdown_file(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("missing file should error")
            .contains("File not found"));
    }

    #[test]
    fn rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = read_markdown_file(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn open_markdown_file_rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = open_markdown_file(path.to_string_lossy().into_owned());
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

        let result = read_markdown_file(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("oversized file should error")
            .contains("File is too large"));

        cleanup(&path);
    }

    #[test]
    fn rejects_non_utf8_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, [0xFF_u8, 0xFE_u8, 0xFD_u8]).expect("write non-utf8 fixture");

        let result = read_markdown_file(path.to_string_lossy().into_owned());
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

        let result = read_markdown_file(link.to_string_lossy().into_owned());
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

        let result = read_markdown_file(link.to_string_lossy().into_owned());
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
            resolve_markdown_path(link.to_string_lossy().into_owned()).expect("resolve path");
        assert_eq!(
            PathBuf::from(resolved),
            fs::canonicalize(&target).expect("canonical target")
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn writes_to_existing_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");

        let result = write_markdown_file(
            path.to_string_lossy().into_owned(),
            "# Updated\n\nNew content".to_string(),
        );
        assert!(result.is_ok());

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# Updated\n\nNew content");

        cleanup(&path);
    }

    #[test]
    fn conditional_write_succeeds_with_matching_revision() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file(path_str.clone()).expect("open markdown");
        let result = write_markdown_file_if_unmodified(
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

        let opened = open_markdown_file(path_str.clone()).expect("open markdown");
        fs::write(&path, "# External change").expect("simulate external write");

        let result = write_markdown_file_if_unmodified(
            path_str,
            "# Local edit".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect("conditional write conflict");
        assert!(result.conflict);

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# External change");

        cleanup(&path);
    }

    #[test]
    fn conditional_write_force_overwrites_after_conflict() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file(path_str.clone()).expect("open markdown");
        fs::write(&path, "# External change").expect("simulate external write");

        let result = write_markdown_file_if_unmodified(
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

    #[test]
    fn writes_to_existing_fountain_file() {
        let path = temp_path("fountain");
        fs::write(&path, "INT. ROOM - DAY").expect("write fixture");

        let result = write_markdown_file(
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

        let result = write_markdown_file(path.to_string_lossy().into_owned(), "new".to_string());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn write_rejects_nonexistent_file() {
        let path = temp_path("md");
        let result = write_markdown_file(path.to_string_lossy().into_owned(), "new".to_string());
        assert!(result
            .expect_err("missing file should error")
            .contains("File not found"));
    }

    #[test]
    fn write_rejects_oversized_content() {
        let path = temp_path("md");
        fs::write(&path, "# Placeholder").expect("write fixture");

        let oversized = "x".repeat((MAX_MARKDOWN_BYTES + 1) as usize);
        let result = write_markdown_file(path.to_string_lossy().into_owned(), oversized);
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

        let result = write_markdown_file(link.to_string_lossy().into_owned(), "new".to_string());
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
        let result = write_markdown_file(path.to_string_lossy().into_owned(), unicode.to_string());
        assert!(result.is_ok());

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

        let result = list_workspace_markdown_files(root.to_string_lossy().into_owned(), Some(50))
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

        let result = list_workspace_markdown_files(root.to_string_lossy().into_owned(), Some(2))
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

        let result = list_workspace_markdown_files(root.to_string_lossy().into_owned(), Some(2))
            .expect("list workspace files");

        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].rel_path, "a.md");
        assert_eq!(result.files[1].rel_path, "m.md");
        assert!(result.limit_hit);

        cleanup_dir(&root);
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

        let result = list_workspace_markdown_files(root.to_string_lossy().into_owned(), Some(20))
            .expect("list workspace files");

        assert!(result.files.is_empty());

        cleanup(&outside);
        cleanup_dir(&root);
    }

    #[test]
    fn export_markdown_accepts_md_extension() {
        let path = temp_path("md");
        let result = export_markdown_file(
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
        let result = export_markdown_file(
            path.to_string_lossy().into_owned(),
            "# Annotations\n".to_string(),
        );
        assert!(result.is_ok());
        cleanup(&path);
    }

    #[test]
    fn export_markdown_rejects_html_extension() {
        let path = temp_path("html");
        let result =
            export_markdown_file(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("html extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
    }

    #[test]
    fn export_markdown_rejects_txt_extension() {
        let path = temp_path("txt");
        let result =
            export_markdown_file(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("txt extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
    }

    #[test]
    fn export_markdown_rejects_oversized_content() {
        let path = temp_path("md");
        let oversized = "x".repeat((MAX_MARKDOWN_BYTES + 1) as usize);
        let result = export_markdown_file(path.to_string_lossy().into_owned(), oversized);
        assert!(result
            .expect_err("oversized content should error")
            .contains("too large"));
    }

    #[test]
    fn export_markdown_rejects_nonexistent_parent() {
        let path = PathBuf::from("/nonexistent-dir-binder-test/annotations.md");
        let result =
            export_markdown_file(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("missing parent should error")
            .contains("Parent directory does not exist"));
    }

    fn temp_path(ext: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        env::temp_dir().join(format!(
            "binder-test-{}-{}.{}",
            std::process::id(),
            nanos,
            ext
        ))
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        env::temp_dir().join(format!("{}-{}-{}", prefix, std::process::id(), nanos))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
    }

    fn cleanup_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }
}
