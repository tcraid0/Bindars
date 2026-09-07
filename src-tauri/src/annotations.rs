//! Annotation storage is separate from the settings plugin: a successful command
//! acknowledges an atomic file replacement, not an update to an autosave cache.
use crate::atomic_write::write_contents_atomic_private;
use crate::file_errors::{NativeFileError, NativeFileOperation};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{fs, io::Read, path::Path, sync::Mutex};
use tauri::Manager;

static STORAGE_LOCK: Mutex<()> = Mutex::new(());
const DATA: &str = "annotations.json";
const RECEIPT: &str = "annotations-migration.json";
const ARCHIVE: &str = "annotations-legacy-settings.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageStatus {
    settings_ready: bool,
    settings_error: Option<String>,
}

fn error(detail: impl Into<String>) -> NativeFileError {
    NativeFileError::unknown(
        NativeFileOperation::AccessRecoveryData,
        "Couldn't access annotation storage. Existing data was preserved.",
        detail,
    )
}

async fn run<T: Send + 'static>(
    app: tauri::AppHandle,
    task: impl FnOnce(&Path) -> Result<T, String> + Send + 'static,
) -> Result<T, NativeFileError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| error(e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "Annotation storage lock failed".to_string())?;
        ensure_directory(&root)?;
        task(&root)
    })
    .await
    .map_err(|e| error(e.to_string()))?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn initialize_annotation_storage(
    app: tauri::AppHandle,
) -> Result<StorageStatus, NativeFileError> {
    run(app, |root| {
        initialize_at(root)?;
        // Never open the plugin's default cache for damaged settings. Annotation
        // data remains readable independently once it has been migrated.
        let settings_error = read_settings(root).err();
        Ok(StorageStatus {
            settings_ready: settings_error.is_none(),
            settings_error,
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn load_annotations(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<Value>, NativeFileError> {
    run(app, move |root| {
        let data = initialize_at(root)?;
        Ok(data["documents"].get(&path).cloned())
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_annotations(
    app: tauri::AppHandle,
    path: String,
    annotations: Value,
) -> Result<(), NativeFileError> {
    run(app, move |root| save_at(root, &path, annotations)).await
}

#[tauri::command]
pub(crate) async fn export_annotation_recovery(
    path: String,
    documents: Value,
) -> Result<(), NativeFileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = Path::new(&path);
        if path.extension().and_then(|v| v.to_str()) != Some("json") || !documents.is_object() {
            return Err("Choose a .json recovery file".to_string());
        }
        let parent = path.parent().ok_or("Missing recovery destination")?;
        crate::document_io::canonicalize_directory_path(
            parent,
            NativeFileOperation::ResolveWriteParent,
            NativeFileOperation::InspectWriteParent,
        )
        .map_err(|e| e.message)?;
        let data = json!({"kind":"bindars-annotation-recovery","version":1,"documents":documents});
        if serde_json::to_vec_pretty(&data)
            .map_err(|e| e.to_string())?
            .len()
            > 64 * 1024 * 1024
        {
            return Err("Recovery copy exceeds 64 MiB".into());
        }
        write_json(path, &data)?;
        if read_recovery_at(path)? != data {
            return Err("Couldn't verify recovery copy".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| error(e.to_string()))?
    .map_err(error)
}

#[tauri::command]
pub(crate) async fn read_annotation_recovery(path: String) -> Result<Value, NativeFileError> {
    tauri::async_runtime::spawn_blocking(move || read_recovery_at(Path::new(&path)))
        .await
        .map_err(|e| error(e.to_string()))?
        .map_err(error)
}

fn read_recovery_at(path: &Path) -> Result<Value, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Recovery copy must be a regular file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Recovery copy exceeds 64 MiB".into());
    }
    let data = parse_object(&bytes)?;
    validate_collection(&data)?;
    if data.get("kind") != Some(&json!("bindars-annotation-recovery")) {
        return Err("This is not an annotation recovery copy".into());
    }
    Ok(data)
}

fn ensure_directory(root: &Path) -> Result<(), String> {
    // Validate existing ancestors before create_dir_all can follow a symlink.
    for ancestor in root.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => return Err("Storage directory is not a regular directory".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Couldn't inspect storage directory: {e}")),
        }
    }
    fs::create_dir_all(root).map_err(|e| format!("Couldn't create storage directory: {e}"))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => fs::read(path)
            .map(Some)
            .map_err(|e| format!("Couldn't read {}: {e}", path.display())),
        Ok(_) => Err(format!("{} is not a regular file", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't inspect {}: {e}", path.display())),
    }
}

fn parse_object(bytes: &[u8]) -> Result<Value, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "Stored JSON is damaged".to_string())?;
    if !value.is_object() {
        return Err("Stored JSON is not an object".into());
    }
    Ok(value)
}

fn read_settings(root: &Path) -> Result<Option<Vec<u8>>, String> {
    let bytes = read_optional(&root.join("settings.json"))?;
    if let Some(bytes) = &bytes {
        parse_object(bytes)?;
    }
    Ok(bytes)
}

fn validate_collection(value: &Value) -> Result<(), String> {
    if value.get("version") != Some(&json!(1))
        || !value.get("documents").is_some_and(Value::is_object)
    {
        return Err("Annotation storage has an unsupported format".into());
    }
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    // Inspect the target even for private writes, which intentionally don't
    // inherit an existing target's permissions in the common atomic helper.
    read_optional(path)?;
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_contents_atomic_private(path, &content, ".bindars-annotations")
}

fn initialize_at(root: &Path) -> Result<Value, String> {
    initialize_with(root, |path, content| {
        write_contents_atomic_private(path, content, ".bindars-annotations")
    })
}

fn initialize_with(
    root: &Path,
    mut write: impl FnMut(&Path, &str) -> Result<(), String>,
) -> Result<Value, String> {
    let receipt = read_optional(&root.join(RECEIPT))?;
    if let Some(bytes) = &receipt {
        let value = parse_object(bytes)?;
        if value.get("version") != Some(&json!(1)) {
            return Err("Unsupported annotation migration receipt".into());
        }
    }
    if let Some(bytes) = read_optional(&root.join(DATA))? {
        let data = parse_object(&bytes)?;
        validate_collection(&data)?;
        if receipt.is_none() {
            // Import completed, but was interrupted before recording completion.
            // The new file is authoritative; never reapply the legacy snapshot.
            write(&root.join(RECEIPT), "{\"version\":1}")?;
        }
        return Ok(data);
    }
    if receipt.is_some() {
        return Err("Annotation storage is missing after migration; recovery is required".into());
    }

    // Preserve every legacy byte before the settings plugin is allowed to load.
    let original = match read_optional(&root.join(ARCHIVE))? {
        Some(bytes) => {
            parse_object(&bytes)?;
            Some(bytes)
        }
        None => read_settings(root)?,
    };
    if let Some(bytes) = &original {
        if read_optional(&root.join(ARCHIVE))?.is_none() {
            let text =
                std::str::from_utf8(bytes).map_err(|_| "Settings are not UTF-8".to_string())?;
            write(&root.join(ARCHIVE), text)?;
        }
        if read_optional(&root.join(ARCHIVE))?.as_ref() != Some(bytes) {
            return Err("Couldn't verify the original settings archive".into());
        }
    }

    let mut documents = Map::new();
    if let Some(bytes) = &original {
        let settings = parse_object(bytes)?;
        let version = match settings.get("config-version") {
            None => 0,
            Some(value) => value.as_u64().ok_or("Settings version is damaged")?,
        };
        for (key, record) in settings.as_object().expect("validated object") {
            if let Some(path) = key.strip_prefix("annotations:") {
                let mut record = record.clone();
                if version < 3 {
                    migrate_heading_ids(&mut record);
                }
                documents.insert(path.to_string(), record);
            }
        }
    }
    let data = json!({"version":1,"documents":documents});
    write(
        &root.join(DATA),
        &serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?,
    )?;
    let readback = read_optional(&root.join(DATA))?.ok_or("New annotations were not written")?;
    if parse_object(&readback)? != data {
        return Err("Couldn't verify migrated annotation data".into());
    }
    write(&root.join(RECEIPT), "{\"version\":1}")?;
    Ok(data)
}

fn migrate_heading_ids(record: &mut Value) {
    for (array, field) in [
        ("bookmarks", "headingId"),
        ("highlights", "nearestHeadingId"),
    ] {
        if let Some(items) = record.get_mut(array).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(id) = item.get(field).and_then(Value::as_str) {
                    if let Some(stripped) = id.strip_prefix("user-content-") {
                        let stripped = stripped.to_string();
                        item[field] = json!(stripped);
                    }
                }
            }
        }
    }
}

fn save_at(root: &Path, path: &str, annotations: Value) -> Result<(), String> {
    if path.is_empty() || !annotations.is_object() {
        return Err("Invalid annotation record".into());
    }
    let mut data = initialize_at(root)?;
    data["documents"][path] = annotations;
    write_json(&root.join(DATA), &data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::unique_temp_dir;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        let root = unique_temp_dir("annotations");
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn legacy(root: &Path) -> Vec<u8> {
        let bytes = br#"{ "config-version":2, "theme":"dark", "annotations:/a.md":{"highlights":[{"id":"h","note":"valuable","nearestHeadingId":"user-content-intro","future":true}],"bookmarks":[{"headingId":"user-content-intro"}],"unknown":5}, "annotations:/bad.md":42 }"#.to_vec();
        fs::write(root.join("settings.json"), &bytes).unwrap();
        bytes
    }
    #[test]
    fn imports_all_records_preserving_original_bytes_and_unknown_fields() {
        let root = fixture();
        let bytes = legacy(&root);
        let data = initialize_at(&root).unwrap();
        assert_eq!(
            data["documents"]["/a.md"]["highlights"][0]["nearestHeadingId"],
            "intro"
        );
        assert_eq!(data["documents"]["/a.md"]["highlights"][0]["future"], true);
        assert_eq!(data["documents"]["/bad.md"], 42);
        assert_eq!(fs::read(root.join(ARCHIVE)).unwrap(), bytes);
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn damaged_settings_never_become_empty_annotations() {
        let root = fixture();
        fs::write(root.join("settings.json"), b"{broken").unwrap();
        assert!(initialize_at(&root).is_err());
        assert!(!root.join(DATA).exists());
        assert!(!root.join(RECEIPT).exists());
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), b"{broken");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_import_is_retryable_at_every_write_boundary() {
        for fail_at in 1..=3 {
            let root = fixture();
            let bytes = legacy(&root);
            let mut writes = 0;
            let result = initialize_with(&root, |path, text| {
                writes += 1;
                if writes == fail_at {
                    return Err("disk full".into());
                }
                write_contents_atomic_private(path, text, ".test")
            });
            assert!(result.is_err());
            assert_eq!(fs::read(root.join("settings.json")).unwrap(), bytes);
            let data = initialize_at(&root).unwrap();
            assert_eq!(
                data["documents"]["/a.md"]["highlights"][0]["note"],
                "valuable"
            );
            assert_eq!(fs::read(root.join(ARCHIVE)).unwrap(), bytes);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn interrupted_receipt_never_reimports_over_newer_data() {
        let root = fixture();
        legacy(&root);
        initialize_at(&root).unwrap();
        save_at(&root, "/a.md", json!({"highlights":[],"bookmarks":[]})).unwrap();
        fs::remove_file(root.join(RECEIPT)).unwrap();
        assert_eq!(
            initialize_at(&root).unwrap()["documents"]["/a.md"]["highlights"],
            json!([])
        );
        fs::remove_file(root.join(DATA)).unwrap();
        assert!(initialize_at(&root).is_err());
        assert!(!root.join(DATA).exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn saves_survive_reopen_and_preserve_other_documents() {
        let root = fixture();
        initialize_at(&root).unwrap();
        save_at(&root, "/a.md", json!({"note":"A"})).unwrap();
        save_at(&root, "/b.md", json!({"note":"B"})).unwrap();
        assert_eq!(
            initialize_at(&root).unwrap()["documents"],
            json!({"/a.md":{"note":"A"},"/b.md":{"note":"B"}})
        );
        fs::write(root.join("settings.json"), b"broken").unwrap();
        assert!(read_settings(&root).is_err());
        assert_eq!(
            initialize_at(&root).unwrap()["documents"]["/a.md"]["note"],
            "A"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_or_damaged_targets_are_not_acknowledged_or_replaced() {
        let root = fixture();
        initialize_at(&root).unwrap();
        fs::write(root.join(DATA), b"broken").unwrap();
        assert!(save_at(&root, "/a.md", json!({})).is_err());
        assert_eq!(fs::read(root.join(DATA)).unwrap(), b"broken");
        fs::remove_file(root.join(DATA)).unwrap();
        fs::create_dir(root.join(DATA)).unwrap();
        assert!(save_at(&root, "/a.md", json!({})).is_err());
        assert!(root.join(DATA).is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn verifies_new_file_before_recording_migration_success() {
        let root = fixture();
        legacy(&root);
        assert!(initialize_with(&root, |path, text| {
            write_contents_atomic_private(
                path,
                if path.ends_with(DATA) { "{}" } else { text },
                ".test",
            )
        })
        .is_err());
        assert!(!root.join(RECEIPT).exists());
        assert!(root.join(ARCHIVE).exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn acknowledged_annotations_are_readable_in_a_fresh_process() {
        let root = fixture();
        initialize_at(&root).unwrap();
        save_at(
            &root,
            "/a.md",
            json!({"highlights":[{"note":"fresh process"}],"bookmarks":[]}),
        )
        .unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "annotations::tests::fresh_process_child",
                "--ignored",
            ])
            .env("BINDARS_ANNOTATION_TEST_ROOT", &root)
            .status()
            .unwrap();
        assert!(status.success());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "launched in a separate process by acknowledged_annotations_are_readable_in_a_fresh_process"]
    fn fresh_process_child() {
        let root = PathBuf::from(
            std::env::var_os("BINDARS_ANNOTATION_TEST_ROOT").expect("test fixture root"),
        );
        assert_eq!(
            initialize_at(&root).unwrap()["documents"]["/a.md"]["highlights"][0]["note"],
            "fresh process"
        );
    }
    #[test]
    fn recovery_copy_preserves_all_paths_and_unknown_record_data() {
        let root = fixture();
        let path = root.join("copy.json");
        let data = json!({"kind":"bindars-annotation-recovery","version":1,"documents":{
            "/a.md":{"highlights":[{"note":"recover","future":7}],"bookmarks":[]},
            "/b.md":{"highlights":[],"bookmarks":[{"headingId":"lost"}]}
        }});
        write_json(&path, &data).unwrap();
        assert_eq!(read_recovery_at(&path).unwrap(), data);
        fs::write(&path, b"{broken").unwrap();
        assert!(read_recovery_at(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_storage_files_and_directories() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let outside = fixture();
        fs::write(outside.join("data"), b"untouched").unwrap();
        symlink(outside.join("data"), root.join(DATA)).unwrap();
        assert!(initialize_at(&root).is_err());
        assert_eq!(fs::read(outside.join("data")).unwrap(), b"untouched");
        symlink(&outside, root.join("linked")).unwrap();
        assert!(ensure_directory(&root.join("linked").join("nested")).is_err());
        assert!(!outside.join("nested").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn unsupported_versions_are_preserved_without_creating_defaults() {
        let root = fixture();
        fs::write(
            root.join(DATA),
            br#"{"version":99,"documents":{"/a.md":{"note":"future"}}}"#,
        )
        .unwrap();
        let original = fs::read(root.join(DATA)).unwrap();
        assert!(initialize_at(&root).is_err());
        assert!(save_at(&root, "/a.md", json!({})).is_err());
        assert_eq!(fs::read(root.join(DATA)).unwrap(), original);
        assert!(!root.join(RECEIPT).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_real_write_failure_preserves_the_acknowledged_record_and_can_retry() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture();
        initialize_at(&root).unwrap();
        save_at(&root, "/a.md", json!({"note":"old"})).unwrap();
        let before = fs::read(root.join(DATA)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
        let result = save_at(&root, "/a.md", json!({"note":"new"}));
        // Restore permissions before asserting, including on privileged CI hosts.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        if result.is_ok() {
            // Root can bypass mode bits; the packaged nonprivileged test covers it.
            assert_eq!(std::env::var("USER").unwrap_or_default(), "root");
        } else {
            assert_eq!(fs::read(root.join(DATA)).unwrap(), before);
        }
        save_at(&root, "/a.md", json!({"note":"new"})).unwrap();
        assert_eq!(
            initialize_at(&root).unwrap()["documents"]["/a.md"]["note"],
            "new"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
