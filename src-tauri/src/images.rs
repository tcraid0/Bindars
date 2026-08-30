use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::path::{Path, PathBuf};

use crate::document_io::canonicalize_markdown_path;
use crate::file_errors::{run_blocking_file_io, NativeFileError, NativeFileOperation};

const MAX_EXPORT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_EXPORT_IMAGE_SIZE_MIB: u64 = MAX_EXPORT_IMAGE_BYTES / (1024 * 1024);

#[tauri::command]
pub(crate) async fn read_image_file_as_base64(
    path: String,
    document_path: String,
) -> Result<String, NativeFileError> {
    run_blocking_file_io(move || read_image_file_as_base64_impl(path, document_path)).await
}

fn read_image_file_as_base64_impl(
    path: String,
    document_path: String,
) -> Result<String, NativeFileError> {
    // Both paths come from the WebView, so this narrows file access as defense
    // in depth; it is not an authorization boundary by itself.
    let requested_document_path = PathBuf::from(document_path);
    let canonical_document_path = canonicalize_markdown_path(&requested_document_path)?;
    let document_directory = canonical_document_path.parent().ok_or_else(|| {
        NativeFileError::invalid(
            NativeFileOperation::ResolveImage,
            "Cannot determine the document folder.",
        )
    })?;

    let requested_path = PathBuf::from(&path);
    let canonical_path = dunce::canonicalize(&requested_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ResolveImage, &requested_path, error)
    })?;
    let metadata = fs::metadata(&canonical_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::InspectImage, &canonical_path, error)
    })?;

    if !metadata.is_file() {
        return Err(NativeFileError::invalid(
            NativeFileOperation::InspectImage,
            "Path is not a file.",
        ));
    }

    if !canonical_path.starts_with(document_directory) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateImage,
            "Image must be inside the open document's folder.",
        ));
    }

    if !is_supported_export_image_path(&canonical_path) {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateImage,
            "Not a supported image type.",
        ));
    }

    if metadata.len() > MAX_EXPORT_IMAGE_BYTES {
        return Err(NativeFileError::invalid(
            NativeFileOperation::ValidateImage,
            format!(
                "Image is too large. Maximum supported size is {} MiB.",
                MAX_EXPORT_IMAGE_SIZE_MIB
            ),
        ));
    }

    let bytes = fs::read(&canonical_path).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ReadImage, &canonical_path, error)
    })?;
    Ok(STANDARD.encode(bytes))
}

fn is_supported_export_image_path(path: &Path) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
        ),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{read_image_file_as_base64_impl, MAX_EXPORT_IMAGE_BYTES, STANDARD};
    use crate::file_errors::{NativeFileErrorCategory, NativeFileOperation};
    use crate::test_support::{cleanup_temp_path, unique_temp_dir, unique_temp_path};
    use base64::Engine;
    use std::fs::{self, File};
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};

    #[test]
    fn read_image_file_as_base64_reads_supported_image() {
        let root = temp_dir("image-read");
        let image_dir = root.join("images");
        fs::create_dir_all(&image_dir).expect("create image directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = image_dir.join("fixture.png");
        let bytes = [0_u8, 1_u8, 2_u8, 3_u8];
        fs::write(&path, bytes).expect("write image fixture");

        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        )
        .expect("read image");

        assert_eq!(result, STANDARD.encode(bytes));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_missing_file() {
        let root = temp_dir("image-missing");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("missing.png");
        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        let error = result.expect_err("missing image should error");
        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(error.operation, NativeFileOperation::ResolveImage);

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_directory() {
        let root = temp_dir("image-directory");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("image-dir");
        fs::create_dir_all(&path).expect("create directory fixture");
        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("directory should error")
            .contains("Path is not a file"));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_unsupported_extension() {
        let root = temp_dir("image-extension");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("fixture.txt");
        fs::write(&path, "not an image").expect("write fixture");

        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("unsupported image extension should error")
            .contains("Not a supported image type"));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_oversized_image() {
        let root = temp_dir("image-oversized");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let path = root.join("fixture.png");
        let file = File::create(&path).expect("create fixture");
        file.set_len(MAX_EXPORT_IMAGE_BYTES + 1)
            .expect("expand fixture");

        let result = read_image_file_as_base64_impl(
            path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("oversized image should error")
            .contains("Image is too large"));

        cleanup_dir(&root);
    }

    #[test]
    fn read_image_file_as_base64_rejects_image_outside_document_folder() {
        let root = temp_dir("image-boundary");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let outside_path = temp_path("png");
        fs::write(&outside_path, [0_u8, 1_u8]).expect("write outside image");

        let result = read_image_file_as_base64_impl(
            outside_path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("outside image should be rejected")
            .contains("inside the open document's folder"));

        cleanup(&outside_path);
        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn read_image_file_as_base64_rejects_symlink_escape() {
        let root = temp_dir("image-symlink-boundary");
        fs::create_dir_all(&root).expect("create fixture directory");
        let document_path = root.join("document.md");
        fs::write(&document_path, "# Document").expect("write document fixture");
        let outside_path = temp_path("png");
        fs::write(&outside_path, [0_u8, 1_u8]).expect("write outside image");
        let link_path = root.join("linked.png");
        symlink(&outside_path, &link_path).expect("create image symlink");

        let result = read_image_file_as_base64_impl(
            link_path.to_string_lossy().into_owned(),
            document_path.to_string_lossy().into_owned(),
        );

        assert!(result
            .expect_err("symlink escape should be rejected")
            .contains("inside the open document's folder"));

        cleanup(&outside_path);
        cleanup_dir(&root);
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
