use cap_fs_ext::MetadataExt;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::document_io::{
    canonicalize_directory_path, canonicalize_markdown_path, is_markdown_path,
    reject_oversized_markdown, write_new_markdown_file, ConditionalWriteResult, NewMarkdownFile,
};
use crate::file_errors::{
    run_blocking_file_io, NativeFileError, NativeFileErrorCategory, NativeFileOperation,
};

const DRAFTS_DIR_NAME: &str = "Bindars Drafts";

fn drafts_dir(app: &AppHandle) -> Result<PathBuf, NativeFileError> {
    app.path()
        .document_dir()
        .map(|dir| dir.join(DRAFTS_DIR_NAME))
        .map_err(|error| {
            NativeFileError::unknown(
                NativeFileOperation::ResolveWriteParent,
                "Bindars could not locate the Documents folder. Choose a location with Save As.",
                error.to_string(),
            )
        })
}

fn create_draft_in(
    dir: &Path,
    stem: &str,
    content: &str,
    annotated: &HashSet<String>,
) -> Result<ConditionalWriteResult, NativeFileError> {
    // Reject before creating the folder, so an oversized document leaves no directory.
    reject_oversized_markdown(content)?;

    fs::create_dir_all(dir).map_err(|error| {
        NativeFileError::from_io(NativeFileOperation::ResolveWriteParent, dir, error)
    })?;
    let canonical_dir = canonicalize_directory_path(
        dir,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    )?;

    for number in 1..=999 {
        let name = if number == 1 {
            format!("{stem}.md")
        } else {
            format!("{stem} {number}.md")
        };
        let path = canonical_dir.join(name);
        // A vacated name can still own notes from an earlier draft.
        if annotated.contains(path.to_string_lossy().as_ref()) {
            continue;
        }
        match write_new_markdown_file(&path, content)? {
            NewMarkdownFile::AlreadyExists => continue,
            NewMarkdownFile::Written(result) => return Ok(result),
        }
    }

    Err(NativeFileError::invalid(
        NativeFileOperation::SaveDocument,
        "Too many untitled drafts. Rename or move a draft, then try again.",
    ))
}

fn is_draft_in(dir: &Path, path: &Path) -> bool {
    let Ok(canonical_path) = canonicalize_markdown_path(path) else {
        return false;
    };
    // Do not probe Documents when opening a file in an unrelated folder. The
    // name is compared without case because a case-insensitive volume reuses
    // an existing folder spelled differently; directory identity decides below.
    let parent_name = canonical_path.parent().and_then(Path::file_name);
    if !parent_name
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(DRAFTS_DIR_NAME))
    {
        return false;
    }
    let Ok(canonical_dir) = canonicalize_directory_path(
        dir,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    ) else {
        return false;
    };
    canonical_path.parent() == Some(canonical_dir.as_path())
}

fn delete_draft_in(dir: &Path, path: &Path, saved_path: &Path) -> Result<bool, NativeFileError> {
    let outside_drafts = || {
        NativeFileError::invalid(
            NativeFileOperation::ValidateDocument,
            "Only supported documents directly inside the Drafts folder can be removed.",
        )
    };
    let canonical_dir = match canonicalize_directory_path(
        dir,
        NativeFileOperation::ResolveWriteParent,
        NativeFileOperation::InspectWriteParent,
    ) {
        Ok(dir) => dir,
        Err(error) if error.category == NativeFileErrorCategory::NotFound => {
            // Removing an already absent draft must not recreate its folder.
            return if path.parent() == Some(dir) && is_markdown_path(path) {
                Ok(false)
            } else {
                Err(outside_drafts())
            };
        }
        Err(error) => return Err(error),
    };
    let canonical_path = match canonicalize_markdown_path(path) {
        Ok(path) => path,
        Err(error) if error.category == NativeFileErrorCategory::NotFound => {
            let parent = path.parent().ok_or_else(outside_drafts)?;
            let canonical_parent = canonicalize_directory_path(
                parent,
                NativeFileOperation::ResolveWriteParent,
                NativeFileOperation::InspectWriteParent,
            )?;
            return if canonical_parent == canonical_dir && is_markdown_path(path) {
                Ok(false)
            } else {
                Err(outside_drafts())
            };
        }
        Err(error) => return Err(error),
    };
    if canonical_path.parent() != Some(canonical_dir.as_path()) {
        return Err(outside_drafts());
    }

    let canonical_saved_path = canonicalize_markdown_path(saved_path)?;
    if canonical_path == canonical_saved_path {
        return Ok(false);
    }
    let open_for_comparison = |path: &Path| {
        fs::File::open(path).map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::InspectSavedDocument, path, error)
        })
    };
    let draft_file = open_for_comparison(&canonical_path)?;
    let saved_file = open_for_comparison(&canonical_saved_path)?;
    let metadata_for_comparison = |file: &fs::File, path: &Path| {
        cap_std::fs::Metadata::from_file(file).map_err(|error| {
            NativeFileError::from_io(NativeFileOperation::InspectSavedDocument, path, error)
        })
    };
    let draft_metadata = metadata_for_comparison(&draft_file, &canonical_path)?;
    let saved_metadata = metadata_for_comparison(&saved_file, &canonical_saved_path)?;
    // Canonical paths catch spelling and symlink aliases; file identity catches hard links.
    if draft_metadata.dev() == saved_metadata.dev() && draft_metadata.ino() == saved_metadata.ino()
    {
        return Ok(false);
    }

    match fs::remove_file(&canonical_path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(NativeFileError::from_io(
            NativeFileOperation::SaveDocument,
            &canonical_path,
            error,
        )),
    }
}

#[tauri::command]
pub(crate) async fn create_draft_document(
    app: AppHandle,
    content: String,
) -> Result<ConditionalWriteResult, NativeFileError> {
    let annotated = crate::annotations::annotated_paths(app.clone()).await?;
    run_blocking_file_io(move || {
        create_draft_in(&drafts_dir(&app)?, "Untitled", &content, &annotated)
    })
    .await
}

#[tauri::command]
pub(crate) async fn is_draft_document(app: AppHandle, path: String) -> bool {
    run_blocking_file_io(move || Ok(is_draft_in(&drafts_dir(&app)?, Path::new(&path))))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub(crate) async fn delete_draft_document(
    app: AppHandle,
    path: String,
    saved_path: String,
) -> Result<bool, NativeFileError> {
    run_blocking_file_io(move || {
        delete_draft_in(&drafts_dir(&app)?, Path::new(&path), Path::new(&saved_path))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::document_io::write_markdown_contents_atomic;
    #[cfg(target_os = "macos")]
    use crate::document_io::write_markdown_file_if_unmodified;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    use crate::document_io::write_reserved_markdown;
    use crate::document_io::{open_markdown_file_impl, MAX_MARKDOWN_BYTES};
    use crate::test_support::{cleanup_temp_path, unique_temp_path};
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
    use std::fs::OpenOptions;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
    use std::os::unix::fs::PermissionsExt;

    fn temp_drafts_dir() -> PathBuf {
        unique_temp_path("drafts").with_file_name(DRAFTS_DIR_NAME)
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
        cleanup_temp_path(dir);
    }

    #[test]
    fn creates_drafts_directory_and_numbers_without_overwriting() {
        let dir = temp_drafts_dir();
        assert!(!dir.exists());

        create_draft_in(&dir, "Untitled", "first document", &HashSet::new())
            .expect("create first draft");
        create_draft_in(&dir, "Untitled", "second document", &HashSet::new())
            .expect("create second draft");

        assert_eq!(
            fs::read_to_string(dir.join("Untitled.md")).unwrap(),
            "first document"
        );
        assert_eq!(
            fs::read_to_string(dir.join("Untitled 2.md")).unwrap(),
            "second document"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        cleanup(&dir);
    }

    #[test]
    fn skips_vacated_names_that_still_have_annotations() {
        let dir = temp_drafts_dir();
        fs::create_dir(&dir).unwrap();
        let canonical_dir = dunce::canonicalize(&dir).unwrap();
        let annotated = HashSet::from([canonical_dir
            .join("Untitled.md")
            .to_string_lossy()
            .into_owned()]);

        let created = create_draft_in(&dir, "Untitled", "new draft", &annotated).unwrap();

        assert_eq!(
            serde_json::to_value(&created).unwrap()["canonicalPath"],
            canonical_dir
                .join("Untitled 2.md")
                .to_string_lossy()
                .as_ref()
        );
        assert!(!dir.join("Untitled.md").exists());
        cleanup(&dir);
    }

    #[test]
    fn skips_existing_files_and_directories() {
        let dir = temp_drafts_dir();
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("Untitled.md"), "keep this document").unwrap();
        fs::create_dir(dir.join("Untitled 2.md")).unwrap();

        create_draft_in(&dir, "Untitled", "new draft", &HashSet::new())
            .expect("find unused draft name");

        assert_eq!(
            fs::read_to_string(dir.join("Untitled.md")).unwrap(),
            "keep this document"
        );
        assert_eq!(
            fs::read_to_string(dir.join("Untitled 3.md")).unwrap(),
            "new draft"
        );
        cleanup(&dir);
    }

    #[test]
    fn rejects_oversize_content_before_creating_directory() {
        let dir = temp_drafts_dir();
        let error = create_draft_in(
            &dir,
            "Untitled",
            &"x".repeat(MAX_MARKDOWN_BYTES as usize + 1),
            &HashSet::new(),
        )
        .expect_err("reject oversized draft");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert_eq!(
            error.message,
            "Content is too large. Maximum supported size is 10 MiB."
        );
        assert!(!dir.exists());
        cleanup(&dir);
    }

    #[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
    #[test]
    fn failed_atomic_write_removes_reserved_file() {
        let dir = temp_drafts_dir();
        fs::create_dir(&dir).unwrap();
        let path = dir.join("Untitled.md");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();

        let error = write_reserved_markdown(&path, "new draft").expect_err("reject read-only file");

        assert_eq!(error.category, NativeFileErrorCategory::ReadOnly);
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        cleanup(&dir);
    }

    #[test]
    fn created_draft_returns_the_opened_file_revision_and_identity() {
        let dir = temp_drafts_dir();
        let saved = create_draft_in(&dir, "Untitled", "# New draft\n", &HashSet::new()).unwrap();
        let saved = serde_json::to_value(saved).unwrap();
        let opened = open_markdown_file_impl(saved["canonicalPath"].as_str().unwrap().to_owned())
            .expect("open created draft");
        let opened = serde_json::to_value(opened).unwrap();

        assert_eq!(saved["conflict"], false);
        assert_eq!(saved["currentRevision"], opened["revision"]);
        assert_eq!(saved["canonicalPath"], opened["canonicalPath"]);
        assert_eq!(saved["name"], "Untitled.md");
        assert_eq!(opened["content"], "# New draft\n");
        cleanup(&dir);
    }

    #[test]
    fn concurrent_draft_creation_keeps_distinct_names_and_contents() {
        let dir = temp_drafts_dir();
        fs::create_dir(&dir).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let children: Vec<_> = (0..4)
            .map(|number| {
                let dir = dir.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let text = format!("draft {number} {}", "x".repeat(64 * 1024));
                    barrier.wait();
                    let saved = create_draft_in(&dir, "Untitled", &text, &HashSet::new()).unwrap();
                    let value = serde_json::to_value(saved).unwrap();
                    let path = value["canonicalPath"].as_str().unwrap().to_owned();
                    assert_eq!(fs::read_to_string(&path).unwrap(), text);
                    path
                })
            })
            .collect();
        let mut paths: Vec<_> = children.into_iter().map(|t| t.join().unwrap()).collect();
        paths.sort();
        paths.dedup();
        assert_eq!(paths.len(), 4);
        for name in [
            "Untitled.md",
            "Untitled 2.md",
            "Untitled 3.md",
            "Untitled 4.md",
        ] {
            assert!(dir.join(name).exists());
        }
        cleanup(&dir);
    }

    #[test]
    fn rejects_exhausted_draft_names() {
        let dir = temp_drafts_dir();
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("Untitled.md"), "existing").unwrap();
        for number in 2..=999 {
            fs::write(dir.join(format!("Untitled {number}.md")), "existing").unwrap();
        }

        let error = create_draft_in(&dir, "Untitled", "new draft", &HashSet::new())
            .expect_err("all names occupied");

        assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
        assert!(error.message.starts_with("Too many untitled drafts."));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 999);
        assert_eq!(
            fs::read_to_string(dir.join("Untitled.md")).unwrap(),
            "existing"
        );
        cleanup(&dir);
    }

    #[test]
    fn delete_only_removes_supported_direct_children() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "draft", &HashSet::new()).unwrap();
        let outside = unique_temp_path("md");
        fs::write(&outside, "outside document").unwrap();
        let unsupported = dir.join("notes.txt");
        fs::write(&unsupported, "not a document").unwrap();
        let nested = dir.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_file = nested.join("note.md");
        fs::write(&nested_file, "nested document").unwrap();

        for path in [&outside, &unsupported, &nested_file, &nested] {
            let error = delete_draft_in(&dir, path, &outside).expect_err("refuse non-draft path");
            assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
            assert!(path.exists());
        }
        assert!(delete_draft_in(&dir, &dir.join("Untitled.md"), &outside).expect("delete draft"));
        assert!(!dir.join("Untitled.md").exists());
        cleanup_temp_path(&outside);
        cleanup(&dir);
    }

    #[test]
    fn delete_missing_draft_succeeds_without_creating_its_directory() {
        let dir = temp_drafts_dir();
        let missing = dir.join("Untitled.md");

        assert!(!delete_draft_in(&dir, &missing, &missing).expect("already absent folder"));
        assert!(!dir.exists());
        fs::create_dir(&dir).unwrap();
        assert!(!delete_draft_in(&dir, &missing, &missing).expect("already absent draft"));
        assert!(!missing.exists());
        assert!(delete_draft_in(&dir, &dir.join("notes.txt"), &missing).is_err());
        let outside = unique_temp_path("md");
        assert!(delete_draft_in(&dir, &outside, &missing).is_err());
        cleanup_temp_path(&outside);
        cleanup(&dir);
    }

    #[test]
    fn delete_preserves_draft_when_saved_path_is_the_same_file() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "saved draft", &HashSet::new()).unwrap();
        let path = dir.join("Untitled.md");

        assert!(!delete_draft_in(&dir, &path, &path).expect("same file needs no cleanup"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved draft");
        cleanup(&dir);
    }

    #[test]
    fn delete_preserves_draft_when_saved_target_is_missing() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "keep this draft", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let missing_saved_path = unique_temp_path("md");

        let error = delete_draft_in(&dir, &draft, &missing_saved_path)
            .expect_err("do not delete without a saved document");

        assert_eq!(error.category, NativeFileErrorCategory::NotFound);
        assert_eq!(fs::read_to_string(&draft).unwrap(), "keep this draft");
        cleanup_temp_path(&missing_saved_path);
        cleanup(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn saving_with_case_variant_keeps_the_saved_document() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "before Save As", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let chosen = dir.join("untitled.md");
        let saved = tauri::async_runtime::block_on(write_markdown_file_if_unmodified(
            chosen.to_string_lossy().into_owned(),
            "saved with case variant".to_string(),
            None,
            Some(true),
            None,
        ))
        .expect("save to case variant");
        let saved = serde_json::to_value(saved).unwrap();
        let saved_path = Path::new(saved["canonicalPath"].as_str().unwrap());
        let same_file =
            dunce::canonicalize(&draft).unwrap() == dunce::canonicalize(saved_path).unwrap();

        let removed =
            delete_draft_in(&dir, &draft, saved_path).expect("clean up draft after saving");

        assert_eq!(
            removed, !same_file,
            "respect the host volume's case sensitivity"
        );
        assert_eq!(
            fs::read_to_string(saved_path).unwrap(),
            "saved with case variant"
        );
        assert_eq!(draft.exists(), same_file);
        cleanup(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn saving_with_unicode_normalization_variant_keeps_the_saved_document() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Caf\u{e9}", "before Save As", &HashSet::new()).unwrap();
        let draft = dir.join("Caf\u{e9}.md");
        let chosen = dir.join("Cafe\u{301}.md");
        let saved = tauri::async_runtime::block_on(write_markdown_file_if_unmodified(
            chosen.to_string_lossy().into_owned(),
            "saved with Unicode variant".to_string(),
            None,
            Some(true),
            None,
        ))
        .expect("save to normalization variant");
        let saved = serde_json::to_value(saved).unwrap();
        let saved_path = Path::new(saved["canonicalPath"].as_str().unwrap());
        let same_file =
            dunce::canonicalize(&draft).unwrap() == dunce::canonicalize(saved_path).unwrap();

        let removed =
            delete_draft_in(&dir, &draft, saved_path).expect("clean up draft after saving");

        assert_eq!(
            removed, !same_file,
            "respect the host volume's normalization behavior"
        );
        assert_eq!(
            fs::read_to_string(saved_path).unwrap(),
            "saved with Unicode variant"
        );
        assert_eq!(draft.exists(), same_file);
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn delete_preserves_saved_document_through_symlinked_parent() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "saved through alias", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let alias = unique_temp_path("alias");
        symlink(&dir, &alias).unwrap();
        let saved_path = alias.join("Untitled.md");

        assert!(!delete_draft_in(&dir, &draft, &saved_path).expect("same file through alias"));
        assert_eq!(
            fs::read_to_string(&saved_path).unwrap(),
            "saved through alias"
        );
        assert!(draft.exists());
        cleanup_temp_path(&alias);
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn delete_preserves_hard_links_but_removes_draft_after_saved_link_is_replaced() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "linked document", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let saved_path = unique_temp_path("md");
        fs::hard_link(&draft, &saved_path).unwrap();

        assert!(!delete_draft_in(&dir, &draft, &saved_path).expect("same underlying file"));
        assert_eq!(fs::read_to_string(&draft).unwrap(), "linked document");
        assert_eq!(fs::read_to_string(&saved_path).unwrap(), "linked document");

        write_markdown_contents_atomic(&saved_path, "saved separately").unwrap();
        assert!(delete_draft_in(&dir, &draft, &saved_path)
            .expect("saved file now has its own identity"));
        assert!(!draft.exists());
        assert_eq!(fs::read_to_string(&saved_path).unwrap(), "saved separately");
        cleanup_temp_path(&saved_path);
        cleanup(&dir);
    }

    #[test]
    fn recognizes_only_supported_existing_drafts_in_direct_parent() {
        let dir = temp_drafts_dir();
        assert!(!is_draft_in(&dir, &dir.join("Untitled.md")));
        create_draft_in(&dir, "Untitled", "draft", &HashSet::new()).unwrap();
        let outside = unique_temp_path("md");
        fs::write(&outside, "outside document").unwrap();
        fs::write(dir.join("notes.txt"), "not a document").unwrap();
        let nested = dir.join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("note.md"), "nested document").unwrap();

        assert!(is_draft_in(&dir, &dir.join("Untitled.md")));
        for path in [
            &outside,
            &dir.join("missing.md"),
            &dir.join("notes.txt"),
            &nested.join("note.md"),
            &nested,
        ] {
            assert!(!is_draft_in(&dir, path));
        }
        cleanup_temp_path(&outside);
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn handles_symlinked_parent_and_refuses_targets_outside_drafts() {
        let dir = temp_drafts_dir();
        let alias = unique_temp_path("alias");
        create_draft_in(&dir, "Untitled", "draft", &HashSet::new()).unwrap();
        symlink(&dir, &alias).unwrap();
        let outside = unique_temp_path("md");
        fs::write(&outside, "outside document").unwrap();
        let outside_link = dir.join("outside.md");
        symlink(&outside, &outside_link).unwrap();

        assert!(is_draft_in(&dir, &alias.join("Untitled.md")));
        assert!(is_draft_in(&alias, &dir.join("Untitled.md")));
        assert!(!is_draft_in(&dir, &outside_link));
        assert_eq!(
            delete_draft_in(&dir, &outside_link, &outside)
                .unwrap_err()
                .category,
            NativeFileErrorCategory::InvalidInput
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside document");
        assert!(delete_draft_in(&dir, &alias.join("Untitled.md"), &outside)
            .expect("delete through parent alias"));
        assert!(!delete_draft_in(&dir, &alias.join("Untitled.md"), &outside)
            .expect("missing file through parent alias"));
        assert!(!dir.join("Untitled.md").exists());
        cleanup_temp_path(&outside);
        cleanup_temp_path(&alias);
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn classification_prefilter_requires_the_canonical_drafts_folder_name() {
        let dir = temp_drafts_dir();
        let relocated = unique_temp_path("relocated");
        fs::create_dir(&relocated).unwrap();
        fs::write(relocated.join("Untitled.md"), "relocated document").unwrap();
        symlink(&relocated, &dir).unwrap();

        // Arbitrary relocated folder names do not opt unrelated folders into Documents checks.
        assert!(!is_draft_in(&dir, &dir.join("Untitled.md")));
        assert!(!is_draft_in(&dir, &relocated.join("Untitled.md")));

        cleanup_temp_path(&dir);
        cleanup(&relocated);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn drafts_folder_spelled_with_different_case_still_holds_drafts() {
        let dir = temp_drafts_dir();
        let existing = dir.with_file_name(DRAFTS_DIR_NAME.to_lowercase());
        fs::create_dir_all(&existing).unwrap();

        let saved = create_draft_in(
            &dir,
            "Untitled",
            "draft in the reused folder",
            &HashSet::new(),
        )
        .unwrap();
        let saved = serde_json::to_value(saved).unwrap();
        let path = PathBuf::from(saved["canonicalPath"].as_str().unwrap());

        assert_eq!(
            path.parent().and_then(Path::file_name),
            Some(DRAFTS_DIR_NAME.to_lowercase().as_ref())
        );
        assert!(is_draft_in(&dir, &path));
        cleanup(&dir);
    }

    #[test]
    fn matching_folder_name_outside_configured_drafts_is_not_a_draft() {
        let dir = temp_drafts_dir();
        let other = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "real draft", &HashSet::new()).unwrap();
        create_draft_in(&other, "Untitled", "unrelated document", &HashSet::new()).unwrap();

        assert!(!is_draft_in(&dir, &other.join("Untitled.md")));

        cleanup(&other);
        cleanup(&dir);
    }

    #[test]
    fn concurrent_creation_uses_distinct_names() {
        let dir = temp_drafts_dir();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| create_draft_in(&dir, "Untitled", "first", &HashSet::new()));
            let second =
                scope.spawn(|| create_draft_in(&dir, "Untitled", "second", &HashSet::new()));
            first.join().unwrap().expect("first draft");
            second.join().unwrap().expect("second draft");
        });

        let mut contents = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>();
        contents.sort();
        assert_eq!(contents, ["first", "second"]);
        cleanup(&dir);
    }
}
