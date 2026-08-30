use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri_plugin_opener::OpenerExt;

use crate::atomic_write::write_contents_atomic;
use crate::file_errors::{
    run_blocking_file_io, NativeFileError, NativeFileErrorCategory, NativeFileOperation,
};

pub(crate) const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
pub(crate) const MAX_MARKDOWN_SIZE_MIB: u64 = MAX_MARKDOWN_BYTES / (1024 * 1024);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenFileResult {
    canonical_path: String,
    name: String,
    content: String,
    revision: FileRevision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRevision {
    mtime_ms: u64,
    size: u64,
    content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConditionalWriteResult {
    conflict: bool,
    current_revision: FileRevision,
    canonical_path: String,
    name: String,
}

#[tauri::command]
pub(crate) async fn read_markdown_file(path: String) -> Result<String, NativeFileError> {
    run_blocking_file_io(move || read_markdown_file_impl(path)).await
}

fn read_markdown_file_impl(path: String) -> Result<String, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    read_markdown_contents(&canonical_path)
}

#[tauri::command]
pub(crate) async fn resolve_markdown_path(path: String) -> Result<String, NativeFileError> {
    run_blocking_file_io(move || resolve_markdown_path_impl(path)).await
}

fn resolve_markdown_path_impl(path: String) -> Result<String, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    Ok(canonical_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) async fn open_markdown_file(path: String) -> Result<OpenFileResult, NativeFileError> {
    run_blocking_file_io(move || open_markdown_file_impl(path)).await
}

pub(crate) fn open_markdown_file_impl(path: String) -> Result<OpenFileResult, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    let content = read_markdown_contents(&canonical_path)?;
    let revision = read_file_revision(&canonical_path)?;
    let (canonical_path, name) = markdown_file_identity(&canonical_path);

    Ok(OpenFileResult {
        canonical_path,
        name,
        content,
        revision,
    })
}

/// Compatibility write command retained for non-editor writes and tests.
/// Editor save flows should use `write_markdown_file_if_unmodified`.
#[tauri::command]
pub(crate) async fn write_markdown_file(
    path: String,
    content: String,
) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || write_markdown_file_impl(path, content)).await
}

fn write_markdown_file_impl(path: String, content: String) -> Result<(), NativeFileError> {
    let requested_path = PathBuf::from(&path);
    let canonical_path = canonicalize_markdown_write_path(&requested_path)?;

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    write_markdown_contents_atomic(&canonical_path, &content)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn write_markdown_file_if_unmodified(
    path: String,
    content: String,
    expected_revision: Option<FileRevision>,
    force: Option<bool>,
) -> Result<ConditionalWriteResult, NativeFileError> {
    run_blocking_file_io(move || {
        write_markdown_file_if_unmodified_impl(path, content, expected_revision, force)
    })
    .await
}

fn write_markdown_file_if_unmodified_impl(
    path: String,
    content: String,
    expected_revision: Option<FileRevision>,
    force: Option<bool>,
) -> Result<ConditionalWriteResult, NativeFileError> {
    let requested_path = PathBuf::from(&path);

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    let force_save = force.unwrap_or(false);
    if force_save {
        let write_path = resolve_markdown_write_target(&requested_path)?;
        write_markdown_contents_atomic(&write_path, &content)?;
        return successful_write_result(&write_path, &content);
    }

    let canonical_path = canonicalize_markdown_write_path(&requested_path)?;
    let current_revision = read_file_revision(&canonical_path)?;
    let expected = expected_revision.ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::CheckRevision,
            "Missing expected revision for conditional write.",
        )
    })?;
    if expected != current_revision {
        return Ok(conditional_write_result(
            &canonical_path,
            true,
            current_revision,
        ));
    }

    write_markdown_contents_atomic(&canonical_path, &content)?;
    successful_write_result(&canonical_path, &content)
}

#[tauri::command]
pub(crate) async fn open_markdown_file_externally(
    path: String,
    app: tauri::AppHandle,
) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || {
        let canonical_path = resolve_external_markdown_path_impl(path)?;
        app.opener()
            .open_path(canonical_path, None::<String>)
            .map_err(|error| {
                NativeFileError::unknown(
                    NativeFileOperation::OpenExternally,
                    "Bindars could not open the document with its default application.",
                    error.to_string(),
                )
            })
    })
    .await
}

fn resolve_external_markdown_path_impl(path: String) -> Result<String, NativeFileError> {
    let requested_path = PathBuf::from(path);
    let canonical_path = canonicalize_markdown_path(&requested_path)?;
    Ok(canonical_path.to_string_lossy().into_owned())
}

pub(crate) fn canonicalize_markdown_path(path: &Path) -> Result<PathBuf, NativeFileError> {
    let canonical_path = dunce::canonicalize(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ResolveDocument, path, error)
    })?;
    let metadata = fs::metadata(&canonical_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectDocument, &canonical_path, error)
    })?;

    if !metadata.is_file() {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "The selected document path is not a regular file.",
        ));
    }

    if !is_markdown_path(&canonical_path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Not a supported file type (.md, .markdown, or .fountain).",
        ));
    }

    Ok(canonical_path)
}

fn remap_invalid_write_target_error(error: NativeFileError) -> NativeFileError {
    if error.category == NativeFileErrorCategory::InvalidInput {
        NativeFileError {
            operation: NativeFileOperation::InspectWriteTarget,
            ..error
        }
    } else {
        error
    }
}

fn canonicalize_markdown_write_path(path: &Path) -> Result<PathBuf, NativeFileError> {
    canonicalize_markdown_path(path).map_err(remap_invalid_write_target_error)
}

fn markdown_file_identity(path: &Path) -> (String, String) {
    let canonical_path = path.to_string_lossy().into_owned();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| canonical_path.clone());
    (canonical_path, name)
}

fn conditional_write_result(
    path: &Path,
    conflict: bool,
    current_revision: FileRevision,
) -> ConditionalWriteResult {
    let (canonical_path, name) = markdown_file_identity(path);
    ConditionalWriteResult {
        conflict,
        current_revision,
        canonical_path,
        name,
    }
}

pub(crate) fn canonicalize_directory_path(
    path: &Path,
    resolve_operation: NativeFileOperation,
    inspect_operation: NativeFileOperation,
) -> Result<PathBuf, NativeFileError> {
    let canonical_path = dunce::canonicalize(path)
        .map_err(|error| NativeFileError::from_io(resolve_operation, path, error))?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|error| NativeFileError::from_io(inspect_operation, &canonical_path, error))?;

    if !metadata.is_dir() {
        return Err(NativeFileError::invalid(
            inspect_operation,
            "The selected path must be a directory.",
        ));
    }

    Ok(canonical_path)
}

fn resolve_markdown_write_target(path: &Path) -> Result<PathBuf, NativeFileError> {
    if !is_markdown_path(path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Not a supported file type (.md, .markdown, or .fountain).",
        ));
    }

    let parent = path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveWriteParent,
            "Cannot determine the destination folder.",
        )
    })?;
    let canonical_parent = canonicalize_directory_path(
        parent,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;
    let file_name = path.file_name().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Cannot determine the destination file name.",
        )
    })?;

    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return canonicalize_markdown_path(path).map_err(|error| {
                if error.category == NativeFileErrorCategory::NotFound {
                    NativeFileError::invalid(
                        NativeFileOperation::InspectWriteTarget,
                        "The selected document symlink has no available target. Choose a different Save As location.",
                    )
                } else {
                    remap_invalid_write_target_error(error)
                }
            });
        }
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::InspectWriteTarget,
                "The destination must be a regular file or a supported document symlink.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(NativeFileError::from_io(
                NativeFileOperation::InspectWriteTarget,
                path,
                error,
            ));
        }
    }

    Ok(canonical_parent.join(file_name))
}

pub(crate) fn read_markdown_contents(path: &Path) -> Result<String, NativeFileError> {
    let file = fs::File::open(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::OpenDocument, path, error)
    })?;
    let mut reader = BufReader::new(file);
    let mut buffer = Vec::new();

    reader
        .by_ref()
        .take(MAX_MARKDOWN_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::ReadDocument, path, error)
        })?;

    if buffer.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "File is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    String::from_utf8(buffer).map_err(|_| {
        NativeFileError::invalid(
            NativeFileOperation::DecodeDocument,
            "File must be valid UTF-8 text.",
        )
    })
}

fn modified_time_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn stable_hash_hex(bytes: &[u8]) -> String {
    // Stable FNV-1a provides deterministic, non-security-sensitive identifiers.
    // Snapshot keys are paired with source identity, and snapshot dedupe compares bytes.
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

fn read_file_revision(path: &Path) -> Result<FileRevision, NativeFileError> {
    let metadata = fs::metadata(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::CheckRevision, path, error)
    })?;
    let bytes = fs::read(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::CheckRevision, path, error)
    })?;

    if bytes.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            format!(
                "File is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    Ok(FileRevision {
        mtime_ms: modified_time_ms(&metadata),
        size: bytes.len() as u64,
        content_hash: stable_hash_hex(&bytes),
    })
}

fn read_written_file_revision(path: &Path, content: &str) -> Result<FileRevision, NativeFileError> {
    let metadata = fs::metadata(path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectSavedDocument, path, error)
    })?;

    // The size and hash intentionally describe the exact snapshot Bindars wrote.
    // If another process replaces the file before this metadata read, the hybrid
    // revision will not bless those external bytes on the next conditional save.
    Ok(FileRevision {
        mtime_ms: modified_time_ms(&metadata),
        size: content.len() as u64,
        content_hash: stable_hash_hex(content.as_bytes()),
    })
}

fn successful_write_result(
    path: &Path,
    content: &str,
) -> Result<ConditionalWriteResult, NativeFileError> {
    let revision = read_written_file_revision(path, content)?;
    Ok(conditional_write_result(path, false, revision))
}

fn write_markdown_contents_atomic(path: &Path, content: &str) -> Result<(), NativeFileError> {
    write_contents_atomic(
        path,
        content,
        ".bindars-tmp",
        NativeFileOperation::SaveDocument,
    )
}

pub(crate) fn is_markdown_path(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => {
            ext.eq_ignore_ascii_case("md")
                || ext.eq_ignore_ascii_case("markdown")
                || ext.eq_ignore_ascii_case("fountain")
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{cleanup_temp_path, unique_temp_dir, unique_temp_path};
    use std::fs::File;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

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

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
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
            open_markdown_file_impl(link.to_string_lossy().into_owned()).expect("open markdown");

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

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
        assert_eq!(
            result.expect("read fountain"),
            "INT. OFFICE - DAY\n\nSARAH\nHello world."
        );

        cleanup(&path);
    }

    #[test]
    fn rejects_missing_markdown_file() {
        let path = temp_path("md");
        let error = read_markdown_file_impl(path.to_string_lossy().into_owned())
            .expect_err("missing file should error");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);
        assert_eq!(error.message, "This file is no longer available.");
    }

    #[test]
    fn rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn open_markdown_file_rejects_non_markdown_file() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = open_markdown_file_impl(path.to_string_lossy().into_owned());
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

        let error = read_markdown_file_impl(path.to_string_lossy().into_owned())
            .expect_err("oversized file should error");
        assert!(
            error.contains("File is too large"),
            "unexpected error for {}: {error}",
            path.display()
        );

        cleanup(&path);
    }

    #[test]
    fn rejects_non_utf8_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, [0xFF_u8, 0xFE_u8, 0xFD_u8]).expect("write non-utf8 fixture");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());
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

        let result = read_markdown_file_impl(link.to_string_lossy().into_owned());
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

        let result = read_markdown_file_impl(link.to_string_lossy().into_owned());
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
            resolve_markdown_path_impl(link.to_string_lossy().into_owned()).expect("resolve path");
        assert_eq!(
            PathBuf::from(resolved),
            fs::canonicalize(&target).expect("canonical target")
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn external_open_resolves_supported_markdown_files() {
        let path = temp_path("md");
        fs::write(&path, "# Open externally").expect("write fixture");

        let resolved = resolve_external_markdown_path_impl(path.to_string_lossy().into_owned())
            .expect("resolve external-open path");

        assert_eq!(
            PathBuf::from(resolved),
            dunce::canonicalize(&path).expect("canonical fixture")
        );

        cleanup(&path);
    }

    #[test]
    fn external_open_rejects_non_markdown_files() {
        let path = temp_path("txt");
        fs::write(&path, "plain text").expect("write fixture");

        let result = resolve_external_markdown_path_impl(path.to_string_lossy().into_owned());

        assert!(result
            .expect_err("external open should reject non-markdown files")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn writes_to_existing_markdown_file() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");

        let result = write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Updated\n\nNew content".to_string(),
        );
        assert!(result.is_ok());

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# Updated\n\nNew content");

        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_markdown_write_preserves_existing_unix_permissions() {
        let path = temp_path("md");
        fs::write(&path, "# Private").expect("write fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640))
            .expect("set fixture permissions");

        write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Still private".to_string(),
        )
        .expect("write markdown");

        let mode = fs::metadata(&path)
            .expect("inspect written file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);

        cleanup(&path);
    }

    #[test]
    fn conditional_write_succeeds_with_matching_revision() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        let result = write_markdown_file_if_unmodified_impl(
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

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::write(&path, "# External change").expect("simulate external write");

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Local edit".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect("conditional write conflict");
        assert!(result.conflict);
        assert_eq!(
            PathBuf::from(&result.canonical_path),
            dunce::canonicalize(&path).expect("canonical fixture")
        );
        assert_eq!(
            result.name,
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
        );

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "# External change");

        cleanup(&path);
    }

    #[test]
    fn conditional_write_force_overwrites_after_conflict() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::write(&path, "# External change").expect("simulate external write");

        let result = write_markdown_file_if_unmodified_impl(
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

    #[cfg(unix)]
    #[test]
    fn forced_write_through_supported_symlink_preserves_link() {
        let target = temp_path("md");
        let link = temp_path("md");
        fs::write(&target, "# Original").expect("write target fixture");
        symlink(&target, &link).expect("create supported symlink");

        write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "# Updated".to_string(),
            None,
            Some(true),
        )
        .expect("forced write should follow supported symlink");

        assert!(fs::symlink_metadata(&link)
            .expect("inspect link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).expect("read target"),
            "# Updated"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_rejects_supported_symlink_to_unsupported_target() {
        let target = temp_path("txt");
        let link = temp_path("md");
        fs::write(&target, "outside type").expect("write unsupported target");
        symlink(&target, &link).expect("create supported-looking symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "must not write".to_string(),
            None,
            Some(true),
        )
        .expect_err("forced write must validate the symlink target");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert!(error.contains("Not a supported file type"));
        assert!(fs::symlink_metadata(&link)
            .expect("inspect link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).expect("read target"),
            "outside type"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_rejects_dangling_document_symlink_without_replacing_it() {
        let missing_target = temp_path("md");
        let link = temp_path("md");
        symlink(&missing_target, &link).expect("create dangling symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "must not replace link".to_string(),
            None,
            Some(true),
        )
        .expect_err("dangling symlink should require another Save As destination");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect dangling link")
            .file_type()
            .is_symlink());
        assert!(!missing_target.exists());

        cleanup(&link);
        cleanup(&missing_target);
    }

    #[cfg(unix)]
    #[test]
    fn forced_write_reports_a_symlinked_directory_as_an_invalid_write_target() {
        let root = temp_dir("symlinked-document-directory");
        fs::create_dir(&root).expect("create fixture root");
        let target = root.join("target.md");
        let link = root.join("link.md");
        fs::create_dir(&target).expect("create target directory");
        symlink(&target, &link).expect("create directory symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "must not replace link".to_string(),
            None,
            Some(true),
        )
        .expect_err("symlinked directory should require another Save As destination");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect directory link")
            .file_type()
            .is_symlink());
        assert!(target.is_dir());

        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn conditional_write_reports_a_replaced_directory_symlink_as_an_invalid_write_target() {
        let root = temp_dir("conditional-symlinked-document-directory");
        fs::create_dir(&root).expect("create fixture root");
        let link = root.join("document.md");
        let directory = root.join("replacement.md");
        fs::write(&link, "original").expect("write original document");
        let opened = open_markdown_file_impl(link.to_string_lossy().into_owned())
            .expect("open original document");
        fs::remove_file(&link).expect("remove original document");
        fs::create_dir(&directory).expect("create replacement directory");
        symlink(&directory, &link).expect("replace document with directory symlink");

        let error = write_markdown_file_if_unmodified_impl(
            link.to_string_lossy().into_owned(),
            "local edits must survive".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect_err("directory symlink should require Save As recovery");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect replacement link")
            .file_type()
            .is_symlink());
        assert!(directory.is_dir());

        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_existing_read_only_target_before_replacement() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444))
            .expect("make fixture read-only");

        let error = write_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Must remain".to_string(),
        )
        .expect_err("read-only target should be refused");

        assert!(error.contains("read-only"));
        assert_eq!(error.category, NativeFileErrorCategory::ReadOnly);
        assert_eq!(error.operation, NativeFileOperation::SaveDocument);
        assert_eq!(
            fs::read_to_string(&path).expect("read unchanged file"),
            "# Original"
        );
        let temporary_files = fs::read_dir(path.parent().expect("fixture parent"))
            .expect("list fixture parent")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bindars-tmp")
            })
            .count();
        assert_eq!(temporary_files, 0);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
            .expect("restore fixture permissions");
        cleanup(&path);
    }

    #[test]
    fn concurrent_writes_to_distinct_files_in_one_directory_do_not_collide() {
        let root = temp_dir("atomic-concurrent-destinations");
        fs::create_dir(&root).expect("create fixture root");
        let mut threads = Vec::new();

        for index in 0..16 {
            let path = root.join(format!("document-{index}.md"));
            fs::write(&path, "initial").expect("write concurrent fixture");
            threads.push(std::thread::spawn(move || {
                write_markdown_file_impl(
                    path.to_string_lossy().into_owned(),
                    format!("updated-{index}"),
                )
            }));
        }

        for thread in threads {
            thread
                .join()
                .expect("write thread should not panic")
                .expect("concurrent write should succeed");
        }
        for index in 0..16 {
            assert_eq!(
                fs::read_to_string(root.join(format!("document-{index}.md")))
                    .expect("read concurrent result"),
                format!("updated-{index}")
            );
        }
        assert_eq!(
            fs::read_dir(&root)
                .expect("list fixture root")
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bindars-tmp"))
                .count(),
            0
        );

        cleanup_dir(&root);
    }

    #[test]
    fn write_preserves_decomposed_unicode_filename_identity() {
        let root = temp_dir("atomic-nfd-name");
        fs::create_dir(&root).expect("create fixture root");
        let path = root.join("Cafe\u{301}.md");
        fs::write(&path, "initial").expect("write NFD fixture");

        let result = write_markdown_file_if_unmodified_impl(
            path.to_string_lossy().into_owned(),
            "updated".to_string(),
            None,
            Some(true),
        )
        .expect("write NFD document");

        assert_eq!(
            fs::read_to_string(&path).expect("read NFD result"),
            "updated"
        );
        assert_eq!(
            PathBuf::from(result.canonical_path),
            dunce::canonicalize(&path).expect("canonical NFD path")
        );

        cleanup_dir(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn force_create_reports_unwritable_parent_without_leaving_a_temporary_file() {
        let root = temp_dir("atomic-unwritable-parent");
        fs::create_dir(&root).expect("create fixture root");
        let path = root.join("new.md");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555))
            .expect("make parent unwritable");

        let result = write_markdown_file_if_unmodified_impl(
            path.to_string_lossy().into_owned(),
            "new content".to_string(),
            None,
            Some(true),
        );

        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))
            .expect("restore parent permissions");
        let error = result.expect_err("unwritable parent should reject the save");
        assert_eq!(error.category, NativeFileErrorCategory::PermissionDenied);
        assert_eq!(error.operation, NativeFileOperation::CreateTemporaryFile);
        assert!(!path.exists());
        assert_eq!(
            fs::read_dir(&root)
                .expect("list fixture root")
                .filter_map(Result::ok)
                .count(),
            0
        );

        cleanup_dir(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn inaccessible_ancestor_reports_permission_denied_instead_of_missing() {
        let root = temp_dir("inaccessible-document-ancestor");
        fs::create_dir(&root).expect("create fixture root");
        let path = root.join("document.md");
        fs::write(&path, "content").expect("write fixture document");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o000))
            .expect("make ancestor inaccessible");

        let result = read_markdown_file_impl(path.to_string_lossy().into_owned());

        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))
            .expect("restore ancestor permissions");
        let error = result.expect_err("inaccessible ancestor should reject the read");
        assert_eq!(error.category, NativeFileErrorCategory::PermissionDenied);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);

        cleanup_dir(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn case_variant_path_characterizes_the_host_volume_without_folding_in_bindars() {
        let root = temp_dir("case-variant-path");
        fs::create_dir(&root).expect("create fixture root");
        let exact = root.join("CaseIdentity.md");
        let variant = root.join("caseidentity.md");
        fs::write(&exact, "content").expect("write case fixture");
        let exact_canonical = dunce::canonicalize(&exact).expect("canonical exact path");

        match dunce::canonicalize(&variant) {
            Ok(variant_canonical) => assert_eq!(variant_canonical, exact_canonical),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        }

        cleanup_dir(&root);
    }

    #[test]
    fn conditional_write_non_force_errors_when_file_was_deleted() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::remove_file(&path).expect("delete fixture");

        let error = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Local edit".to_string(),
            Some(opened.revision),
            Some(false),
        )
        .expect_err("non-force write should fail for deleted file");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);
        assert_eq!(error.message, "This file is no longer available.");
    }

    #[test]
    fn conditional_write_force_recreates_deleted_file() {
        let path = temp_path("md");
        fs::write(&path, "# Original").expect("write fixture");
        let path_str = path.to_string_lossy().into_owned();

        let opened = open_markdown_file_impl(path_str.clone()).expect("open markdown");
        fs::remove_file(&path).expect("delete fixture");

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Forced recreate".to_string(),
            Some(opened.revision),
            Some(true),
        )
        .expect("forced write should recreate file");

        assert!(!result.conflict);
        assert_eq!(
            fs::read_to_string(&path).expect("read recreated file"),
            "# Forced recreate"
        );

        cleanup(&path);
    }

    #[test]
    fn conditional_write_force_creates_missing_markdown_file() {
        let path = temp_path("md");
        let path_str = path.to_string_lossy().into_owned();

        let result = write_markdown_file_if_unmodified_impl(
            path_str,
            "# Created".to_string(),
            None,
            Some(true),
        )
        .expect("forced write should create missing markdown file");

        assert!(!result.conflict);
        assert_eq!(
            PathBuf::from(&result.canonical_path),
            dunce::canonicalize(&path).expect("canonical created file")
        );
        assert_eq!(
            result.name,
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
        );
        assert_eq!(result.current_revision.size, "# Created".len() as u64);
        assert_eq!(
            result.current_revision.content_hash,
            stable_hash_hex(b"# Created")
        );
        assert_eq!(
            fs::read_to_string(&path).expect("read created file"),
            "# Created"
        );

        cleanup(&path);
    }

    #[test]
    fn written_revision_keeps_the_saved_snapshot_identity_after_external_replacement() {
        let path = temp_path("md");
        fs::write(&path, "external bytes").expect("write external fixture");

        let revision = read_written_file_revision(&path, "Bindars snapshot")
            .expect("read snapshot-bound revision");

        assert_eq!(revision.size, "Bindars snapshot".len() as u64);
        assert_eq!(revision.content_hash, stable_hash_hex(b"Bindars snapshot"));
        assert_ne!(
            revision,
            read_file_revision(&path).expect("read external revision")
        );

        cleanup(&path);
    }

    #[test]
    fn writes_to_existing_fountain_file() {
        let path = temp_path("fountain");
        fs::write(&path, "INT. ROOM - DAY").expect("write fixture");

        let result = write_markdown_file_impl(
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

        let result =
            write_markdown_file_impl(path.to_string_lossy().into_owned(), "new".to_string());
        assert!(result
            .expect_err("non-markdown should error")
            .contains("Not a supported file type"));

        cleanup(&path);
    }

    #[test]
    fn write_rejects_nonexistent_file() {
        let path = temp_path("md");
        let error =
            write_markdown_file_impl(path.to_string_lossy().into_owned(), "new".to_string())
                .expect_err("missing file should error");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveDocument);
        assert_eq!(error.message, "This file is no longer available.");
    }

    #[test]
    fn write_rejects_oversized_content() {
        let path = temp_path("md");
        fs::write(&path, "# Placeholder").expect("write fixture");

        let oversized = "x".repeat((MAX_MARKDOWN_BYTES + 1) as usize);
        let result = write_markdown_file_impl(path.to_string_lossy().into_owned(), oversized);
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

        let result =
            write_markdown_file_impl(link.to_string_lossy().into_owned(), "new".to_string());
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
        write_markdown_file_impl(path.to_string_lossy().into_owned(), unicode.to_string())
            .expect("write Unicode and whitespace");

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, unicode);

        cleanup(&path);
    }

    fn temp_path(ext: &str) -> PathBuf {
        unique_temp_path(ext)
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        unique_temp_dir(prefix)
    }

    fn cleanup(path: &Path) {
        cleanup_temp_path(path);
    }

    fn cleanup_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }
}
