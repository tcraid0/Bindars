use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn unique_temp_name(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    format!("bindars-{prefix}-{}-{nanos}-{id}", std::process::id())
}

pub(crate) fn unique_temp_path(extension: &str) -> PathBuf {
    let parent = unique_temp_dir("test-file");
    std::fs::create_dir(&parent).expect("create isolated test fixture directory");
    parent.join("fixture").with_extension(extension)
}

pub(crate) fn unique_temp_dir(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(unique_temp_name(prefix))
}

pub(crate) fn cleanup_temp_path(path: &Path) {
    let _ = std::fs::remove_file(path);

    let Some(parent) = path.parent() else {
        return;
    };
    let is_owned_fixture_dir = parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("bindars-test-file-"));
    if is_owned_fixture_dir {
        let _ = std::fs::remove_dir(parent);
    }
}

#[test]
fn temp_paths_use_isolated_parent_directories() {
    let first = unique_temp_path("md");
    let second = unique_temp_path("md");

    assert_ne!(first.parent(), second.parent());

    cleanup_temp_path(&first);
    cleanup_temp_path(&second);
}
