//! Annotation storage is separate from settings (settings.rs); both acknowledge
//! an atomic file replacement, and the settings cache is seeded only here, after
//! migration has preserved the legacy bytes.
use crate::atomic_write::write_contents_atomic_private;
use crate::file_errors::{run_blocking_file_io, NativeFileError, NativeFileOperation};
use crate::settings::Settings;
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, fs, io::Read, path::Path, sync::Mutex};
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
    let settings_app = app.clone();
    run(app, move |root| {
        initialize_at(root)?;
        // Annotation data remains readable when only settings are unavailable.
        let settings_error = prepare_settings(&settings_app.state::<Settings>(), root).err();
        Ok(StorageStatus {
            settings_ready: settings_error.is_none(),
            settings_error,
        })
    })
    .await
}

fn prepare_settings(settings: &Settings, root: &Path) -> Result<(), String> {
    // Bootstrap runs under STORAGE_LOCK. Once loaded, the cache owns newer
    // changes, including a value whose write failed; do not reload over it.
    if settings.is_loaded() {
        return Ok(());
    }
    let path = root.join("settings.json");
    // Seed the cache from this checked read only: a damaged or unreadable file
    // must leave settings unavailable rather than load an empty cache that the
    // next write would persist over the original bytes.
    let values = match read_optional(&path)? {
        Some(bytes) => parse_object(&bytes)?,
        None => Map::new(),
    };
    settings.load(&path, values);
    Ok(())
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
    app: tauri::AppHandle,
    path: String,
    documents: Value,
) -> Result<(), NativeFileError> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| recovery_export_error(e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        export_recovery_at(&root, Path::new(&path), documents)
    })
    .await
    .map_err(|e| recovery_export_error(e.to_string()))?
}

fn recovery_export_error(detail: impl Into<String>) -> NativeFileError {
    NativeFileError::unknown(
        NativeFileOperation::SaveRecoveryData,
        "Couldn't save the recovery copy.",
        detail,
    )
}

fn export_recovery_at(root: &Path, path: &Path, documents: Value) -> Result<(), NativeFileError> {
    let invalid =
        |message| NativeFileError::invalid(NativeFileOperation::SaveRecoveryData, message);
    if path.extension().and_then(|v| v.to_str()) != Some("json") || !documents.is_object() {
        return Err(invalid("Choose a .json recovery file."));
    }
    let parent = crate::document_io::canonicalize_directory_path(
        path.parent()
            .ok_or_else(|| invalid("Choose a recovery destination folder."))?,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;
    match dunce::canonicalize(root) {
        Ok(root) if parent.starts_with(&root) => {
            return Err(invalid(
                "Choose a recovery destination outside Bindars' app data folder.",
            ));
        }
        // A missing app-data folder cannot contain an existing destination folder.
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            return Err(recovery_export_error(e.to_string()))
        }
        _ => {}
    }
    let path = parent.join(
        path.file_name()
            .ok_or_else(|| invalid("Choose a recovery filename."))?,
    );
    let data = json!({"kind":"bindars-annotation-recovery","version":1,"documents":documents});
    let content = serialize_json(&data).map_err(recovery_export_error)?;
    if content.len() > 64 * 1024 * 1024 {
        return Err(invalid("Recovery copy exceeds 64 MiB."));
    }
    write_json_text(&path, &content).map_err(recovery_export_error)?;
    if read_recovery_at(&path).map_err(recovery_export_error)? != data {
        return Err(recovery_export_error("Couldn't verify recovery copy"));
    }
    Ok(())
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
    Ok(Value::Object(data))
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

// serde_json::Value normally keeps only the last member with a given key.
// Check decoded keys while visiting every object, including objects in arrays,
// so no primary, recovery or migration input loses data before validation.
struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = Value;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("JSON with unique object members")
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
                Ok(value.into())
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
                Ok(value.into())
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
                Ok(value.into())
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
                Ok(value.into())
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
                Ok(value.into())
            }

            fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }

            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueValue(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Value::Array(values))
            }

            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("Duplicate JSON object member"));
                    }
                    let UniqueValue(value) = map.next_value()?;
                    values.insert(key, value);
                }
                Ok(Value::Object(values))
            }
        }
        deserializer.deserialize_any(Visitor).map(UniqueValue)
    }
}

fn parse_object(bytes: &[u8]) -> Result<Map<String, Value>, String> {
    let UniqueValue(value) =
        serde_json::from_slice(bytes).map_err(|_| "Stored JSON is damaged".to_string())?;
    match value {
        Value::Object(members) => Ok(members),
        _ => Err("Stored JSON is not an object".into()),
    }
}

fn validate_collection(value: &Map<String, Value>) -> Result<(), String> {
    if value.get("version") != Some(&json!(1))
        || !value.get("documents").is_some_and(Value::is_object)
    {
        return Err("Annotation storage has an unsupported format".into());
    }
    Ok(())
}

fn serialize_json(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| e.to_string())
}

fn write_json_text(path: &Path, content: &str) -> Result<(), String> {
    // Inspect the target even for private writes, which intentionally don't
    // inherit an existing target's permissions in the common atomic helper.
    read_optional(path)?;
    write_contents_atomic_private(path, content, ".bindars-annotations")
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
        return Ok(Value::Object(data));
    }
    if receipt.is_some() {
        return Err("Annotation storage is missing after migration; recovery is required".into());
    }

    // Preserve every legacy byte before the settings plugin is allowed to load.
    let original = match read_optional(&root.join(ARCHIVE))? {
        Some(bytes) => Some(bytes),
        None => read_optional(&root.join("settings.json"))?,
    };
    let settings = original.as_deref().map(parse_object).transpose()?;
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
    if let Some(settings) = settings {
        let version = match settings.get("config-version") {
            None => 0,
            Some(value) => value.as_u64().ok_or("Settings version is damaged")?,
        };
        for (key, record) in &settings {
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
    write(&root.join(DATA), &serialize_json(&data)?)?;
    let readback = read_optional(&root.join(DATA))?.ok_or("New annotations were not written")?;
    if Value::Object(parse_object(&readback)?) != data {
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

/// Paths whose stored record has highlights or bookmarks. A new draft must not
/// take one of these names: the notes belong to an earlier document there.
/// A storage failure cannot establish that a name is safe to reuse.
pub(crate) async fn annotated_paths(
    app: tauri::AppHandle,
) -> Result<HashSet<String>, NativeFileError> {
    run(app, annotated_paths_at).await
}

fn annotated_paths_at(root: &Path) -> Result<HashSet<String>, String> {
    let data = initialize_at(root)?;
    let documents = data["documents"].as_object().expect("validated collection");
    let empty = |record: &Value, key: &str| {
        record
            .get(key)
            .is_none_or(|items| items.as_array().is_some_and(Vec::is_empty))
    };
    Ok(documents
        .iter()
        .filter(|(_, record)| {
            !(record.is_object()
                && record
                    .get("version")
                    .is_none_or(|version| [json!(1), json!(2), json!(3)].contains(version))
                && empty(record, "highlights")
                && empty(record, "bookmarks"))
        })
        .map(|(path, _)| path.clone())
        .collect())
}

#[tauri::command]
pub(crate) async fn check_copy_destination(
    app: tauri::AppHandle,
    path: String,
) -> Result<String, NativeFileError> {
    // Destination failures belong to the file operation, not annotation storage.
    let path = run_blocking_file_io(move || {
        crate::document_io::resolve_markdown_write_name(Path::new(&path))
    })
    .await?
    .to_string_lossy()
    .into_owned();
    if annotated_paths(app).await?.contains(&path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "This name already has saved highlights, notes, or bookmarks. Choose a different name for the copy.",
        ));
    }
    Ok(path)
}

fn save_at(root: &Path, path: &str, annotations: Value) -> Result<(), String> {
    if path.is_empty() || !annotations.is_object() {
        return Err("Invalid annotation record".into());
    }
    let mut data = initialize_at(root)?;
    data["documents"][path] = annotations;
    write_json_text(&root.join(DATA), &serialize_json(&data)?)
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

    fn duplicate_documents() -> [&'static str; 6] {
        [
            r#""/a.md":{"note":"first"},"/a.md":{"note":"second"}"#,
            r#""/a.md":{"highlights":[{"note":"keep"}],"highlights":[]}"#,
            r#""/a.md":{"highlights":[{"note":"first","note":"second"}]}"#,
            r#""/a.md":{"note":"first"},"\u002fa.md":{"note":"second"}"#,
            r#""/a.md":{"highlights":[{"note":"first","\u006eote":"second"}]}"#,
            r#""/a.md":{"future":{"😀":1,"\ud83d\ude00":2}}"#,
        ]
    }

    fn assert_storage_error(failure: NativeFileError) {
        assert_eq!(
            failure.category,
            crate::file_errors::NativeFileErrorCategory::Unknown
        );
        assert_eq!(failure.operation, NativeFileOperation::AccessRecoveryData);
        assert_eq!(
            failure.message,
            "Couldn't access annotation storage. Existing data was preserved."
        );
        assert_eq!(failure.detail, "Stored JSON is damaged");
    }

    #[test]
    fn duplicate_primary_members_reject_load_and_save_without_changing_any_bytes() {
        for members in duplicate_documents() {
            let root = fixture();
            let bytes = format!(r#"{{"version":1,"documents":{{{members}}}}}"#);
            fs::write(root.join(DATA), &bytes).unwrap();
            assert_storage_error(initialize_at(&root).map_err(error).unwrap_err());
            assert_storage_error(
                save_at(&root, "/unrelated.md", json!({"note":"new"}))
                    .map_err(error)
                    .unwrap_err(),
            );
            assert_eq!(fs::read(root.join(DATA)).unwrap(), bytes.as_bytes());
            assert!(!root.join(RECEIPT).exists());
            assert!(!root.join(ARCHIVE).exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn duplicate_recovery_members_return_the_recoverable_error_and_preserve_the_copy() {
        for members in duplicate_documents() {
            let root = fixture();
            let path = root.join("recovery.json");
            let bytes = format!(
                r#"{{"kind":"bindars-annotation-recovery","version":1,"documents":{{{members}}}}}"#
            );
            fs::write(&path, &bytes).unwrap();
            let result = tauri::async_runtime::block_on(read_annotation_recovery(
                path.to_string_lossy().into_owned(),
            ));
            assert_storage_error(result.unwrap_err());
            assert_eq!(fs::read(&path).unwrap(), bytes.as_bytes());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn duplicate_migration_members_never_create_or_replace_storage() {
        for source in ["settings.json", ARCHIVE] {
            for bytes in [
                r#"{"annotations:/a.md":{"note":"first"},"annotations:/a.md":{"note":"second"}}"#,
                r#"{"annotations:/a.md":{"highlights":[{"note":"keep"}],"highlights":[]}}"#,
                r#"{"annotations:/a.md":{"highlights":[{"note":"first","\u006eote":"second"}]}}"#,
                r#"{"annotations:/a.md":{"note":"first"},"annotations:\u002fa.md":{"note":"second"}}"#,
                r#"{"config-version":2,"config-version":3,"annotations:/a.md":{"note":"keep"}}"#,
            ] {
                let root = fixture();
                fs::write(root.join(source), bytes).unwrap();
                assert_storage_error(initialize_at(&root).map_err(error).unwrap_err());
                assert_storage_error(
                    save_at(&root, "/unrelated.md", json!({}))
                        .map_err(error)
                        .unwrap_err(),
                );
                assert_eq!(fs::read(root.join(source)).unwrap(), bytes.as_bytes());
                assert!(!root.join(DATA).exists());
                assert!(!root.join(RECEIPT).exists());
                assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn duplicate_receipt_members_preserve_the_receipt_and_primary_collection() {
        let root = fixture();
        save_at(&root, "/a.md", json!({"note":"keep"})).unwrap();
        let primary = fs::read(root.join(DATA)).unwrap();
        let receipt = br#"{"version":99,"version":1}"#;
        fs::write(root.join(RECEIPT), receipt).unwrap();
        assert_storage_error(initialize_at(&root).map_err(error).unwrap_err());
        assert_storage_error(
            save_at(&root, "/unrelated.md", json!({}))
                .map_err(error)
                .unwrap_err(),
        );
        assert_eq!(fs::read(root.join(DATA)).unwrap(), primary);
        assert_eq!(fs::read(root.join(RECEIPT)).unwrap(), receipt);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checked_json_keeps_valid_values_and_distinct_object_scopes() {
        let bytes = br#"{"null":null,"bools":[true,false],"numbers":[-1,0,1.25,1e30,18446744073709551615,-9223372036854775808],"\u006eote":"escaped\ntext","objects":[{"note":"first"},{"note":"second"}],"empty":[{},[]]}"#;
        assert_eq!(
            Value::Object(parse_object(bytes).unwrap()),
            serde_json::from_slice::<Value>(bytes).unwrap()
        );
        for invalid in [
            b"{} {}".as_slice(),
            b"[]",
            b"{broken",
            br#"{"a":1,}"#,
            br#"{"version":99,"version":1}"#,
        ] {
            assert!(parse_object(invalid).is_err());
        }
    }

    #[test]
    fn repaired_primary_can_retry_without_losing_valid_unknown_data() {
        let root = fixture();
        fs::write(
            root.join(DATA),
            br#"{"version":99,"version":1,"documents":{}}"#,
        )
        .unwrap();
        assert!(initialize_at(&root).is_err());
        let valid = br#"{"version":1,"documents":{"/a.md":{"highlights":[{"note":"keep","future":{"note":"nested"}}],"bookmarks":[]}},"future":{"enabled":true}}"#;
        fs::write(root.join(DATA), valid).unwrap();
        let expected: Value = serde_json::from_slice(valid).unwrap();
        assert_eq!(initialize_at(&root).unwrap(), expected);
        save_at(&root, "/b.md", json!({"note":"new"})).unwrap();
        let saved = initialize_at(&root).unwrap();
        assert_eq!(saved["documents"]["/a.md"], expected["documents"]["/a.md"]);
        assert_eq!(saved["future"], expected["future"]);
        assert_eq!(saved["documents"]["/b.md"]["note"], "new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_bootstrap_loads_checked_bytes_and_keeps_newer_cache() {
        let root = fixture();
        let bytes = legacy(&root);
        initialize_at(&root).unwrap();
        let settings = Settings::default();
        prepare_settings(&settings, &root).unwrap();
        let path = root.join("settings.json");
        assert_eq!(settings.get("theme").unwrap(), Some(json!("dark")));
        assert_eq!(fs::read(&path).unwrap(), bytes);

        // A failed write still leaves a newer cache. Repeated bootstrap must
        // not discard that value or migrate its heading twice.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let history =
            json!({"version":1,"files":[{"path":"/a.md","lastHeadingId":"user-content-intro"}]});
        assert!(settings
            .set("recent-files".into(), history.clone())
            .is_err());
        prepare_settings(&settings, &root).unwrap();
        assert_eq!(settings.get("recent-files").unwrap(), Some(history.clone()));
        fs::remove_dir(&path).unwrap();
        settings.set("sidebar-open".into(), json!(true)).unwrap();
        let saved = parse_object(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["theme"], "dark");
        assert_eq!(saved["recent-files"], history);
        assert_eq!(saved["annotations:/a.md"]["unknown"], 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_settings_load_no_cache_for_later_writes() {
        for bytes in [b"".as_slice(), b"{broken", b"[]", b"null"] {
            let root = fixture();
            initialize_at(&root).unwrap();
            let path = root.join("settings.json");
            fs::write(&path, bytes).unwrap();
            let settings = Settings::default();
            assert!(prepare_settings(&settings, &root).is_err());
            assert!(!settings.is_loaded());
            assert!(settings.set("theme".into(), json!("dark")).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(
                initialize_at(&root).is_ok(),
                "canonical annotations remain usable"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_settings_can_retry_without_loading_an_empty_cache() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture();
        let bytes = legacy(&root);
        initialize_at(&root).unwrap();
        let path = root.join("settings.json");
        let settings = Settings::default();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let result = prepare_settings(&settings, &root);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        if result.is_ok() {
            // Root can bypass mode bits; the damaged-bytes test covers the refusal.
            assert_eq!(std::env::var("USER").unwrap_or_default(), "root");
        } else {
            assert!(!settings.is_loaded());
        }
        assert_eq!(fs::read(&path).unwrap(), bytes);

        prepare_settings(&settings, &root).unwrap();
        // Reads come from the checked cache even if disk access fails afterward.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let theme = settings.get("theme");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(theme.unwrap(), Some(json!("dark")));
        settings.set("sidebar-open".into(), json!(true)).unwrap();
        assert_eq!(
            parse_object(&fs::read(&path).unwrap()).unwrap()["theme"],
            "dark"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_settings_load_an_empty_cache_and_create_the_file_on_first_write() {
        let root = fixture();
        initialize_at(&root).unwrap();
        let settings = Settings::default();
        prepare_settings(&settings, &root).unwrap();
        let path = root.join("settings.json");
        assert!(settings.is_loaded());
        assert_eq!(settings.get("theme").unwrap(), None);
        assert!(!path.exists());
        settings.set("theme".into(), json!("dark")).unwrap();
        assert_eq!(
            Value::Object(parse_object(&fs::read(&path).unwrap()).unwrap()),
            json!({"theme": "dark"})
        );
        fs::remove_dir_all(root).unwrap();
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
        assert!(parse_object(&fs::read(root.join("settings.json")).unwrap()).is_err());
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
        write_json_text(&path, &serialize_json(&data).unwrap()).unwrap();
        assert_eq!(read_recovery_at(&path).unwrap(), data);
        fs::write(&path, b"{broken").unwrap();
        assert!(read_recovery_at(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recovery_export_refuses_app_data_and_descendants_without_changing_bytes() {
        let root = fixture();
        let storage = root.join("app");
        fs::create_dir_all(storage.join("nested")).unwrap();
        let original =
            br#"{"version":1,"documents":{"/other.md":{"highlights":[{"note":"keep"}]}}}"#;
        for name in [DATA, "settings.json", RECEIPT, ARCHIVE, "nested/copy.json"] {
            let path = storage.join(name);
            fs::write(&path, original).unwrap();
            let failure =
                export_recovery_at(&storage, &path, json!({"/pending.md": {}})).unwrap_err();
            assert_eq!(
                failure.category,
                crate::file_errors::NativeFileErrorCategory::InvalidInput
            );
            assert_eq!(failure.operation, NativeFileOperation::SaveRecoveryData);
            assert_eq!(
                failure.message,
                "Choose a recovery destination outside Bindars' app data folder."
            );
            assert_eq!(fs::read(path).unwrap(), original);
        }
        // A sibling whose name begins with the storage name is a valid destination.
        let outside = root.join("app-copies");
        fs::create_dir(&outside).unwrap();
        let destination = outside.join("copy.json");
        export_recovery_at(
            &storage,
            &destination,
            json!({"/pending.md": {"note":"pending"}}),
        )
        .unwrap();
        assert_eq!(
            read_recovery_at(&destination).unwrap()["documents"]["/pending.md"]["note"],
            "pending"
        );
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&storage, &alias).unwrap();
            assert!(export_recovery_at(&storage, &alias.join(DATA), json!({})).is_err());
            assert_eq!(fs::read(storage.join(DATA)).unwrap(), original);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn future_record_versions_reserve_names_even_when_known_lists_are_empty() {
        let root = fixture();
        fs::write(
            root.join(DATA),
            br#"{"version":1,"documents":{
            "/future.md":{"version":4,"highlights":[],"bookmarks":[],"futureNotes":["keep"]},
            "/empty.md":{"version":3,"highlights":[],"bookmarks":[]}
        }}"#,
        )
        .unwrap();
        let paths = annotated_paths_at(&root).unwrap();
        assert!(paths.contains("/future.md"));
        assert!(!paths.contains("/empty.md"));
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
    fn annotated_paths_ignore_empty_records_and_preserve_unreadable_items() {
        let root = fixture();
        assert!(annotated_paths_at(&root).unwrap().is_empty());
        fs::write(
            root.join(DATA),
            r#"{"version":1,"documents":{
                "/empty.md":{"highlights":[],"bookmarks":[]},
                "/no-fields.md":{},
                "/note.md":{"highlights":[{"id":"h"}],"bookmarks":[]},
                "/bookmark.md":{"highlights":[],"bookmarks":[{"id":"b"}]},
                "/damaged.md":42,
                "/odd.md":{"highlights":"not a list"}}}"#,
        )
        .unwrap();
        let paths = annotated_paths_at(&root).unwrap();
        let expected = ["/note.md", "/bookmark.md", "/damaged.md", "/odd.md"];
        assert_eq!(paths, expected.map(String::from).into_iter().collect());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn annotated_paths_initialize_legacy_records_before_reusing_names() {
        let root = fixture();
        let original = legacy(&root);
        let paths = annotated_paths_at(&root).unwrap();
        assert_eq!(
            paths,
            ["/a.md", "/bad.md"].map(String::from).into_iter().collect()
        );
        assert_eq!(fs::read(root.join(ARCHIVE)).unwrap(), original);
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn annotated_paths_refuse_damaged_or_missing_migrated_storage() {
        let root = fixture();
        assert!(annotated_paths_at(&root).unwrap().is_empty());
        for contents in [
            "{ truncated",
            "[]",
            r#"{"version":99,"documents":{}}"#,
            r#"{"version":1,"documents":[]}"#,
        ] {
            fs::write(root.join(DATA), contents).unwrap();
            assert!(annotated_paths_at(&root).is_err(), "accepted {contents}");
            assert_eq!(fs::read_to_string(root.join(DATA)).unwrap(), contents);
        }
        fs::remove_file(root.join(DATA)).unwrap();
        assert!(annotated_paths_at(&root).is_err());
        assert!(!root.join(DATA).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn annotated_paths_report_read_failure_and_recover_without_changing_notes() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture();
        save_at(
            &root,
            "/orphan.md",
            json!({"highlights":[{"note":"keep me"}],"bookmarks":[]}),
        )
        .unwrap();
        let original = fs::read(root.join(DATA)).unwrap();
        fs::set_permissions(root.join(DATA), fs::Permissions::from_mode(0o000)).unwrap();
        let result = annotated_paths_at(&root);
        // Restore permissions before asserting, including on privileged CI hosts.
        fs::set_permissions(root.join(DATA), fs::Permissions::from_mode(0o600)).unwrap();
        if result.is_ok() {
            assert_eq!(std::env::var("USER").unwrap_or_default(), "root");
        }
        assert_eq!(
            annotated_paths_at(&root).unwrap(),
            HashSet::from(["/orphan.md".to_string()])
        );
        assert_eq!(fs::read(root.join(DATA)).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
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
