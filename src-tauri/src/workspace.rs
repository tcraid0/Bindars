use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

use crate::document_io::{canonicalize_directory_path, is_markdown_path};
use crate::file_errors::{run_blocking_file_io, NativeFileError, NativeFileOperation};

const DEFAULT_WORKSPACE_MAX_FILES: usize = 5_000;
const ABSOLUTE_WORKSPACE_MAX_FILES: usize = 20_000;
const MAX_WORKSPACE_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileMeta {
    path: String,
    rel_path: String,
    name: String,
    mtime_ms: u64,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceListResult {
    files: Vec<WorkspaceFileMeta>,
    skipped_count: usize,
    limit_hit: bool,
}

#[tauri::command]
pub(crate) async fn list_workspace_markdown_files(
    root: String,
    max_files: Option<usize>,
) -> Result<WorkspaceListResult, NativeFileError> {
    run_blocking_file_io(move || list_workspace_markdown_files_impl(root, max_files)).await
}

fn list_workspace_markdown_files_impl(
    root: String,
    max_files: Option<usize>,
) -> Result<WorkspaceListResult, NativeFileError> {
    let root_path = PathBuf::from(root);
    let canonical_root = canonicalize_directory_path(
        &root_path,
        NativeFileOperation::ResolveWorkspace,
        NativeFileOperation::InspectWorkspace,
    )?;
    let limit = max_files
        .unwrap_or(DEFAULT_WORKSPACE_MAX_FILES)
        .min(ABSOLUTE_WORKSPACE_MAX_FILES);

    let mut files_by_rel = BTreeMap::<String, WorkspaceFileMeta>::new();
    let mut skipped_count: usize = 0;
    let mut limit_hit = false;

    for entry_result in WalkDir::new(&canonical_root)
        .follow_links(false)
        .max_depth(MAX_WORKSPACE_DEPTH)
        .into_iter()
    {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };

        let path = entry.path();
        if !entry.file_type().is_file() || !is_markdown_path(path) {
            continue;
        }

        // Resolve to the true target and ensure it stays inside the workspace root.
        let canonical_file = match dunce::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        if !canonical_file.starts_with(&canonical_root) {
            skipped_count += 1;
            continue;
        }

        let metadata = match fs::metadata(&canonical_file) {
            Ok(m) if m.is_file() => m,
            _ => {
                skipped_count += 1;
                continue;
            }
        };

        let rel_path = match canonical_file.strip_prefix(&canonical_root) {
            Ok(rel) => rel,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        let rel_path_string = rel_path.to_string_lossy().into_owned();

        let name = canonical_file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if name.is_empty() {
            skipped_count += 1;
            continue;
        }

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        files_by_rel.insert(
            rel_path_string.clone(),
            WorkspaceFileMeta {
                path: canonical_file.to_string_lossy().into_owned(),
                rel_path: rel_path_string,
                name,
                mtime_ms,
                size: metadata.len(),
            },
        );

        if files_by_rel.len() > limit {
            limit_hit = true;
            if let Some(last_key) = files_by_rel.keys().next_back().cloned() {
                files_by_rel.remove(&last_key);
            }
        }
    }

    let files = files_by_rel.into_values().collect();
    Ok(WorkspaceListResult {
        files,
        skipped_count,
        limit_hit,
    })
}

#[cfg(test)]
mod tests {
    use super::list_workspace_markdown_files_impl;
    use crate::test_support::{cleanup_temp_path, unique_temp_dir, unique_temp_path};
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::path::{Path, PathBuf};

    #[test]
    fn list_workspace_finds_markdown_files_recursively() {
        let root = temp_dir("workspace");
        let nested = root.join("docs");
        fs::create_dir_all(&nested).expect("create nested dir");

        let a = root.join("a.md");
        let b = nested.join("b.markdown");
        let c = nested.join("c.txt");
        let d = root.join("script.fountain");

        fs::write(&a, "# A").expect("write a");
        fs::write(&b, "# B").expect("write b");
        fs::write(&c, "plain").expect("write c");
        fs::write(&d, "INT. OFFICE - DAY").expect("write d");

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(50))
                .expect("list workspace files");

        assert_eq!(result.files.len(), 3);
        assert!(result.files.iter().any(|f| f.rel_path == "a.md"));
        assert!(result.files.iter().any(|f| f.rel_path == "docs/b.markdown"));
        assert!(result.files.iter().any(|f| f.rel_path == "script.fountain"));

        cleanup_dir(&root);
    }

    #[test]
    fn list_workspace_respects_limit() {
        let root = temp_dir("workspace-limit");
        fs::create_dir_all(&root).expect("create root");

        for i in 0..4 {
            let file = root.join(format!("{}.md", i));
            fs::write(file, "# x").expect("write fixture");
        }

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(2))
                .expect("list workspace files");

        assert_eq!(result.files.len(), 2);

        cleanup_dir(&root);
    }

    #[test]
    fn list_workspace_limit_is_deterministic_by_rel_path() {
        let root = temp_dir("workspace-limit-deterministic");
        fs::create_dir_all(&root).expect("create root");

        fs::write(root.join("z.md"), "# z").expect("write fixture");
        fs::write(root.join("a.md"), "# a").expect("write fixture");
        fs::write(root.join("m.md"), "# m").expect("write fixture");

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(2))
                .expect("list workspace files");

        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].rel_path, "a.md");
        assert_eq!(result.files[1].rel_path, "m.md");
        assert!(result.limit_hit);

        cleanup_dir(&root);
    }

    #[cfg(unix)]
    #[test]
    fn list_workspace_skips_symlink_escape() {
        let root = temp_dir("workspace-symlink");
        fs::create_dir_all(&root).expect("create root");

        let outside = temp_path("md");
        fs::write(&outside, "# outside").expect("write outside");

        let link = root.join("escape.md");
        symlink(&outside, &link).expect("create symlink");

        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), Some(20))
                .expect("list workspace files");

        assert!(result.files.is_empty());

        cleanup(&outside);
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
