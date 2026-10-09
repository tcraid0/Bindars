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

/// Every `.bindars-*` temporary or recovery sibling left in `dir`. Fails on a
/// directory that cannot be listed rather than reporting it as clean.
pub(crate) fn temp_leftovers(dir: &Path) -> Vec<PathBuf> {
    let mut leftovers: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("list fixture directory")
        .map(|entry| entry.expect("read fixture entry").path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".bindars-"))
        })
        .collect();
    leftovers.sort();
    leftovers
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

/// macOS access-metadata fixtures, applied and read back with the system tools
/// so the tests do not depend on the code under test.
#[cfg(target_os = "macos")]
pub(crate) mod access_metadata {
    use std::path::Path;
    use std::process::Command;

    pub(crate) const XATTR: &str = "com.bindars.test";

    pub(crate) fn add_acl(path: &Path, entry: &str) {
        let status = Command::new("/bin/chmod")
            .args(["+a", entry])
            .arg(path)
            .status()
            .expect("run chmod +a");
        assert!(status.success(), "chmod +a {entry:?} failed");
    }

    pub(crate) fn remove_acl(path: &Path, entry: &str) {
        let status = Command::new("/bin/chmod")
            .args(["-a", entry])
            .arg(path)
            .status()
            .expect("run chmod -a");
        assert!(status.success(), "chmod -a {entry:?} failed");
    }

    pub(crate) fn acl_text(path: &Path) -> String {
        let output = Command::new("/bin/ls")
            .arg("-le")
            .arg(path)
            .output()
            .expect("run ls -le");
        assert!(
            output.status.success(),
            "ls -le failed for {}",
            path.display()
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    pub(crate) fn set_xattr(path: &Path, value: &str) {
        let status = Command::new("/usr/bin/xattr")
            .args(["-w", XATTR, value])
            .arg(path)
            .status()
            .expect("run xattr -w");
        assert!(status.success(), "xattr -w failed");
    }

    pub(crate) fn xattr(path: &Path) -> Option<String> {
        let output = Command::new("/usr/bin/xattr")
            .args(["-p", XATTR])
            .arg(path)
            .output()
            .expect("run xattr -p");
        if output.status.success() {
            return Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        // Only a missing attribute counts as absent; any other failure is a
        // broken fixture, not a passing negative assertion.
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("No such xattr"),
            "xattr -p failed: {stderr}"
        );
        None
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
