use std::path::PathBuf;

use crate::atomic_write::write_contents_atomic;
use crate::document_io::{canonicalize_directory_path, MAX_MARKDOWN_BYTES, MAX_MARKDOWN_SIZE_MIB};
use crate::file_errors::{run_blocking_file_io, NativeFileError, NativeFileOperation};

const MAX_EXPORT_HTML_BYTES: u64 = 30 * 1024 * 1024;
const MAX_EXPORT_HTML_SIZE_MIB: u64 = MAX_EXPORT_HTML_BYTES / (1024 * 1024);

#[tauri::command]
pub(crate) async fn export_html_file(path: String, content: String) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || export_html_file_impl(path, content)).await
}

fn export_html_file_impl(path: String, content: String) -> Result<(), NativeFileError> {
    let requested_path = PathBuf::from(&path);

    // Only allow .html extension for export
    match requested_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm") => {}
        _ => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::ExportFile,
                "Export file must have .html or .htm extension.",
            ));
        }
    }

    if content.len() as u64 > MAX_EXPORT_HTML_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ExportFile,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_EXPORT_HTML_SIZE_MIB
            ),
        ));
    }

    // Resolve parent directory to ensure it exists
    let parent = requested_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveWriteParent,
            "Cannot determine the destination folder.",
        )
    })?;
    canonicalize_directory_path(
        parent,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;

    write_contents_atomic(
        &requested_path,
        &content,
        ".bindars-export",
        NativeFileOperation::ExportFile,
    )
}

#[tauri::command]
pub(crate) async fn export_markdown_file(
    path: String,
    content: String,
) -> Result<(), NativeFileError> {
    run_blocking_file_io(move || export_markdown_file_impl(path, content)).await
}

fn export_markdown_file_impl(path: String, content: String) -> Result<(), NativeFileError> {
    let requested_path = PathBuf::from(&path);

    // Only allow .md/.markdown extension for export
    match requested_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown") => {}
        _ => {
            return Err(NativeFileError::invalid(
                NativeFileOperation::ExportFile,
                "Export file must have .md or .markdown extension.",
            ));
        }
    }

    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ExportFile,
            format!(
                "Content is too large. Maximum supported size is {} MiB.",
                MAX_MARKDOWN_SIZE_MIB
            ),
        ));
    }

    // Resolve parent directory to ensure it exists
    let parent = requested_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveWriteParent,
            "Cannot determine the destination folder.",
        )
    })?;
    canonicalize_directory_path(
        parent,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;

    write_contents_atomic(
        &requested_path,
        &content,
        ".bindars-export-md",
        NativeFileOperation::ExportFile,
    )
}

#[cfg(test)]
mod tests {
    use super::{export_html_file_impl, export_markdown_file_impl, MAX_EXPORT_HTML_BYTES};
    use crate::document_io::MAX_MARKDOWN_BYTES;
    use crate::file_errors::{NativeFileErrorCategory, NativeFileOperation};
    use crate::test_support::{cleanup_temp_path, unique_temp_path};
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};

    #[test]
    fn export_markdown_accepts_md_extension() {
        let path = temp_path("md");
        let result = export_markdown_file_impl(
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
        let result = export_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Annotations\n".to_string(),
        );
        assert!(result.is_ok());
        cleanup(&path);
    }

    #[test]
    fn export_markdown_overwrites_existing_file() {
        let path = temp_path("md");
        fs::write(&path, "old content").expect("write existing export");

        let result = export_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "new content".to_string(),
        );

        assert!(result.is_ok());
        assert_eq!(
            fs::read_to_string(&path).expect("read overwritten export"),
            "new content"
        );
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_a_symlink_destination_without_replacing_it() {
        let target = temp_path("html");
        let link = temp_path("html");
        fs::write(&target, "original target").expect("write export target");
        symlink(&target, &link).expect("create export symlink");

        let error = export_html_file_impl(
            link.to_string_lossy().into_owned(),
            "<p>replacement</p>".to_string(),
        )
        .expect_err("export should reject a symlink destination");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(error.operation, NativeFileOperation::InspectWriteTarget);
        assert!(fs::symlink_metadata(&link)
            .expect("inspect export link")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(&target).expect("read unchanged export target"),
            "original target"
        );

        cleanup(&link);
        cleanup(&target);
    }

    #[test]
    fn export_markdown_rejects_html_extension() {
        let path = temp_path("html");
        let result =
            export_markdown_file_impl(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("html extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
    }

    #[test]
    fn export_markdown_rejects_txt_extension() {
        let path = temp_path("txt");
        let result =
            export_markdown_file_impl(path.to_string_lossy().into_owned(), "content".to_string());
        assert!(result
            .expect_err("txt extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
    }

    #[test]
    fn export_markdown_rejects_fountain_extension() {
        let path = temp_path("fountain");
        let result = export_markdown_file_impl(
            path.to_string_lossy().into_owned(),
            "# Annotations\n".to_string(),
        );
        assert!(result
            .expect_err("fountain extension should be rejected")
            .contains("Export file must have .md or .markdown extension"));
        assert!(!path.exists(), "no destination file should be created");
        cleanup(&path);
    }

    #[test]
    fn export_markdown_rejects_oversized_content() {
        let path = temp_path("md");
        let oversized = "x".repeat((MAX_MARKDOWN_BYTES + 1) as usize);
        let result = export_markdown_file_impl(path.to_string_lossy().into_owned(), oversized);
        assert!(result
            .expect_err("oversized content should error")
            .contains("too large"));
    }

    #[test]
    fn export_markdown_rejects_nonexistent_parent() {
        let path = PathBuf::from("/nonexistent-dir-bindars-test/annotations.md");
        let result =
            export_markdown_file_impl(path.to_string_lossy().into_owned(), "content".to_string());
        let error = result.expect_err("missing parent should error");
        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveWriteParent);
    }

    #[test]
    fn export_html_accepts_html_extension() {
        let path = temp_path("html");
        let result = export_html_file_impl(
            path.to_string_lossy().into_owned(),
            "<p>export</p>".to_string(),
        );
        assert!(result.is_ok());

        let content = fs::read_to_string(&path).expect("read back");
        assert_eq!(content, "<p>export</p>");

        cleanup(&path);
    }

    #[test]
    fn export_html_rejects_non_html_extension() {
        let path = temp_path("md");
        let result = export_html_file_impl(
            path.to_string_lossy().into_owned(),
            "<p>export</p>".to_string(),
        );
        assert!(result
            .expect_err("non-html extension should be rejected")
            .contains("Export file must have .html or .htm extension"));
    }

    #[test]
    fn export_html_rejects_oversized_content() {
        let path = temp_path("html");
        let oversized = "x".repeat((MAX_EXPORT_HTML_BYTES + 1) as usize);
        let result = export_html_file_impl(path.to_string_lossy().into_owned(), oversized);
        assert!(result
            .expect_err("oversized html should error")
            .contains("too large"));
    }

    fn temp_path(ext: &str) -> PathBuf {
        unique_temp_path(ext)
    }

    fn cleanup(path: &Path) {
        cleanup_temp_path(path);
    }
}
