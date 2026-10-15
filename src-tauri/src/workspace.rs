use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use walkdir::WalkDir;

use crate::document_io::{canonicalize_directory_path, is_markdown_path};
use crate::file_errors::{run_blocking_file_io, NativeFileError, NativeFileOperation};

const DEFAULT_WORKSPACE_MAX_FILES: usize = 5_000;
const ABSOLUTE_WORKSPACE_MAX_FILES: usize = 20_000;
const MAX_WORKSPACE_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceFileMeta {
    path: String,
    rel_path: String,
    name: String,
    size: u64,
    mtime_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceListResult {
    canonical_root: Option<String>,
    pub(crate) files: Vec<WorkspaceFileMeta>,
    directories: Vec<String>,
    issues: Vec<String>,
    skipped_count: usize,
    limit_hit: bool,
    /// The listing was not attempted; see `drafts::list_drafts_in`.
    pub(crate) skipped: bool,
}

impl WorkspaceListResult {
    pub(crate) fn empty() -> Self {
        Self {
            canonical_root: None,
            files: vec![],
            directories: vec![],
            issues: vec![],
            skipped_count: 0,
            limit_hit: false,
            skipped: false,
        }
    }

    pub(crate) fn skipped() -> Self {
        Self {
            skipped: true,
            ..Self::empty()
        }
    }
}

/// Stat only explicitly supplied recent files; this never scans their parents.
#[tauri::command]
pub(crate) async fn inspect_document_files(
    paths: Vec<String>,
) -> Result<Vec<WorkspaceFileMeta>, NativeFileError> {
    run_blocking_file_io(move || {
        Ok(paths
            .into_iter()
            .take(25)
            .filter_map(|path| {
                let canonical =
                    crate::document_io::canonicalize_markdown_path(std::path::Path::new(&path))
                        .ok()?;
                let metadata = fs::metadata(&canonical).ok()?;
                let name = canonical.file_name()?.to_string_lossy().into_owned();
                Some(WorkspaceFileMeta {
                    path: canonical.to_string_lossy().into_owned(),
                    rel_path: name.clone(),
                    name,
                    size: metadata.len(),
                    mtime_ms: metadata
                        .modified()
                        .ok()?
                        .duration_since(std::time::UNIX_EPOCH)
                        .ok()?
                        .as_millis(),
                })
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_workspace_markdown_files(
    root: String,
    max_files: Option<usize>,
) -> Result<WorkspaceListResult, NativeFileError> {
    run_blocking_file_io(move || list_workspace_markdown_files_impl(root, max_files)).await
}

pub(crate) fn list_workspace_markdown_files_impl(
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
    let mut directories = Vec::new();
    let mut issues = Vec::new();
    let mut visited = 0;

    for entry_result in WalkDir::new(&canonical_root)
        .follow_links(false)
        .max_depth(MAX_WORKSPACE_DEPTH)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_dir()
                || (!entry.file_name().to_string_lossy().starts_with('.')
                    && !matches!(
                        entry.file_name().to_str(),
                        Some("node_modules" | "target" | "vendor")
                    ))
        })
    {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(error) => {
                skipped_count += 1;
                if issues.len() < 100 {
                    issues.push(error.to_string());
                }
                continue;
            }
        };

        visited += 1;
        if visited > 100_000 {
            limit_hit = true;
            break;
        }
        let path = entry.path();
        if entry.file_type().is_dir() && entry.depth() > 0 {
            if entry.depth() == MAX_WORKSPACE_DEPTH {
                limit_hit = true;
            }
            if directories.len() < 20_000 {
                directories.push(
                    path.strip_prefix(&canonical_root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            } else {
                limit_hit = true;
            }
        }
        if !entry.file_type().is_file() || !is_markdown_path(path) {
            continue;
        }

        // Resolve to the true target and ensure it stays inside the workspace root.
        let canonical_file = match dunce::canonicalize(path) {
            Ok(p) => p,
            Err(error) => {
                skipped_count += 1;
                if issues.len() < 100 {
                    issues.push(format!("{}: {}", path.display(), error));
                }
                continue;
            }
        };
        if !canonical_file.starts_with(&canonical_root) {
            skipped_count += 1;
            if issues.len() < 100 {
                issues.push(format!("{}: resolved outside this folder", path.display()));
            }
            continue;
        }

        let metadata = match fs::metadata(&canonical_file) {
            Ok(m) if m.is_file() => m,
            result => {
                skipped_count += 1;
                if issues.len() < 100 {
                    issues.push(format!(
                        "{}: {}",
                        canonical_file.display(),
                        result
                            .err()
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "no longer a regular file".into())
                    ));
                }
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
            if issues.len() < 100 {
                issues.push(format!(
                    "{}: filename cannot be represented as text",
                    canonical_file.display()
                ));
            }
            continue;
        }

        files_by_rel.insert(
            rel_path_string.clone(),
            WorkspaceFileMeta {
                path: canonical_file.to_string_lossy().into_owned(),
                rel_path: rel_path_string,
                name,
                size: metadata.len(),
                mtime_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
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
        canonical_root: Some(canonical_root.to_string_lossy().into_owned()),
        files,
        directories,
        issues,
        skipped_count,
        limit_hit,
        skipped: false,
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
    fn discovery_keeps_unreadable_text_and_empty_subfolders_but_excludes_dependencies() {
        let root = temp_dir("catalog");
        for name in ["empty", ".hidden", "node_modules", "target", "vendor"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(root.join("bad.md"), [0xff, 0xfe]).unwrap();
        fs::write(root.join("node_modules/dependency.md"), "hidden").unwrap();
        fs::write(root.join(".hidden/secret.md"), "hidden").unwrap();
        let result =
            list_workspace_markdown_files_impl(root.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].name, "bad.md");
        assert_eq!(result.files[0].size, 2);
        assert!(result.files[0].mtime_ms > 0);
        assert_eq!(result.directories, vec!["empty"]);
        cleanup_dir(&root);
    }

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
    fn listing_reports_canonical_root_for_an_alias_even_when_empty() {
        let root = temp_dir("workspace-root-identity");
        fs::create_dir_all(&root).unwrap();
        let alias = root.with_extension("alias");
        symlink(&root, &alias).expect("create root alias");
        let canonical = dunce::canonicalize(&root).unwrap();
        let result = list_workspace_markdown_files_impl(alias.to_string_lossy().into_owned(), None)
            .expect("list aliased folder");
        assert_eq!(
            result.canonical_root,
            Some(canonical.to_string_lossy().into_owned())
        );
        assert!(result.files.is_empty());
        fs::remove_file(&alias).unwrap();
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
