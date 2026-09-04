use std::sync::Arc;

#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

mod atomic_write;
mod document_io;
mod exports;
mod file_errors;
mod file_watcher;
mod images;
mod native_lifecycle;
mod navigation;
mod snapshots;
#[cfg(test)]
mod test_support;
mod workspace;

use document_io::{
    open_markdown_file, open_markdown_file_externally, read_markdown_file, resolve_markdown_path,
    write_markdown_file, write_markdown_file_if_unmodified,
};
use exports::{export_html_file, export_markdown_file};
use file_watcher::{unwatch_file, watch_file, FileWatcher};
use images::read_image_file_as_base64;
#[cfg(any(windows, target_os = "linux"))]
use native_lifecycle::initial_cli_open_path;
#[cfg(desktop)]
use native_lifecycle::window_state_flags;
#[cfg(target_os = "macos")]
use native_lifecycle::{
    default_menu_with_guarded_quit, first_supported_opened_path, handle_macos_menu_event,
    register_macos_wake_observer, reveal_main_window, MacWakeObserver, NATIVE_OPEN_AVAILABLE_EVENT,
};
use native_lifecycle::{exit_after_guarded_quit, take_pending_open_path, PendingOpenPath};
use snapshots::{
    clear_snapshot_history, get_snapshot_storage_stats, list_document_snapshots,
    list_snapshot_drafts, read_document_snapshot, retire_snapshot_draft, write_document_snapshot,
};
use workspace::list_workspace_markdown_files;

#[cfg(target_os = "macos")]
fn keep_wake_observer_or_continue(
    registration: Result<MacWakeObserver, std::io::Error>,
) -> Option<MacWakeObserver> {
    match registration {
        Ok(observer) => Some(observer),
        Err(error) => {
            log::error!("Failed to register the macOS wake observer: {error}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pending_open_path = Arc::new(PendingOpenPath::default());

    #[cfg(any(windows, target_os = "linux"))]
    if let Some(path) = initial_cli_open_path() {
        let accepted = pending_open_path.replace_if_supported(path);
        debug_assert!(accepted);
    }

    let builder = tauri::Builder::default()
        .plugin(navigation::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&pending_open_path))
        .invoke_handler(tauri::generate_handler![
            read_markdown_file,
            resolve_markdown_path,
            open_markdown_file,
            // Keep simple write API for non-editor callsites.
            write_markdown_file,
            write_markdown_file_if_unmodified,
            export_html_file,
            open_markdown_file_externally,
            read_image_file_as_base64,
            export_markdown_file,
            take_pending_open_path,
            exit_after_guarded_quit,
            watch_file,
            unwatch_file,
            list_workspace_markdown_files,
            write_document_snapshot,
            list_document_snapshots,
            read_document_snapshot,
            list_snapshot_drafts,
            get_snapshot_storage_stats,
            retire_snapshot_draft,
            clear_snapshot_history
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(window_state_flags())
                    .build(),
            )?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.manage(FileWatcher::new());

            Ok(())
        });

    // The predefined macOS Quit item terminates through AppKit without any
    // frontend event, which would bypass the unsaved-change guard. Install a
    // menu whose Quit item routes through the guard instead. On other
    // platforms no menu is installed, matching the previous behavior.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(default_menu_with_guarded_quit)
        .on_menu_event(handle_macos_menu_event);

    let app = builder.build(tauri::generate_context!());

    match app {
        Ok(app) => {
            #[cfg(target_os = "macos")]
            let mut runtime_ready = false;
            #[cfg(target_os = "macos")]
            let mut _wake_observer = None;

            app.run(move |app_handle, event| {
                #[cfg(target_os = "macos")]
                match event {
                    tauri::RunEvent::Ready => {
                        runtime_ready = true;
                        _wake_observer = keep_wake_observer_or_continue(
                            register_macos_wake_observer(app_handle),
                        );
                    }
                    tauri::RunEvent::Reopen { .. } => {
                        // Clicking the Dock icon brings the hidden or minimized
                        // main window back; the app keeps running after close.
                        reveal_main_window(app_handle);
                    }
                    tauri::RunEvent::Opened { urls } => {
                        let Some(path) = first_supported_opened_path(&urls) else {
                            return;
                        };
                        let accepted = pending_open_path.replace_if_supported(path);
                        debug_assert!(accepted);

                        if runtime_ready {
                            reveal_main_window(app_handle);
                            if let Err(error) = app_handle.emit_to(
                                "main",
                                NATIVE_OPEN_AVAILABLE_EVENT,
                                (),
                            ) {
                                log::warn!(
                                    "Failed to notify the frontend of a native open request: {error}"
                                );
                            }
                        }
                    }
                    _ => {}
                }

                #[cfg(not(target_os = "macos"))]
                let _ = (app_handle, event);
            });
        }
        Err(error) => {
            eprintln!("error while building tauri application: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn wake_observer_setup_failure_returns_no_observer() {
        let observer = super::keep_wake_observer_or_continue(Err(std::io::Error::other(
            "wake observer unavailable",
        )));

        assert!(observer.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn cli_open_preserves_a_supported_symlink_path_for_normal_open_validation() {
        use crate::document_io::open_markdown_file_impl;
        use crate::native_lifecycle::{cli_open_path_from_args, PendingOpenPath};
        use crate::test_support::{cleanup_temp_path, unique_temp_path};
        use std::fs;
        use std::os::unix::fs::symlink;
        use std::path::{Path, PathBuf};

        fn temp_path(ext: &str) -> PathBuf {
            unique_temp_path(ext)
        }

        fn cleanup(path: &Path) {
            cleanup_temp_path(path);
        }

        let unsupported_target = temp_path("txt");
        let supported_link = temp_path("md");
        fs::write(&unsupported_target, "not supported").expect("write CLI symlink target");
        symlink(&unsupported_target, &supported_link).expect("create supported CLI symlink");
        let args = [
            std::ffi::OsString::from("bindars"),
            supported_link.clone().into_os_string(),
        ];

        let selected = cli_open_path_from_args(args).expect("select supported CLI link");
        assert_eq!(selected, supported_link);

        let pending = PendingOpenPath::default();
        assert!(pending.replace_if_supported(selected));
        let delivered = pending.take().expect("deliver supported CLI link");
        let error = open_markdown_file_impl(delivered.to_string_lossy().into_owned())
            .expect_err("unsupported canonical target should reach normal open validation");
        assert!(error.contains("Not a supported file type"));

        cleanup(&supported_link);
        cleanup(&unsupported_target);
    }
}
