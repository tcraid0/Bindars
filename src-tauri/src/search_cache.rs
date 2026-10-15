//! Disposable, bounded derived data. Cache errors never affect preferences or notes.
use serde_json::Value;
use std::{fs, io::Read, path::Path};
use tauri::Manager;
const MAX_BYTES: u64 = 8 * 1024 * 1024;

#[tauri::command]
pub(crate) async fn load_search_cache(app: tauri::AppHandle) -> Option<Value> {
    let path = app
        .path()
        .app_cache_dir()
        .ok()?
        .join("document-search-v1.json");
    tauri::async_runtime::spawn_blocking(move || load_at(&path))
        .await
        .ok()
        .flatten()
}

fn load_at(path: &Path) -> Option<Value> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub(crate) async fn save_search_cache(app: tauri::AppHandle, cache: Value) -> Result<(), String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || save_at(&root, &cache))
        .await
        .map_err(|e| e.to_string())?
}

fn save_at(root: &Path, cache: &Value) -> Result<(), String> {
    let content = serde_json::to_string(cache).map_err(|e| e.to_string())?;
    if content.len() as u64 > MAX_BYTES {
        return Ok(());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    crate::atomic_write::write_contents_atomic_private(
        &root.join("document-search-v1.json"),
        &content,
        ".bindars-search",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::unique_temp_dir;
    use serde_json::json;

    #[test]
    fn missing_corrupt_and_oversized_caches_are_safe_misses() {
        let root = unique_temp_dir("search-cache");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("document-search-v1.json");
        assert!(load_at(&path).is_none());
        fs::write(&path, "invalid JSON").unwrap();
        assert!(load_at(&path).is_none());
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(load_at(&path).is_none());
        let cache = json!({"version":1,"docs":[]});
        save_at(&root, &cache).unwrap();
        assert_eq!(load_at(&path), Some(cache));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cache_write_failure_leaves_preferences_and_annotations_untouched() {
        let root = unique_temp_dir("search-cache-failure");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("settings.json"), "preferences").unwrap();
        fs::write(root.join("annotations.json"), "annotations").unwrap();
        let blocked = root.join("cache");
        fs::write(&blocked, "occupied").unwrap();
        assert!(save_at(&blocked, &json!({"version":1})).is_err());
        assert_eq!(
            fs::read_to_string(root.join("settings.json")).unwrap(),
            "preferences"
        );
        assert_eq!(
            fs::read_to_string(root.join("annotations.json")).unwrap(),
            "annotations"
        );
        assert_eq!(fs::read_to_string(blocked).unwrap(), "occupied");
        fs::remove_dir_all(root).unwrap();
    }
}
