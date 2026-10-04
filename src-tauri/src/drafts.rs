use cap_fs_ext::MetadataExt;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::document_io::{
    canonicalize_directory_path, canonicalize_markdown_path, is_markdown_path, read_bounded_file,
    reject_oversized_markdown, write_new_markdown_file, ConditionalWriteResult, FileRevision,
    NewMarkdownFile,
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

/// What retirement did with the old draft after a successful Save As.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DraftRetirement {
    Removed,
    /// The draft is the saved document itself, or is already gone.
    NothingToRemove,
    /// The draft or the saved document no longer holds the bytes the save knew
    /// about, so the draft may be the only copy of some text.
    Kept,
}

/// Removes a retired draft after Save As, or says why it stays.
/// `draft_revision` describes the draft as Bindars last read or wrote it and
/// `saved_revision` the destination as the save acknowledged it.
fn delete_draft_in(
    dir: &Path,
    path: &Path,
    saved_path: &Path,
    draft_revision: &FileRevision,
    saved_revision: &FileRevision,
) -> Result<DraftRetirement, NativeFileError> {
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
                Ok(DraftRetirement::NothingToRemove)
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
                Ok(DraftRetirement::NothingToRemove)
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
        return Ok(DraftRetirement::NothingToRemove);
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
        return Ok(DraftRetirement::NothingToRemove);
    }

    // Best-effort version check through the handles opened above. A draft
    // changed by another program, or a destination that no longer holds the
    // acknowledged text, may be the only copy of that text, so keep the draft.
    // Newer typing in the destination is expected and compared only against
    // the acknowledged save. A replacement between this read and the unlink is
    // not detected.
    let (draft_bytes, _) = read_bounded_file(
        &canonical_path,
        &draft_file,
        NativeFileOperation::InspectSavedDocument,
    )?;
    if !draft_revision.matches_contents(&draft_bytes) {
        return Ok(DraftRetirement::Kept);
    }
    let (saved_bytes, _) = read_bounded_file(
        &canonical_saved_path,
        &saved_file,
        NativeFileOperation::InspectSavedDocument,
    )?;
    if !saved_revision.matches_contents(&saved_bytes) {
        return Ok(DraftRetirement::Kept);
    }

    match fs::remove_file(&canonical_path) {
        Ok(()) => Ok(DraftRetirement::Removed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DraftRetirement::NothingToRemove)
        }
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
    draft_revision: FileRevision,
    saved_revision: FileRevision,
) -> Result<DraftRetirement, NativeFileError> {
    run_blocking_file_io(move || {
        delete_draft_in(
            &drafts_dir(&app)?,
            Path::new(&path),
            Path::new(&saved_path),
            &draft_revision,
            &saved_revision,
        )
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
    use crate::document_io::{open_markdown_file_impl, revision_from_bytes, MAX_MARKDOWN_BYTES};
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

    /// The revision Bindars would hold for `path` after reading or writing it.
    fn revision_of(path: &Path) -> FileRevision {
        open_markdown_file_impl(path.to_string_lossy().into_owned())
            .expect("read revision")
            .revision
    }

    /// A revision describing bytes no test file holds, for calls that must stop
    /// before any content comparison.
    fn unrelated_revision() -> FileRevision {
        let temp = fs::metadata(std::env::temp_dir()).unwrap();
        revision_from_bytes(&temp, &temp, b"unrelated bytes")
    }

    fn retire(dir: &Path, draft: &Path, saved: &Path) -> Result<DraftRetirement, NativeFileError> {
        delete_draft_in(dir, draft, saved, &revision_of(draft), &revision_of(saved))
    }

    fn retire_unverified(
        dir: &Path,
        draft: &Path,
        saved: &Path,
    ) -> Result<DraftRetirement, NativeFileError> {
        let unrelated = unrelated_revision();
        delete_draft_in(dir, draft, saved, &unrelated, &unrelated)
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
            let error = retire_unverified(&dir, path, &outside).expect_err("refuse non-draft path");
            assert_eq!(error.category, NativeFileErrorCategory::InvalidInput);
            assert!(path.exists());
        }
        assert_eq!(
            retire(&dir, &dir.join("Untitled.md"), &outside).expect("delete draft"),
            DraftRetirement::Removed
        );
        assert!(!dir.join("Untitled.md").exists());
        cleanup_temp_path(&outside);
        cleanup(&dir);
    }

    #[test]
    fn delete_missing_draft_succeeds_without_creating_its_directory() {
        let dir = temp_drafts_dir();
        let missing = dir.join("Untitled.md");

        assert_eq!(
            retire_unverified(&dir, &missing, &missing).expect("already absent folder"),
            DraftRetirement::NothingToRemove
        );
        assert!(!dir.exists());
        fs::create_dir(&dir).unwrap();
        assert_eq!(
            retire_unverified(&dir, &missing, &missing).expect("already absent draft"),
            DraftRetirement::NothingToRemove
        );
        assert!(!missing.exists());
        assert!(retire_unverified(&dir, &dir.join("notes.txt"), &missing).is_err());
        let outside = unique_temp_path("md");
        assert!(retire_unverified(&dir, &outside, &missing).is_err());
        cleanup_temp_path(&outside);
        cleanup(&dir);
    }

    #[test]
    fn delete_preserves_draft_when_saved_path_is_the_same_file() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "saved draft", &HashSet::new()).unwrap();
        let path = dir.join("Untitled.md");

        assert_eq!(
            retire(&dir, &path, &path).expect("same file needs no cleanup"),
            DraftRetirement::NothingToRemove
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved draft");
        cleanup(&dir);
    }

    #[test]
    fn delete_keeps_draft_changed_by_another_program() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "baseline draft", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let known = revision_of(&draft);
        let saved = unique_temp_path("md");
        fs::write(&saved, "baseline draft").unwrap();
        let acknowledged = revision_of(&saved);
        fs::write(&draft, "only copy: changed outside Bindars during Save As").unwrap();

        assert_eq!(
            delete_draft_in(&dir, &draft, &saved, &known, &acknowledged)
                .expect("retain the changed draft"),
            DraftRetirement::Kept
        );
        assert_eq!(
            fs::read_to_string(&draft).unwrap(),
            "only copy: changed outside Bindars during Save As"
        );
        cleanup_temp_path(&saved);
        cleanup(&dir);
    }

    #[test]
    fn delete_keeps_draft_when_saved_document_lost_the_acknowledged_text() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "intended text", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let saved = unique_temp_path("md");
        fs::write(&saved, "intended text").unwrap();
        let acknowledged = revision_of(&saved);
        fs::write(&saved, "").unwrap();

        assert_eq!(
            delete_draft_in(&dir, &draft, &saved, &revision_of(&draft), &acknowledged)
                .expect("retain the draft behind a truncated destination"),
            DraftRetirement::Kept
        );
        assert_eq!(fs::read_to_string(&draft).unwrap(), "intended text");
        cleanup_temp_path(&saved);
        cleanup(&dir);
    }

    #[test]
    fn delete_removes_unchanged_draft_when_saved_document_holds_newer_text() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "draft text", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let saved = unique_temp_path("md");
        // The destination legitimately carries typing the draft never received.
        fs::write(&saved, "draft text plus newer typing").unwrap();

        assert_eq!(
            retire(&dir, &draft, &saved).expect("retire the unchanged draft"),
            DraftRetirement::Removed
        );
        assert!(!draft.exists());
        assert_eq!(
            fs::read_to_string(&saved).unwrap(),
            "draft text plus newer typing"
        );
        cleanup_temp_path(&saved);
        cleanup(&dir);
    }

    #[test]
    fn delete_ignores_timestamp_only_changes() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "touched draft", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let known = revision_of(&draft);
        let saved = unique_temp_path("md");
        fs::write(&saved, "touched draft").unwrap();
        let acknowledged = revision_of(&saved);
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        for path in [&draft, &saved] {
            let file = fs::File::options().write(true).open(path).unwrap();
            file.set_modified(later).unwrap();
        }
        assert_ne!(
            revision_of(&draft),
            known,
            "the touch must change the full revision"
        );

        assert_eq!(
            delete_draft_in(&dir, &draft, &saved, &known, &acknowledged)
                .expect("timestamps alone do not block retirement"),
            DraftRetirement::Removed
        );
        assert!(!draft.exists());
        cleanup_temp_path(&saved);
        cleanup(&dir);
    }

    #[test]
    fn delete_preserves_draft_when_saved_target_is_missing() {
        let dir = temp_drafts_dir();
        create_draft_in(&dir, "Untitled", "keep this draft", &HashSet::new()).unwrap();
        let draft = dir.join("Untitled.md");
        let missing_saved_path = unique_temp_path("md");

        let error = retire_unverified(&dir, &draft, &missing_saved_path)
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
        let draft_revision = revision_of(&draft);
        let chosen = dir.join("untitled.md");
        let saved = tauri::async_runtime::block_on(write_markdown_file_if_unmodified(
            chosen.to_string_lossy().into_owned(),
            "saved with case variant".to_string(),
            None,
            Some(true),
            None,
        ))
        .expect("save to case variant");
        let saved_revision = saved.current_revision.clone();
        let saved = serde_json::to_value(saved).unwrap();
        let saved_path = Path::new(saved["canonicalPath"].as_str().unwrap());
        let same_file =
            dunce::canonicalize(&draft).unwrap() == dunce::canonicalize(saved_path).unwrap();

        let retirement =
            delete_draft_in(&dir, &draft, saved_path, &draft_revision, &saved_revision)
                .expect("clean up draft after saving");

        assert_eq!(
            retirement,
            if same_file {
                DraftRetirement::NothingToRemove
            } else {
                DraftRetirement::Removed
            },
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
        let draft_revision = revision_of(&draft);
        let chosen = dir.join("Cafe\u{301}.md");
        let saved = tauri::async_runtime::block_on(write_markdown_file_if_unmodified(
            chosen.to_string_lossy().into_owned(),
            "saved with Unicode variant".to_string(),
            None,
            Some(true),
            None,
        ))
        .expect("save to normalization variant");
        let saved_revision = saved.current_revision.clone();
        let saved = serde_json::to_value(saved).unwrap();
        let saved_path = Path::new(saved["canonicalPath"].as_str().unwrap());
        let same_file =
            dunce::canonicalize(&draft).unwrap() == dunce::canonicalize(saved_path).unwrap();

        let retirement =
            delete_draft_in(&dir, &draft, saved_path, &draft_revision, &saved_revision)
                .expect("clean up draft after saving");

        assert_eq!(
            retirement,
            if same_file {
                DraftRetirement::NothingToRemove
            } else {
                DraftRetirement::Removed
            },
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

        assert_eq!(
            retire(&dir, &draft, &saved_path).expect("same file through alias"),
            DraftRetirement::NothingToRemove
        );
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

        assert_eq!(
            retire(&dir, &draft, &saved_path).expect("same underlying file"),
            DraftRetirement::NothingToRemove
        );
        assert_eq!(fs::read_to_string(&draft).unwrap(), "linked document");
        assert_eq!(fs::read_to_string(&saved_path).unwrap(), "linked document");

        write_markdown_contents_atomic(&saved_path, "saved separately").unwrap();
        assert_eq!(
            retire(&dir, &draft, &saved_path).expect("saved file now has its own identity"),
            DraftRetirement::Removed
        );
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
            retire_unverified(&dir, &outside_link, &outside)
                .unwrap_err()
                .category,
            NativeFileErrorCategory::InvalidInput
        );
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside document");
        assert_eq!(
            retire(&dir, &alias.join("Untitled.md"), &outside)
                .expect("delete through parent alias"),
            DraftRetirement::Removed
        );
        assert_eq!(
            retire_unverified(&dir, &alias.join("Untitled.md"), &outside)
                .expect("missing file through parent alias"),
            DraftRetirement::NothingToRemove
        );
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
