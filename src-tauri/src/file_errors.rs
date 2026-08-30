use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeFileErrorCategory {
    NotFound,
    PermissionDenied,
    ReadOnly,
    ResourceUnavailable,
    InvalidInput,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeFileOperation {
    FileTask,
    ResolveDocument,
    InspectDocument,
    OpenDocument,
    ReadDocument,
    DecodeDocument,
    ValidateDocument,
    CheckRevision,
    InspectSavedDocument,
    InspectWriteTarget,
    ResolveWriteParent,
    InspectWriteParent,
    SaveDocument,
    CreateTemporaryFile,
    WriteTemporaryFile,
    PreservePermissions,
    SyncTemporaryFile,
    ReplaceFile,
    ExportFile,
    ResolveWorkspace,
    InspectWorkspace,
    ResolveImage,
    InspectImage,
    ValidateImage,
    ReadImage,
    WatchDocument,
    OpenExternally,
    SaveRecoveryData,
    AccessRecoveryData,
}

impl NativeFileOperation {
    fn description(self) -> &'static str {
        match self {
            Self::FileTask => "complete the file operation",
            Self::ResolveDocument => "locate the document",
            Self::InspectDocument => "inspect the document",
            Self::OpenDocument => "open the document",
            Self::ReadDocument => "read the document",
            Self::DecodeDocument => "decode the document",
            Self::ValidateDocument => "validate the document",
            Self::CheckRevision => "check the document revision",
            Self::InspectSavedDocument => "inspect the saved document",
            Self::InspectWriteTarget => "inspect the write target",
            Self::ResolveWriteParent => "locate the destination folder",
            Self::InspectWriteParent => "inspect the destination folder",
            Self::SaveDocument => "save the document",
            Self::CreateTemporaryFile => "create the temporary file",
            Self::WriteTemporaryFile => "write the temporary file",
            Self::PreservePermissions => "preserve file permissions",
            Self::SyncTemporaryFile => "sync the temporary file",
            Self::ReplaceFile => "replace the destination file",
            Self::ExportFile => "export the file",
            Self::ResolveWorkspace => "locate the workspace",
            Self::InspectWorkspace => "inspect the workspace",
            Self::ResolveImage => "locate the image",
            Self::InspectImage => "inspect the image",
            Self::ValidateImage => "validate the image",
            Self::ReadImage => "read the image",
            Self::WatchDocument => "watch the document",
            Self::OpenExternally => "open the document with its default application",
            Self::SaveRecoveryData => "save recovery data",
            Self::AccessRecoveryData => "access recovery data",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeFileError {
    pub(crate) category: NativeFileErrorCategory,
    pub(crate) operation: NativeFileOperation,
    pub(crate) message: String,
    pub(crate) detail: String,
}

impl NativeFileError {
    pub(crate) fn invalid(operation: NativeFileOperation, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            category: NativeFileErrorCategory::InvalidInput,
            operation,
            detail: message.clone(),
            message,
        }
    }

    pub(crate) fn unknown(
        operation: NativeFileOperation,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            category: NativeFileErrorCategory::Unknown,
            operation,
            message: message.into(),
            detail: detail.into(),
        }
    }

    pub(crate) fn read_only(operation: NativeFileOperation, path: &Path) -> Self {
        Self {
            category: NativeFileErrorCategory::ReadOnly,
            operation,
            message: "This file is read-only and was not changed.".to_string(),
            detail: format!(
                "The destination has no POSIX write bits: {}",
                path.display()
            ),
        }
    }

    pub(crate) fn from_io(
        operation: NativeFileOperation,
        path: &Path,
        error: std::io::Error,
    ) -> Self {
        let category = match error.kind() {
            std::io::ErrorKind::NotFound => NativeFileErrorCategory::NotFound,
            std::io::ErrorKind::PermissionDenied => NativeFileErrorCategory::PermissionDenied,
            std::io::ErrorKind::ReadOnlyFilesystem => NativeFileErrorCategory::ReadOnly,
            std::io::ErrorKind::TimedOut => NativeFileErrorCategory::ResourceUnavailable,
            _ => NativeFileErrorCategory::Unknown,
        };
        let message = match (category, operation) {
            (NativeFileErrorCategory::NotFound, NativeFileOperation::ResolveDocument) => {
                "This file is no longer available.".to_string()
            }
            (NativeFileErrorCategory::NotFound, NativeFileOperation::ResolveWorkspace) => {
                "The workspace folder is no longer available.".to_string()
            }
            (NativeFileErrorCategory::PermissionDenied, _) => {
                format!(
                    "Bindars does not have permission to {}.",
                    operation.description()
                )
            }
            (NativeFileErrorCategory::ReadOnly, _) => {
                format!(
                    "The destination is read-only, so Bindars could not {}.",
                    operation.description()
                )
            }
            (NativeFileErrorCategory::ResourceUnavailable, _) => {
                format!(
                    "The resource is temporarily unavailable, so Bindars could not {}.",
                    operation.description()
                )
            }
            _ => format!("Bindars could not {}.", operation.description()),
        };
        Self {
            category,
            operation,
            message,
            detail: format!("{}: {error}", path.display()),
        }
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, needle: &str) -> bool {
        self.message.contains(needle) || self.detail.contains(needle)
    }
}

impl std::fmt::Display for NativeFileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) async fn run_blocking_file_io<T, F>(task: F) -> Result<T, NativeFileError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, NativeFileError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| {
            NativeFileError::unknown(
                NativeFileOperation::FileTask,
                "Bindars could not complete the file operation.",
                error.to_string(),
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_io_error_categories_are_conservative() {
        let path = Path::new("/tmp/category.md");
        let cases = [
            (
                std::io::ErrorKind::NotFound,
                NativeFileErrorCategory::NotFound,
            ),
            (
                std::io::ErrorKind::PermissionDenied,
                NativeFileErrorCategory::PermissionDenied,
            ),
            (
                std::io::ErrorKind::ReadOnlyFilesystem,
                NativeFileErrorCategory::ReadOnly,
            ),
            (
                std::io::ErrorKind::TimedOut,
                NativeFileErrorCategory::ResourceUnavailable,
            ),
            (
                std::io::ErrorKind::Interrupted,
                NativeFileErrorCategory::Unknown,
            ),
            (
                std::io::ErrorKind::WouldBlock,
                NativeFileErrorCategory::Unknown,
            ),
        ];

        for (kind, expected) in cases {
            let error = NativeFileError::from_io(
                NativeFileOperation::SaveDocument,
                path,
                std::io::Error::from(kind),
            );
            assert_eq!(error.category, expected, "unexpected category for {kind:?}");
        }
    }

    #[test]
    fn missing_document_error_keeps_the_path_out_of_its_user_message() {
        let path = Path::new("/private/documents/missing.md");

        let error = NativeFileError::from_io(
            NativeFileOperation::ResolveDocument,
            path,
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );

        assert_eq!(error.message, "This file is no longer available.");
        assert!(!error.message.contains("/private/documents"));
        assert!(error.detail.contains("/private/documents/missing.md"));
    }

    #[test]
    fn missing_workspace_error_keeps_the_path_out_of_its_user_message() {
        let path = Path::new("/private/workspaces/missing");

        let error = NativeFileError::from_io(
            NativeFileOperation::ResolveWorkspace,
            path,
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );

        assert_eq!(
            error.message,
            "The workspace folder is no longer available."
        );
        assert!(!error.message.contains("/private/workspaces"));
        assert!(error.detail.contains("/private/workspaces/missing"));
    }
}
