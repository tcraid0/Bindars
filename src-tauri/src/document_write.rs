//! The opened parent owns every operation: mutable ancestor paths cannot redirect
//! a save. Where supported, exchange retains the displaced entry for inspection.
//! Other filesystems use plain replacement (without competing-version recovery)
//! or exclusive creation through an open file handle.
use std::ffi::{CString, OsStr};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::atomic_write::sync_directory;
use crate::document_io::{
    conditional_write_result, is_markdown_path, read_bounded_file, revision_from_bytes,
    written_file_revision, ConditionalWriteResult, FileRevision, NewMarkdownFile,
};
use crate::file_errors::{
    NativeFileError, NativeFileErrorCategory as Category, NativeFileOperation as Op,
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn changed_location() -> NativeFileError {
    NativeFileError::invalid(Op::InspectWriteTarget,
        "The document or its folder changed location. Reopen it, or use Save As to keep your edits.")
}

fn located_directory(dir: &File) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: F_GETPATH writes a NUL-terminated path into `buffer`. The
        // buffer is PATH_MAX bytes, which is the size that call requires.
        let result = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
        if result == -1 {
            return None;
        }
        let end = buffer.iter().position(|byte| *byte == 0)?;
        let text = OsStr::from_bytes(&buffer[..end]);
        if text.is_empty() {
            None
        } else {
            Some(PathBuf::from(text))
        }
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/self/fd/{}", dir.as_raw_fd())).ok()
    }
}

fn folder_changed_before_replace() -> NativeFileError {
    NativeFileError::destination_changed(
        "The document's folder changed during saving, before the file was replaced. Reopen the document, or use Save As to keep your edits.",
    )
}

fn folder_moved_after_write(dir: &File, recovery_path: Option<&str>) -> NativeFileError {
    let folder = located_directory(dir);
    let location = folder
        .as_ref()
        .map(|path| format!(" The saved text went into {}.", path.display()))
        .unwrap_or_else(|| " The saved text went into the original folder.".to_string());
    let retained = recovery_path
        .and_then(|path| Path::new(path).file_name())
        .map(|name| match &folder {
            Some(path) => format!(" Another version is at {}.", path.join(name).display()),
            None => format!(
                " Another version is named {} in the original folder.",
                name.to_string_lossy()
            ),
        })
        .unwrap_or_default();
    NativeFileError::destination_changed(format!(
        "The folder moved during saving.{location}{retained} Use Save As to keep your current edits."
    ))
}

fn name_cstring(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn open_at(parent: &File, name: &OsStr, flags: i32, mode: u32) -> io::Result<File> {
    let name = name_cstring(name)?;
    // SAFETY: parent is a live directory fd; name is NUL-terminated. openat
    // returns a new owned descriptor, which is closed by File on every path.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is a newly opened descriptor; this File takes sole ownership.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn open_parent(path: &Path) -> Result<File, NativeFileError> {
    let parent = path
        .parent()
        .filter(|_| path.is_absolute())
        .ok_or_else(changed_location)?;
    let mut dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open("/")
        .map_err(|e| NativeFileError::from_io(Op::ResolveWriteParent, parent, e))?;
    for component in parent.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                dir = open_at(&dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0).map_err(|e| {
                    if matches!(e.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) {
                        changed_location()
                    } else {
                        NativeFileError::from_io(Op::ResolveWriteParent, parent, e)
                    }
                })?;
            }
            _ => return Err(changed_location()),
        }
    }
    Ok(dir)
}

fn same_parent(path: &Path, parent: &File) -> bool {
    let pair = open_parent(path).and_then(|dir| {
        dir.metadata()
            .map_err(|e| NativeFileError::from_io(Op::InspectWriteParent, path, e))
    });
    match (pair, parent.metadata()) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

fn remove_at(parent: &File, name: &OsStr) -> io::Result<()> {
    let name = name_cstring(name)?;
    // SAFETY: live fd and NUL-terminated single-component name; flags=0 never
    // follows a symlink or recursively removes a substituted directory.
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn rename_at(parent: &File, from: &OsStr, to: &OsStr, exchange: bool) -> io::Result<()> {
    let from = name_cstring(from)?;
    let to = name_cstring(to)?;
    // SAFETY: both names belong to the same live directory descriptor. No
    // ambient path resolution occurs. Neither operation follows final symlinks.
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
            if exchange {
                libc::RENAME_SWAP
            } else {
                libc::RENAME_EXCL
            },
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
            if exchange {
                libc::RENAME_EXCHANGE
            } else {
                libc::RENAME_NOREPLACE
            },
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn rename_flags_unsupported(error: &io::Error) -> bool {
    let Some(code) = error.raw_os_error() else {
        return false;
    };
    // Linux also uses EINVAL for unsupported rename flags and ENOSYS when the
    // kernel lacks renameat2. Our flags and single-component names are fixed.
    // Do not retry I/O/permission errors: a failed network rename is ambiguous.
    #[cfg(target_os = "linux")]
    if code == libc::EINVAL || code == libc::ENOSYS {
        return true;
    }
    code == libc::ENOTSUP || code == libc::EOPNOTSUPP
}

fn replace_at(parent: &File, from: &OsStr, to: &OsStr) -> io::Result<()> {
    let from = name_cstring(from)?;
    let to = name_cstring(to)?;
    // SAFETY: live directory fd and NUL-terminated single-component names.
    // renameat replaces the entry itself, never a final symlink's referent.
    if unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            from.as_ptr(),
            parent.as_raw_fd(),
            to.as_ptr(),
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn open_document(parent: &File, path: &Path) -> Result<File, NativeFileError> {
    let name = path.file_name().ok_or_else(changed_location)?;
    // NONBLOCK avoids hanging on a FIFO substituted for the document. It has no
    // effect on regular-file reads; metadata below rejects every other kind.
    let file = open_at(parent, name, libc::O_RDONLY | libc::O_NONBLOCK, 0).map_err(|e| {
        if e.raw_os_error() == Some(libc::ELOOP) {
            changed_location()
        } else {
            NativeFileError::from_io(Op::ResolveDocument, path, e)
        }
    })?;
    let metadata = file
        .metadata()
        .map_err(|e| NativeFileError::from_io(Op::InspectWriteTarget, path, e))?;
    if !metadata.is_file() {
        return Err(changed_location());
    }
    if metadata.permissions().readonly() {
        return Err(NativeFileError::read_only(Op::SaveDocument, path));
    }
    Ok(file)
}

pub(crate) fn write_document(
    path: &Path,
    content: &str,
    expected: Option<&FileRevision>,
    force: bool,
) -> Result<ConditionalWriteResult, NativeFileError> {
    write_document_with(path, content, expected, force, |_| {})
}

pub(crate) fn create_document(
    path: &Path,
    content: &str,
) -> Result<NewMarkdownFile, NativeFileError> {
    match write_document_using(path, content, WriteMode::CreateNew, |_| {}, rename_at) {
        Ok(result) => Ok(NewMarkdownFile::Written(result)),
        // Only destination collisions advance draft numbering. A staging-file
        // failure (even EEXIST) remains a real error.
        Err(error)
            if error.category == Category::AlreadyExists
                && matches!(error.operation, Op::ReplaceFile | Op::SaveDocument) =>
        {
            Ok(NewMarkdownFile::AlreadyExists)
        }
        Err(error) => Err(error),
    }
}

enum WriteMode<'a> {
    Save {
        expected: Option<&'a FileRevision>,
        force: bool,
    },
    CreateNew,
}

fn create_file_with(
    parent: &File,
    path: &Path,
    mode: u32,
    write: impl FnOnce(&mut File) -> io::Result<FileRevision>,
) -> Result<FileRevision, NativeFileError> {
    let name = path.file_name().ok_or_else(changed_location)?;
    let mut created = open_at(
        parent,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        mode,
    )
    .map_err(|error| NativeFileError::from_io(Op::SaveDocument, path, error))?;
    // Keep ownership of the opened file through writes and sync. On failure,
    // leave any partial file: unlinking this name could delete an outside replacement.
    write(&mut created).map_err(|error| NativeFileError::incomplete_write(path, error))
}

// Explicit test seams, without global gates, permit deterministic concurrent
// processes/threads and mutations of exactly the destination under test.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SaveStage {
    Checked,
    Staged,
    Replacing,
    Created,
    Exchanged,
}

fn write_document_with(
    path: &Path,
    content: &str,
    expected: Option<&FileRevision>,
    force: bool,
    at_stage: impl FnMut(SaveStage),
) -> Result<ConditionalWriteResult, NativeFileError> {
    write_document_using(
        path,
        content,
        WriteMode::Save { expected, force },
        at_stage,
        rename_at,
    )
}

fn write_document_using(
    path: &Path,
    content: &str,
    mode: WriteMode<'_>,
    mut at_stage: impl FnMut(SaveStage),
    mut rename: impl FnMut(&File, &OsStr, &OsStr, bool) -> io::Result<()>,
) -> Result<ConditionalWriteResult, NativeFileError> {
    if !is_markdown_path(path) {
        return Err(NativeFileError::invalid(
            Op::ValidateDocument,
            "Not a supported file type (.md, .markdown, or .fountain).",
        ));
    }
    let parent = open_parent(path)?;
    let name = path.file_name().ok_or_else(changed_location)?;
    let (checked, permissions) = match mode {
        WriteMode::CreateNew => (None, None),
        WriteMode::Save { expected, force } => match open_document(&parent, path) {
            Ok(file) => {
                let (bytes, metadata) = read_bounded_file(path, file, Op::CheckRevision)?;
                let revision = revision_from_bytes(&metadata, &bytes);
                if !force {
                    let expected = expected.ok_or_else(|| {
                        NativeFileError::invalid(
                            Op::CheckRevision,
                            "Missing expected revision for conditional write.",
                        )
                    })?;
                    if expected != &revision {
                        return Ok(conditional_write_result(path, true, revision));
                    }
                }
                (Some(revision), Some(metadata.permissions()))
            }
            Err(e)
                if force && e.category == crate::file_errors::NativeFileErrorCategory::NotFound =>
            {
                (None, None)
            }
            Err(e) => return Err(e),
        },
    };
    at_stage(SaveStage::Checked);
    let unique = format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let temp_name = format!(".bindars-save-{unique}");
    let temp = OsStr::new(&temp_name);
    let mode_bits = permissions
        .as_ref()
        .map(|p| p.mode() & 0o777)
        .unwrap_or(0o666);
    let mut staged = open_at(
        &parent,
        temp,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        mode_bits,
    )
    .map_err(|e| NativeFileError::from_io(Op::CreateTemporaryFile, path, e))?;
    let prepare = (|| {
        staged
            .write_all(content.as_bytes())
            .map_err(|e| NativeFileError::from_io(Op::WriteTemporaryFile, path, e))?;
        if let Some(p) = permissions {
            staged
                .set_permissions(p)
                .map_err(|e| NativeFileError::from_io(Op::PreservePermissions, path, e))?;
        }
        staged
            .sync_all()
            .map_err(|e| NativeFileError::from_io(Op::SyncTemporaryFile, path, e))?;
        let metadata = staged
            .metadata()
            .map_err(|e| NativeFileError::from_io(Op::InspectSavedDocument, path, e))?;
        Ok::<_, NativeFileError>(written_file_revision(&metadata, content))
    })();
    drop(staged);
    let mut saved_revision = match prepare {
        Ok(revision) => revision,
        Err(e) => {
            let _ = remove_at(&parent, temp);
            return Err(e);
        }
    };
    at_stage(SaveStage::Staged);
    if !same_parent(path, &parent) {
        let _ = remove_at(&parent, temp);
        return Err(folder_changed_before_replace());
    }
    at_stage(SaveStage::Replacing);
    let exchanged = match rename(&parent, temp, name, checked.is_some()) {
        Ok(()) => checked.is_some(),
        Err(error) if rename_flags_unsupported(&error) => {
            let fallback = if checked.is_some() {
                // Compatibility with filesystems lacking exchange: as in 1.5.0,
                // an outside edit after revision checking can be overwritten.
                // There is no displaced entry to inspect or report as recovery.
                replace_at(&parent, temp, name)
                    .map_err(|error| NativeFileError::from_io(Op::SaveDocument, path, error))
            } else {
                // The staged handle is closed. Release its space before creating
                // another copy; failure to remove it must not start a second write.
                remove_at(&parent, temp)
                    .map_err(|error| NativeFileError::from_io(Op::SaveDocument, path, error))?;
                create_file_with(&parent, path, mode_bits, |created| {
                    at_stage(SaveStage::Created);
                    created.write_all(content.as_bytes())?;
                    created.sync_all()?;
                    Ok(written_file_revision(&created.metadata()?, content))
                })
                .map(|revision| {
                    saved_revision = revision;
                })
            };
            let _ = remove_at(&parent, temp);
            fallback?;
            false
        }
        Err(error) => {
            let _ = remove_at(&parent, temp);
            let mut error = NativeFileError::from_io(Op::ReplaceFile, path, error);
            error
                .message
                .push_str(" Use Save As to keep your edits in a new file.");
            return Err(error);
        }
    };
    at_stage(SaveStage::Exchanged);
    let mut result = conditional_write_result(path, false, saved_revision);
    if let Some(checked) = checked.filter(|_| exchanged) {
        let displaced = open_document(&parent, &path.with_file_name(temp))
            .and_then(|file| read_bounded_file(path, file, Op::CheckRevision))
            .map(|(bytes, metadata)| revision_from_bytes(&metadata, &bytes));
        // Once exchanged, never roll back over a possible third writer. Retain
        // the displaced entry when the bytes observed here differ or cannot be
        // read. A write that completes after this read and before the unlink,
        // or through an old descriptor after the unlink, is not retained.
        // Metadata-only changes do not require a competing-content copy.
        let matches = displaced.as_ref().is_ok_and(|revision| {
            revision.size == checked.size && revision.content_hash == checked.content_hash
        });
        if !matches || remove_at(&parent, temp).is_err() {
            let recovery_name = format!(
                "Bindars recovered {unique}.{}",
                path.extension()
                    .unwrap_or_else(|| OsStr::new("md"))
                    .to_string_lossy()
            );
            let retained_name = if rename(&parent, temp, OsStr::new(&recovery_name), false).is_ok()
            {
                OsStr::new(&recovery_name)
            } else {
                temp
            };
            result.recovery_path = Some(
                path.with_file_name(retained_name)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    let _ = sync_directory(&parent);
    // Our directory handle remains valid if a parent moves. Do not acknowledge
    // the obsolete pathname as a successful save into a replacement directory.
    if !same_parent(path, &parent) {
        return Err(folder_moved_after_write(
            &parent,
            result.recovery_path.as_deref(),
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_io::open_markdown_file_impl;
    use std::fs;
    use std::os::unix::fs::symlink;
    use std::sync::{Arc, Barrier};

    fn fixture(label: &str) -> (std::path::PathBuf, std::path::PathBuf, FileRevision) {
        let root = crate::test_support::unique_temp_dir(label);
        fs::create_dir(&root).unwrap();
        let root = dunce::canonicalize(root).unwrap();
        let path = root.join("document.md");
        fs::write(&path, "original").unwrap();
        let opened = open_markdown_file_impl(path.to_string_lossy().into_owned()).unwrap();
        (root, path, opened.revision)
    }

    fn unsupported_rename(_: &File, _: &OsStr, _: &OsStr, _: bool) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(libc::ENOTSUP))
    }

    #[test]
    fn saves_sync_the_parent_directory_handle_they_rename_in() {
        // Saves ignore a sync failure, so a handle kind that cannot be synced
        // (such as O_PATH on Linux) would silently lose rename durability.
        let (root, path, _) = fixture("dir-sync");
        let parent = open_parent(&path).unwrap();
        sync_directory(&parent).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creation_fallback_releases_the_staged_handle_and_name_before_creating() {
        let (root, path, _) = fixture("creation-space");
        fs::remove_file(&path).unwrap();
        let mut checked_handle = false;
        let mut checked_name = false;
        write_document_using(
            &path,
            "local",
            WriteMode::CreateNew,
            |stage| {
                if stage == SaveStage::Staged {
                    let temp = fs::read_dir(&root)
                        .unwrap()
                        .map(|e| e.unwrap().path())
                        .find(|p| {
                            p.file_name()
                                .unwrap()
                                .to_string_lossy()
                                .starts_with(".bindars-save-")
                        })
                        .unwrap();
                    let staged = fs::metadata(temp).unwrap();
                    // Inspect descriptors in this test process only. Comparing inode
                    // identity also handles unrelated tests opening/reusing fd numbers.
                    let fd_dir = if cfg!(target_os = "macos") {
                        "/dev/fd"
                    } else {
                        "/proc/self/fd"
                    };
                    for entry in fs::read_dir(fd_dir).unwrap() {
                        let Some(fd) = entry
                            .ok()
                            .and_then(|e| e.file_name().to_str()?.parse::<i32>().ok())
                        else {
                            continue;
                        };
                        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
                        // SAFETY: fstat only writes to the allocated stat; another
                        // thread closing this fd produces an error, never a dereference.
                        if unsafe { libc::fstat(fd, metadata.as_mut_ptr()) } == 0 {
                            // SAFETY: successful fstat initialized the entire value.
                            let metadata = unsafe { metadata.assume_init() };
                            #[cfg(target_os = "macos")]
                            let device = metadata.st_dev as u64;
                            #[cfg(target_os = "linux")]
                            let device = metadata.st_dev;
                            assert_ne!(
                                (device, metadata.st_ino),
                                (staged.dev(), staged.ino()),
                                "staging handle must be closed before fallback"
                            );
                        }
                    }
                    checked_handle = true;
                }
                if stage == SaveStage::Created {
                    assert!(!fs::read_dir(&root).unwrap().any(|e| e
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".bindars-save-")));
                    checked_name = true;
                }
            },
            unsupported_rename,
        )
        .unwrap();
        assert!(checked_handle && checked_name);
        assert_eq!(fs::read_to_string(&path).unwrap(), "local");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_only_never_replaces_occupied_destinations() {
        for forced_fallback in [false, true] {
            for late in [false, true] {
                for kind in ["file", "readonly", "symlink", "dangling", "directory"] {
                    let (root, path, _) = fixture("exclusive-create");
                    fs::remove_file(&path).unwrap();
                    let other = root.join("other.md");
                    fs::write(&other, "other document").unwrap();
                    let occupy = || match kind {
                        "symlink" => symlink(&other, &path).unwrap(),
                        "dangling" => symlink(root.join("absent.md"), &path).unwrap(),
                        "directory" => fs::create_dir(&path).unwrap(),
                        _ => {
                            fs::write(&path, "outside replacement").unwrap();
                            if kind == "readonly" {
                                fs::set_permissions(&path, fs::Permissions::from_mode(0o400))
                                    .unwrap();
                            }
                        }
                    };
                    if !late {
                        occupy();
                    }
                    let error = write_document_using(
                        &path,
                        "local",
                        WriteMode::CreateNew,
                        |stage| {
                            if late && stage == SaveStage::Staged {
                                occupy();
                            }
                        },
                        if forced_fallback {
                            unsupported_rename
                        } else {
                            rename_at
                        },
                    )
                    .unwrap_err();
                    assert_eq!(
                        error.category,
                        Category::AlreadyExists,
                        "{kind}, late={late}, fallback={forced_fallback}"
                    );
                    assert_eq!(fs::read_to_string(&other).unwrap(), "other document");
                    match kind {
                        "directory" => assert!(path.is_dir()),
                        "symlink" | "dangling" => assert!(fs::symlink_metadata(&path)
                            .unwrap()
                            .file_type()
                            .is_symlink()),
                        _ => assert_eq!(fs::read_to_string(&path).unwrap(), "outside replacement"),
                    }
                    // The public creation result must let draft numbering continue.
                    assert!(matches!(
                        create_document(&path, "retry").unwrap(),
                        NewMarkdownFile::AlreadyExists
                    ));
                    fs::remove_dir_all(root).unwrap();
                }
            }
        }
    }

    #[test]
    fn failed_direct_creation_keeps_partial_bytes_and_never_deletes_a_replacement() {
        for replace in [false, true] {
            for code in [
                libc::ENOSPC,
                libc::EROFS,
                libc::EACCES,
                libc::ENOENT,
                libc::ETIMEDOUT,
            ] {
                let (root, path, _) = fixture("failed-created-write");
                fs::remove_file(&path).unwrap();
                let parent = open_parent(&path).unwrap();
                let retained = root.join("claimed.md");
                let error = create_file_with(&parent, &path, 0o600, |created| {
                    created.write_all(b"partial")?;
                    if replace {
                        fs::rename(&path, &retained).unwrap();
                        fs::write(&path, "outside replacement").unwrap();
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
                    }
                    // A write or final sync can fail after bytes were published.
                    Err(io::Error::from_raw_os_error(code))
                })
                .unwrap_err();
                assert_eq!(error.category, Category::IncompleteWrite);
                assert!(error.message.contains("may be incomplete"));
                assert!(!error.message.contains("was not changed"));
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    if replace {
                        "outside replacement"
                    } else {
                        "partial"
                    }
                );
                if replace {
                    assert_eq!(fs::read_to_string(&retained).unwrap(), "partial");
                }
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    // These guarantees hold both with exchange and on compatibility volumes.
    // Run this test with TMPDIR on a real non-exchange filesystem as well.
    #[test]
    fn filesystem_compatibility_saves_and_checks_revisions() {
        for forced_fallback in [false, true] {
            let rename = if forced_fallback {
                unsupported_rename
            } else {
                rename_at
            };
            for create in [false, true] {
                let (root, path, revision) = fixture("compatible-save");
                if create {
                    fs::remove_file(&path).unwrap();
                }
                let saved = write_document_using(
                    &path,
                    "local",
                    WriteMode::Save {
                        expected: Some(&revision),
                        force: create,
                    },
                    |_| {},
                    rename,
                )
                .unwrap();
                assert!(!saved.conflict);
                assert!(saved.recovery_path.is_none());
                let opened = open_markdown_file_impl(path.to_string_lossy().into_owned()).unwrap();
                assert_eq!(fs::read_to_string(&path).unwrap(), "local");
                assert_eq!(saved.current_revision, opened.revision);
                let next = write_document_using(
                    &path,
                    "next",
                    WriteMode::Save {
                        expected: Some(&saved.current_revision),
                        force: false,
                    },
                    |_| {},
                    rename,
                )
                .unwrap();
                assert!(!next.conflict);
                fs::write(&path, "outside before save").unwrap();
                let conflict = write_document_using(
                    &path,
                    "rejected",
                    WriteMode::Save {
                        expected: Some(&next.current_revision),
                        force: false,
                    },
                    |_| {},
                    rename,
                )
                .unwrap();
                assert!(conflict.conflict);
                assert_eq!(fs::read_to_string(&path).unwrap(), "outside before save");
                let overwrite = write_document_using(
                    &path,
                    "explicit overwrite",
                    WriteMode::Save {
                        expected: Some(&next.current_revision),
                        force: true,
                    },
                    |_| {},
                    rename,
                )
                .unwrap();
                assert!(!overwrite.conflict);
                assert_eq!(fs::read_to_string(&path).unwrap(), "explicit overwrite");
                assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn fallback_replacement_has_no_competing_version_recovery() {
        let (root, path, revision) = fixture("fallback-race-limit");
        let result = write_document_using(
            &path,
            "local",
            WriteMode::Save {
                expected: Some(&revision),
                force: false,
            },
            |stage| {
                if stage == SaveStage::Replacing {
                    fs::write(&path, "outside after check").unwrap();
                }
            },
            unsupported_rename,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "local");
        assert!(result.recovery_path.is_none());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fallback_creation_never_clobbers_an_entry_that_appeared_before_claiming() {
        for symlink_target in [false, true] {
            let (root, path, _) = fixture("fallback-create-race");
            fs::remove_file(&path).unwrap();
            let other = root.join("other.md");
            fs::write(&other, "other document").unwrap();
            let result = write_document_using(
                &path,
                "local",
                WriteMode::Save {
                    expected: None,
                    force: true,
                },
                |stage| {
                    if stage == SaveStage::Replacing {
                        if symlink_target {
                            symlink(&other, &path).unwrap();
                        } else {
                            fs::write(&path, "outside new file").unwrap();
                        }
                    }
                },
                unsupported_rename,
            );
            assert!(result.is_err());
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                if symlink_target {
                    "other document"
                } else {
                    "outside new file"
                }
            );
            assert_eq!(fs::read_to_string(other).unwrap(), "other document");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn fallback_creation_writes_the_claimed_handle_after_name_substitution() {
        let (root, path, _) = fixture("fallback-claimed-handle");
        fs::remove_file(&path).unwrap();
        let moved = root.join("claimed.md");
        let other = root.join("other.md");
        fs::write(&other, "other document").unwrap();
        write_document_using(
            &path,
            "local",
            WriteMode::Save {
                expected: None,
                force: true,
            },
            |stage| {
                if stage == SaveStage::Created {
                    fs::rename(&path, &moved).unwrap();
                    symlink(&other, &path).unwrap();
                }
            },
            unsupported_rename,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(moved).unwrap(), "local");
        assert_eq!(fs::read_to_string(other).unwrap(), "other document");
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fallback_replacement_never_follows_a_substituted_symlink() {
        for force in [false, true] {
            let (root, path, revision) = fixture("fallback-replace-symlink");
            let other = root.join("other.md");
            fs::write(&other, "original").unwrap();
            let saved = write_document_using(
                &path,
                "local",
                WriteMode::Save {
                    expected: Some(&revision),
                    force,
                },
                |stage| {
                    if stage == SaveStage::Replacing {
                        fs::remove_file(&path).unwrap();
                        symlink(&other, &path).unwrap();
                    }
                },
                unsupported_rename,
            )
            .unwrap();
            assert!(!saved.conflict);
            assert_eq!(fs::read_to_string(&path).unwrap(), "local");
            assert_eq!(fs::read_to_string(other).unwrap(), "original");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn fallback_saves_remain_bound_to_the_original_parent() {
        for create in [false, true] {
            let (root, path, revision) = fixture("fallback-parent-move");
            if create {
                fs::remove_file(&path).unwrap();
            }
            let moved = root.with_extension("moved");
            let other = root.with_extension("other");
            fs::create_dir(&other).unwrap();
            fs::write(other.join("document.md"), "other document").unwrap();
            let error = write_document_using(
                &path,
                "local",
                WriteMode::Save {
                    expected: Some(&revision),
                    force: create,
                },
                |stage| {
                    if stage == SaveStage::Replacing {
                        fs::rename(&root, &moved).unwrap();
                        symlink(&other, &root).unwrap();
                    }
                },
                unsupported_rename,
            )
            .unwrap_err();
            assert_eq!(error.detail, "destination-changed");
            assert!(error.message.contains(moved.to_string_lossy().as_ref()));
            assert_eq!(
                fs::read_to_string(other.join("document.md")).unwrap(),
                "other document"
            );
            assert_eq!(
                fs::read_to_string(moved.join("document.md")).unwrap(),
                "local"
            );
            assert_eq!(fs::read_dir(&moved).unwrap().count(), 1);
            fs::remove_file(&root).unwrap();
            fs::remove_dir_all(moved).unwrap();
            fs::remove_dir_all(other).unwrap();
        }
    }

    #[test]
    fn fallback_is_limited_to_unsupported_rename_flags() {
        let mut unsupported = vec![libc::ENOTSUP, libc::EOPNOTSUPP];
        #[cfg(target_os = "linux")]
        unsupported.extend([libc::ENOSYS, libc::EINVAL]);
        unsupported.dedup();
        let mut rejected = vec![
            libc::EACCES,
            libc::EIO,
            libc::EEXIST,
            libc::ENOENT,
            libc::EINTR,
        ];
        #[cfg(target_os = "macos")]
        rejected.extend([libc::EINVAL, libc::ENOSYS]);
        rejected.dedup();
        for (codes, should_save) in [(unsupported, true), (rejected, false)] {
            for code in codes {
                for create in [false, true] {
                    let (root, path, revision) = fixture("fallback-error-gate");
                    if create {
                        fs::remove_file(&path).unwrap();
                    }
                    let result = write_document_using(
                        &path,
                        "local",
                        WriteMode::Save {
                            expected: Some(&revision),
                            force: create,
                        },
                        |_| {},
                        |_, _, _, _| Err(io::Error::from_raw_os_error(code)),
                    );
                    assert_eq!(result.is_ok(), should_save, "errno {code}, create {create}");
                    if should_save {
                        assert_eq!(fs::read_to_string(&path).unwrap(), "local");
                    } else if create {
                        assert!(!path.exists());
                    } else {
                        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
                    }
                    assert_eq!(
                        fs::read_dir(&root).unwrap().count(),
                        usize::from(!create || should_save)
                    );
                    fs::remove_dir_all(root).unwrap();
                }
            }
        }
    }

    #[test]
    fn preserves_the_actual_version_displaced_after_revision_checking() {
        for force in [false, true] {
            for stage in [SaveStage::Checked, SaveStage::Staged, SaveStage::Replacing] {
                let (root, path, revision) = fixture("displaced-write");
                let result = write_document_with(&path, "local", Some(&revision), force, |at| {
                    if at == stage {
                        fs::write(&path, "outside after check").unwrap();
                    }
                })
                .unwrap();
                assert_eq!(fs::read_to_string(&path).unwrap(), "local");
                assert_eq!(
                    fs::read_to_string(result.recovery_path.unwrap()).unwrap(),
                    "outside after check"
                );
                assert_eq!(
                    result.current_revision.content_hash,
                    crate::document_io::stable_hash_hex(b"local")
                );
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn concurrent_saves_preserve_the_losing_version() {
        let (root, path, revision) = fixture("concurrent-exchange");
        let barrier = Arc::new(Barrier::new(2));
        let threads: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|words| {
                let (path, revision, barrier) = (path.clone(), revision.clone(), barrier.clone());
                std::thread::spawn(move || {
                    write_document_with(&path, words, Some(&revision), false, |stage| {
                        if stage == SaveStage::Checked {
                            barrier.wait();
                        }
                    })
                    .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        let copies: Vec<_> = results
            .iter()
            .filter_map(|r| r.recovery_path.as_ref())
            .collect();
        assert_eq!(copies.len(), 1);
        let mut contents = vec![
            fs::read_to_string(&path).unwrap(),
            fs::read_to_string(copies[0]).unwrap(),
        ];
        contents.sort();
        assert_eq!(contents, ["first", "second"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_write_after_exchange_is_never_replaced_by_recovery() {
        let (root, path, revision) = fixture("third-writer");
        let result = write_document_with(&path, "local", Some(&revision), false, |stage| {
            if stage == SaveStage::Staged {
                fs::write(&path, "outside one").unwrap();
            }
            if stage == SaveStage::Exchanged {
                fs::write(&path, "outside two").unwrap();
            }
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "outside two");
        assert_eq!(
            fs::read_to_string(result.recovery_path.unwrap()).unwrap(),
            "outside one"
        );
        let next =
            write_document(&path, "local next", Some(&result.current_revision), false).unwrap();
        assert!(next.conflict);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symlink_substitution_never_writes_the_other_document_even_when_contents_match() {
        for stage in [
            None,
            Some(SaveStage::Checked),
            Some(SaveStage::Staged),
            Some(SaveStage::Replacing),
        ] {
            for force in [false, true] {
                let (root, path, revision) = fixture("symlink-save");
                let other = root.join("other.md");
                fs::write(&other, "original").unwrap();
                let replace = || {
                    fs::remove_file(&path).unwrap();
                    symlink(&other, &path).unwrap();
                };
                if stage.is_none() {
                    replace();
                }
                let result = write_document_with(&path, "local", Some(&revision), force, |at| {
                    if Some(at) == stage {
                        replace();
                    }
                });
                assert_eq!(fs::read_to_string(&other).unwrap(), "original");
                if stage.is_none() {
                    assert!(result.is_err());
                } else {
                    let copy = result.unwrap().recovery_path.unwrap();
                    assert!(fs::symlink_metadata(copy).unwrap().file_type().is_symlink());
                }
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn substituted_parent_cannot_redirect_staging_replacement_or_acknowledgment() {
        for stage in [
            SaveStage::Checked,
            SaveStage::Staged,
            SaveStage::Replacing,
            SaveStage::Exchanged,
        ] {
            let (root, path, revision) = fixture("parent-save");
            let moved = root.with_extension("moved");
            let other = root.with_extension("other");
            fs::create_dir(&other).unwrap();
            fs::write(other.join("document.md"), "other document").unwrap();
            let result = write_document_with(&path, "local", Some(&revision), false, |at| {
                if at == stage {
                    fs::rename(&root, &moved).unwrap();
                    symlink(&other, &root).unwrap();
                }
            });
            let error = result.expect_err("a moved folder must not be acknowledged");
            assert_eq!(error.detail, "destination-changed");
            if matches!(stage, SaveStage::Replacing | SaveStage::Exchanged) {
                let folder_name = moved.file_name().unwrap().to_string_lossy();
                assert!(
                    error.message.contains(folder_name.as_ref()),
                    "moved-folder error should name the original folder: {}",
                    error.message
                );
            }
            assert_eq!(
                fs::read_to_string(other.join("document.md")).unwrap(),
                "other document"
            );
            assert_eq!(
                fs::read_to_string(moved.join("document.md")).unwrap(),
                if matches!(stage, SaveStage::Replacing | SaveStage::Exchanged) {
                    "local"
                } else {
                    "original"
                }
            );
            assert_eq!(fs::read_dir(&moved).unwrap().count(), 1);
            fs::remove_file(&root).unwrap();
            fs::remove_dir_all(moved).unwrap();
            fs::remove_dir_all(other).unwrap();
        }
    }

    #[test]
    fn retained_version_is_reported_in_the_moved_folder() {
        for stage in [SaveStage::Replacing, SaveStage::Exchanged] {
            let (root, path, revision) = fixture("retained-parent-move");
            let moved = root.with_extension("moved");
            let other = root.with_extension("other");
            fs::create_dir(&other).unwrap();
            fs::write(other.join("document.md"), "other document").unwrap();
            let error = write_document_with(&path, "local", Some(&revision), false, |at| {
                if at == SaveStage::Checked {
                    fs::write(&path, "outside after check").unwrap();
                }
                if at == stage {
                    fs::rename(&root, &moved).unwrap();
                    symlink(&other, &root).unwrap();
                }
            })
            .expect_err("a moved folder must not be acknowledged");
            assert_eq!(error.detail, "destination-changed");
            let retained: Vec<_> = fs::read_dir(&moved)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.file_name().unwrap() != "document.md")
                .collect();
            assert_eq!(retained.len(), 1);
            assert_eq!(
                fs::read_to_string(&retained[0]).unwrap(),
                "outside after check"
            );
            assert!(
                error
                    .message
                    .contains(retained[0].to_string_lossy().as_ref()),
                "error must name the retained file's actual location: {}",
                error.message
            );
            let obsolete = root.join(retained[0].file_name().unwrap());
            assert!(!error.message.contains(obsolete.to_string_lossy().as_ref()));
            assert_eq!(
                fs::read_to_string(moved.join("document.md")).unwrap(),
                "local"
            );
            assert_eq!(
                fs::read_to_string(other.join("document.md")).unwrap(),
                "other document"
            );
            fs::remove_file(&root).unwrap();
            fs::remove_dir_all(moved).unwrap();
            fs::remove_dir_all(other).unwrap();
        }
    }

    #[test]
    fn ordinary_and_explicit_overwrite_saves_leave_no_recovery_copy() {
        for force in [false, true] {
            let (root, path, revision) = fixture("normal-save");
            if force {
                fs::write(&path, "outside before explicit overwrite").unwrap();
            }
            let saved = write_document(&path, "local", Some(&revision), force).unwrap();
            assert!(!saved.conflict);
            assert!(saved.recovery_path.is_none());
            assert_eq!(fs::read_to_string(&path).unwrap(), "local");
            assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn creation_never_replaces_a_file_that_appears_during_staging() {
        let (root, path, _) = fixture("create-race");
        fs::remove_file(&path).unwrap();
        let result = write_document_with(&path, "local", None, true, |stage| {
            if stage == SaveStage::Staged {
                fs::write(&path, "outside new file").unwrap();
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "outside new file");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_slow_in_place_writer_can_finish_in_the_retained_displaced_file() {
        let (root, path, revision) = fixture("in-place-writer");
        let mut outside = OpenOptions::new().write(true).open(&path).unwrap();
        let result = write_document_with(&path, "local", Some(&revision), false, |stage| {
            if stage == SaveStage::Replacing {
                outside.set_len(0).unwrap();
                outside.write_all(b"outside ").unwrap();
                outside.sync_all().unwrap();
            }
        })
        .unwrap();
        outside.write_all(b"completed later").unwrap();
        outside.sync_all().unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "local");
        assert_eq!(
            fs::read_to_string(result.recovery_path.unwrap()).unwrap(),
            "outside completed later"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_displaced_entry_is_retained_instead_of_assumed_equal() {
        let (root, path, revision) = fixture("unreadable-displaced");
        let result = write_document_with(&path, "local", Some(&revision), false, |stage| {
            if stage == SaveStage::Exchanged {
                let displaced = fs::read_dir(&root)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|p| {
                        p.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(".bindars-save-")
                    })
                    .unwrap();
                fs::set_permissions(displaced, fs::Permissions::from_mode(0o400)).unwrap();
            }
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "local");
        assert_eq!(
            fs::read_to_string(result.recovery_path.unwrap()).unwrap(),
            "original"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_failure_respects_outside_deletion_and_removes_staging() {
        let (root, path, revision) = fixture("replace-failure");
        let result = write_document_with(&path, "local", Some(&revision), false, |stage| {
            if stage == SaveStage::Replacing {
                fs::remove_file(&path).unwrap();
            }
        });
        let error = result.unwrap_err();
        assert!(error.message.contains("Save As"));
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "launched by two_independent_save_processes_preserve_both_versions"]
    fn save_process() {
        let root = std::path::PathBuf::from(std::env::var_os("BINDARS_SAVE_TEST_ROOT").unwrap());
        let words = std::env::var("BINDARS_SAVE_TEST_WORDS").unwrap();
        let path = root.join("document.md");
        let revision = open_markdown_file_impl(path.to_string_lossy().into_owned())
            .unwrap()
            .revision;
        let result = write_document_with(&path, &words, Some(&revision), false, |stage| {
            if stage == SaveStage::Checked {
                fs::write(root.join(format!("{words}.ready")), "").unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while !root.join("release").exists() {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "process barrier timed out"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        })
        .unwrap();
        fs::write(
            root.join(format!("{words}.json")),
            serde_json::to_vec(&result).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn two_independent_save_processes_preserve_both_versions() {
        let (root, path, _) = fixture("save-processes");
        let mut children: Vec<_> = ["first", "second"]
            .iter()
            .map(|words| {
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--ignored",
                        "--exact",
                        "document_write::tests::save_process",
                    ])
                    .env("BINDARS_SAVE_TEST_ROOT", &root)
                    .env("BINDARS_SAVE_TEST_WORDS", words)
                    .spawn()
                    .unwrap()
            })
            .collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("first.ready").exists() || !root.join("second.ready").exists() {
            if std::time::Instant::now() >= deadline {
                for child in &mut children {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                panic!("save processes never reached revision barrier");
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        fs::write(root.join("release"), "").unwrap();
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        let results: Vec<serde_json::Value> = ["first", "second"]
            .iter()
            .map(|words| {
                serde_json::from_slice(&fs::read(root.join(format!("{words}.json"))).unwrap())
                    .unwrap()
            })
            .collect();
        assert!(results.iter().all(|r| r["conflict"] == false));
        let copies: Vec<_> = results
            .iter()
            .filter_map(|r| r["recoveryPath"].as_str())
            .collect();
        assert_eq!(
            copies.len(),
            1,
            "one successful result must disclose the competing version"
        );
        let mut contents = vec![
            fs::read_to_string(path).unwrap(),
            fs::read_to_string(copies[0]).unwrap(),
        ];
        contents.sort();
        assert_eq!(contents, ["first", "second"]);
        fs::remove_dir_all(root).unwrap();
    }
}
