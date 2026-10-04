use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::file_errors::{NativeFileError, NativeFileOperation};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Make a rename or creation inside `dir` durable. File contents are synced
/// before they are renamed into place, but the directory entry is not; after a
/// power loss the previous entry could return. Callers ignore failure: the
/// change is already visible, and some volumes (network shares, some removable
/// media) refuse to sync a directory.
#[cfg(unix)]
pub(crate) fn sync_directory(dir: &fs::File) -> std::io::Result<()> {
    dir.sync_all()
}

pub(crate) fn write_contents_atomic(
    path: &Path,
    content: &str,
    tmp_prefix: &str,
    read_only_operation: NativeFileOperation,
) -> Result<(), NativeFileError> {
    write_contents_atomic_impl(path, content, tmp_prefix, false, read_only_operation)
}

/// Copies the access metadata of `source` onto `staged` before `staged` is
/// published over it. Preserved on macOS: the ACL and every extended
/// attribute (Finder tags and comments, quarantine, resource fork, custom
/// attributes). Callers copy the mode bits separately. Not preserved: owner
/// and group, BSD flags such as locked or hidden, and timestamps. On other
/// platforms nothing beyond the mode bits is carried over.
#[cfg(target_os = "macos")]
pub(crate) fn preserve_access_metadata(source: &fs::File, staged: &fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: both descriptors are open for the whole call. A null state
    // selects copyfile's defaults; the flags limit the copy to ACL and xattrs.
    let result = unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            staged.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn preserve_access_metadata(_source: &fs::File, _staged: &fs::File) -> io::Result<()> {
    Ok(())
}

/// Atomic write for private app data. The temporary file is created owner-only on
/// Unix so its contents are never group/world readable, even
/// briefly, and inherits nothing from an existing destination. Ordinary
/// documents and exports keep an existing destination's Unix permissions and
/// access metadata through `write_contents_atomic`.
pub(crate) fn write_contents_atomic_private(
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
            target: env!("CARGO_CRATE_NAME"),
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

/// Opens an existing regular file at `path` so its permissions and access
/// metadata can be carried onto the replacement. `None` when nothing is there
/// to inherit from. A final symlink is rejected, never followed or replaced.
#[cfg(unix)]
fn open_existing_destination(
    path: &Path,
    read_only_operation: NativeFileOperation,
) -> Result<Option<(fs::File, fs::Permissions)>, NativeFileError> {
    use std::os::unix::fs::OpenOptionsExt;

    // NONBLOCK keeps a FIFO at the destination from stalling this open.
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::InspectWriteTarget,
                "The destination cannot be a symbolic link.",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(NativeFileError::from_io(
                NativeFileOperation::InspectWriteTarget,
                path,
                error,
            ));
        }
    };
    let metadata = file.metadata().map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectWriteTarget, path, error)
    })?;
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.permissions().readonly() {
        return Err(NativeFileError::read_only(read_only_operation, path));
    }
    Ok(Some((file, metadata.permissions())))
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
    let existing = if owner_only {
        None
    } else {
        open_existing_destination(path, read_only_operation)?
    };
    #[cfg(not(unix))]
    let existing = None::<(fs::File, fs::Permissions)>;
    let existing_permissions = existing.as_ref().map(|(_, permissions)| permissions);

    let mut tmp_file =
        open_atomic_temp_file(&tmp_path, owner_only, existing_permissions).map_err(|error| {
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
        if let Some((source, permissions)) = &existing {
            tmp_file
                .set_permissions(permissions.clone())
                .map_err(|error| {
                    NativeFileError::from_io(
                        NativeFileOperation::PreservePermissions,
                        &tmp_path,
                        error,
                    )
                })?;
            preserve_access_metadata(source, &tmp_file)
                .map_err(|error| NativeFileError::metadata_not_preserved(path, error))?;
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

    #[cfg(unix)]
    if let Some(dir) = path.parent().and_then(|parent| fs::File::open(parent).ok()) {
        let _ = sync_directory(&dir);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::test_support::unique_temp_dir;

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

    #[cfg(target_os = "macos")]
    #[test]
    fn private_writes_inherit_no_access_metadata_from_an_existing_destination() {
        use crate::test_support::access_metadata::{acl_text, add_acl, set_xattr, xattr};
        let root = temp_dir("atomic-private-no-inherit");
        fs::create_dir(&root).expect("create fixture root");
        let destination = root.join("annotations.json");
        fs::write(&destination, "{}").expect("write destination");
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o644)).unwrap();
        set_xattr(&destination, "shared");
        add_acl(&destination, "everyone deny write");

        write_contents_atomic_private(&destination, "{\"v\":1}", ".bindars-private-test")
            .expect("private write replaces the destination");

        assert_eq!(fs::read_to_string(&destination).unwrap(), "{\"v\":1}");
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(xattr(&destination), None);
        assert!(!acl_text(&destination).contains("deny write"));
        cleanup_dir(&root);
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

    fn temp_dir(prefix: &str) -> PathBuf {
        unique_temp_dir(prefix)
    }

    fn cleanup_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }
}
