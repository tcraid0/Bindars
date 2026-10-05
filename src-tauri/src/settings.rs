//! Preferences live in `settings.json` in the app-data folder and are owned
//! here: one in-memory map, seeded by the checked read in the annotation
//! storage bootstrap, and one atomic owner-only write per change. There is no
//! autosave and no exit-time write. When `set` returns success the change is
//! on disk; when it fails the previous file is intact and the cache keeps the
//! value for the next successful write.
use crate::atomic_write::write_contents_atomic_private;
use crate::file_errors::{NativeFileError, NativeFileOperation};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::Manager;

const UNAVAILABLE: &str = "Settings storage is unavailable. Existing data was preserved.";

#[derive(Debug, Default)]
pub(crate) struct Settings(Mutex<Option<LoadedSettings>>);

#[derive(Debug)]
struct LoadedSettings {
    path: PathBuf,
    values: Map<String, Value>,
}

impl Settings {
    /// Adopts the checked contents of `path`, unless settings are already
    /// loaded: the live cache may hold newer values, including one whose
    /// write failed, and a reread of the disk must not replace them.
    pub(crate) fn load(&self, path: &Path, values: Map<String, Value>) {
        let mut loaded = self.lock();
        if loaded.is_none() {
            *loaded = Some(LoadedSettings {
                path: path.to_path_buf(),
                values,
            });
        }
    }

    pub(crate) fn is_loaded(&self) -> bool {
        self.lock().is_some()
    }

    pub(crate) fn get(&self, key: &str) -> Result<Option<Value>, String> {
        let loaded = self.lock();
        let loaded = loaded.as_ref().ok_or(UNAVAILABLE)?;
        Ok(loaded.values.get(key).cloned())
    }

    /// Stores `value` and writes the whole map to disk atomically. The lock
    /// is held across the write, so concurrent changes reach the file in
    /// order, each as a complete snapshot.
    pub(crate) fn set(&self, key: String, value: Value) -> Result<(), String> {
        let mut loaded = self.lock();
        let loaded = loaded.as_mut().ok_or(UNAVAILABLE)?;
        loaded.values.insert(key, value);
        let content = serde_json::to_string_pretty(&loaded.values).map_err(|e| e.to_string())?;
        write_contents_atomic_private(&loaded.path, &content, ".bindars-settings")
    }

    fn lock(&self) -> MutexGuard<'_, Option<LoadedSettings>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

async fn run<T: Send + 'static>(
    app: tauri::AppHandle,
    task: impl FnOnce(&Settings) -> Result<T, String> + Send + 'static,
) -> Result<T, NativeFileError> {
    let error = |detail: String| {
        NativeFileError::unknown(
            NativeFileOperation::AccessSettings,
            "Couldn't access settings. Existing settings were preserved.",
            detail,
        )
    };
    tauri::async_runtime::spawn_blocking(move || task(&app.state::<Settings>()))
        .await
        .map_err(|e| error(e.to_string()))?
        .map_err(error)
}

#[tauri::command]
pub(crate) async fn get_setting(
    app: tauri::AppHandle,
    key: String,
) -> Result<Option<Value>, NativeFileError> {
    run(app, move |settings| settings.get(&key)).await
}

#[tauri::command]
pub(crate) async fn set_setting(
    app: tauri::AppHandle,
    key: String,
    value: Value,
) -> Result<(), NativeFileError> {
    run(app, move |settings| settings.set(key, value)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{temp_leftovers, unique_temp_dir};
    use serde_json::json;
    use std::fs;

    fn fixture() -> (PathBuf, PathBuf) {
        let root = unique_temp_dir("settings");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        (root, path)
    }

    fn on_disk(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn loaded(path: &Path, values: Value) -> Settings {
        let settings = Settings::default();
        settings.load(path, values.as_object().cloned().unwrap());
        settings
    }

    #[test]
    fn a_completed_set_is_already_on_disk_with_every_existing_key_preserved() {
        let (root, path) = fixture();
        let existing = json!({
            "config-version": 3,
            "recent-files": {"version": 1, "files": [{"path": "/a.md", "name": "a.md", "openedAt": 1, "lastHeadingId": "intro"}]},
            "annotations:/legacy.md": {"highlights": [], "bookmarks": [], "unknown": 5},
            "session": {"filePath": "/a.md", "headingId": null}
        });
        fs::write(&path, serde_json::to_vec_pretty(&existing).unwrap()).unwrap();
        let settings = loaded(&path, existing.clone());

        settings.set("theme".into(), json!("dark")).unwrap();

        let mut expected = existing.clone();
        expected["theme"] = json!("dark");
        assert_eq!(on_disk(&path), expected);
        assert_eq!(settings.get("theme").unwrap(), Some(json!("dark")));
        assert_eq!(settings.get("missing").unwrap(), None);
        assert!(temp_leftovers(&root).is_empty());

        // Nothing is deferred: dropping the owner writes nothing more.
        let bytes = fs::read(&path).unwrap();
        drop(settings);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_settings_file_is_owner_only_and_the_bootstrap_cache_wins_over_a_reread() {
        use std::os::unix::fs::PermissionsExt;
        let (root, path) = fixture();
        let settings = loaded(&path, json!({"theme": "dark"}));
        settings
            .set("sidebar-visible".into(), json!(false))
            .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        settings.load(&path, Map::new());
        assert_eq!(settings.get("theme").unwrap(), Some(json!("dark")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn before_bootstrap_nothing_is_read_or_written() {
        let (root, path) = fixture();
        let settings = Settings::default();
        assert!(!settings.is_loaded());
        assert_eq!(settings.get("theme").unwrap_err(), UNAVAILABLE);
        assert_eq!(
            settings.set("theme".into(), json!("dark")).unwrap_err(),
            UNAVAILABLE
        );
        assert!(!path.exists());
        assert!(temp_leftovers(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_staging_write_keeps_the_prior_file_and_the_retry_persists_the_newest_values() {
        use std::os::unix::fs::PermissionsExt;
        let (root, path) = fixture();
        let settings = loaded(&path, json!({}));
        settings.set("theme".into(), json!("dark")).unwrap();
        let prior = fs::read(&path).unwrap();

        // The temporary file cannot be created in a folder without write permission.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
        let result = settings.set("recent-files".into(), json!({"version": 1, "files": []}));
        // Restore permissions before asserting, including on privileged CI hosts.
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        if result.is_ok() {
            // Root can bypass mode bits; the replacement test below covers the outcome.
            assert_eq!(std::env::var("USER").unwrap_or_default(), "root");
            fs::remove_dir_all(root).unwrap();
            return;
        }
        assert_eq!(fs::read(&path).unwrap(), prior);
        assert!(temp_leftovers(&root).is_empty());
        assert_eq!(
            settings.get("recent-files").unwrap(),
            Some(json!({"version": 1, "files": []})),
            "the cache keeps the value whose write failed"
        );

        settings
            .set("session".into(), json!({"filePath": "/a.md"}))
            .unwrap();
        assert_eq!(
            on_disk(&path),
            json!({"theme": "dark", "recent-files": {"version": 1, "files": []}, "session": {"filePath": "/a.md"}})
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_failed_replacement_keeps_the_prior_file_byte_for_byte() {
        use std::process::Command;
        let (root, path) = fixture();
        let settings = loaded(&path, json!({}));
        settings.set("theme".into(), json!("dark")).unwrap();
        let prior = fs::read(&path).unwrap();

        // An immutable destination lets the staged file be written and synced
        // but refuses the rename over it.
        let flag = |flag: &str| {
            assert!(Command::new("chflags")
                .arg(flag)
                .arg(&path)
                .status()
                .unwrap()
                .success());
        };
        flag("uchg");
        let result = settings.set("theme".into(), json!("light"));
        flag("nouchg");

        assert!(result.is_err(), "rename over an immutable file must fail");
        assert_eq!(fs::read(&path).unwrap(), prior);
        assert!(temp_leftovers(&root).is_empty());
        assert_eq!(settings.get("theme").unwrap(), Some(json!("light")));

        settings.set("sidebar-visible".into(), json!(true)).unwrap();
        assert_eq!(
            on_disk(&path),
            json!({"theme": "light", "sidebar-visible": true})
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_sets_serialize_into_complete_snapshots() {
        let (root, path) = fixture();
        let settings = std::sync::Arc::new(loaded(&path, json!({"config-version": 3})));
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let settings = std::sync::Arc::clone(&settings);
                std::thread::spawn(move || {
                    for round in 0..5 {
                        settings
                            .set(format!("key-{writer}"), json!({"round": round}))
                            .unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }

        let mut expected = Map::new();
        expected.insert("config-version".into(), json!(3));
        for writer in 0..8 {
            expected.insert(format!("key-{writer}"), json!({"round": 4}));
        }
        assert_eq!(on_disk(&path), Value::Object(expected));
        assert!(temp_leftovers(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
