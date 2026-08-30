use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

use crate::document_io::is_markdown_path;

#[cfg(target_os = "macos")]
pub(crate) const NATIVE_OPEN_AVAILABLE_EVENT: &str = "bindars://native-open-available";

#[cfg(target_os = "macos")]
const NATIVE_QUIT_REQUESTED_EVENT: &str = "bindars://quit-requested";

/// Identifier of the custom macOS Quit menu item that routes through the
/// frontend unsaved-change guard instead of AppKit's immediate termination.
#[cfg(target_os = "macos")]
const QUIT_MENU_ITEM_ID: &str = "bindars-quit";

/// One pending operating-system open request. A newer valid request replaces
/// the older one until the frontend atomically takes it.
#[derive(Default)]
pub(crate) struct PendingOpenPath(Mutex<Option<PathBuf>>);

impl PendingOpenPath {
    pub(crate) fn replace_if_supported(&self, path: PathBuf) -> bool {
        if !is_markdown_path(&path) {
            return false;
        }
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = Some(path);
        true
    }

    pub(crate) fn take(&self) -> Option<PathBuf> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
}

#[tauri::command]
pub(crate) fn take_pending_open_path(
    state: tauri::State<'_, Arc<PendingOpenPath>>,
) -> Option<String> {
    let path = state.take()?;
    match path.into_os_string().into_string() {
        Ok(path) => Some(path),
        Err(_) => {
            log::warn!(
                target: env!("CARGO_CRATE_NAME"),
                "Ignoring a native open path that is not valid UTF-8"
            );
            None
        }
    }
}

#[cfg(any(windows, target_os = "linux", test))]
pub(crate) fn cli_open_path_from_args(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Option<PathBuf> {
    let path = args.into_iter().nth(1).map(PathBuf::from)?;
    if !path.exists() || !is_markdown_path(&path) {
        return None;
    }

    let canonical_path = dunce::canonicalize(&path).ok()?;
    if is_markdown_path(&canonical_path) {
        return Some(canonical_path);
    }

    // Preserve a supported symlink path when its canonical target is not
    // supported. The normal open command then reports the same validation error
    // as macOS instead of the native intake silently dropping the launch.
    Some(path)
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn initial_cli_open_path() -> Option<PathBuf> {
    cli_open_path_from_args(std::env::args_os())
}

#[cfg(target_os = "macos")]
pub(crate) fn first_supported_opened_path(urls: &[tauri::Url]) -> Option<PathBuf> {
    let mut selected = None;
    let mut extra_supported = 0usize;

    for url in urls {
        if url.scheme() != "file" {
            log::warn!(
                target: env!("CARGO_CRATE_NAME"),
                "Ignoring native open URL with unsupported scheme '{}'",
                url.scheme()
            );
            continue;
        }

        let Ok(path) = url.to_file_path() else {
            log::warn!(
                target: env!("CARGO_CRATE_NAME"),
                "Ignoring native file URL that cannot be converted to a local path"
            );
            continue;
        };

        if !is_markdown_path(&path) {
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("<none>");
            log::warn!(
                target: env!("CARGO_CRATE_NAME"),
                "Ignoring native open path with unsupported extension '{}'",
                extension
            );
            continue;
        }

        if selected.is_none() {
            selected = Some(path);
        } else {
            extra_supported += 1;
        }
    }

    if extra_supported > 0 {
        log::info!(
            target: env!("CARGO_CRATE_NAME"),
            "Ignoring {extra_supported} additional supported native open path(s) from one event"
        );
    }

    selected
}

#[cfg(target_os = "macos")]
pub(crate) fn reveal_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!(
            target: env!("CARGO_CRATE_NAME"),
            "Cannot reveal the main window for a native open request"
        );
        return;
    };

    if let Err(error) = window.show() {
        log::warn!(
            target: env!("CARGO_CRATE_NAME"),
            "Failed to show the main window: {error}"
        );
    }
    if let Err(error) = window.unminimize() {
        log::warn!(
            target: env!("CARGO_CRATE_NAME"),
            "Failed to unminimize the main window: {error}"
        );
    }
    if let Err(error) = window.set_focus() {
        log::warn!(
            target: env!("CARGO_CRATE_NAME"),
            "Failed to focus the main window: {error}"
        );
    }
}

/// Window-state persistence flags. Visibility is deliberately excluded: a
/// window hidden through the macOS close guard must not relaunch invisibly
/// with no Dock-restore path. Size, position, maximized, fullscreen, and
/// decorations keep their useful restoration behavior.
#[cfg(desktop)]
pub(crate) fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE
}

#[cfg(target_os = "macos")]
fn is_predefined_quit_text(text: &str) -> bool {
    text.trim().to_ascii_lowercase().starts_with("quit")
}

/// Builds the default macOS menu with the predefined Quit item replaced by a
/// custom item. The predefined item terminates through AppKit
/// (`sel!(terminate:)`) without any Tauri or webview event, which would bypass
/// the frontend unsaved-change guard, so a replacement failure is an error
/// instead of a silent fallback to the data-loss path.
#[cfg(target_os = "macos")]
pub(crate) fn default_menu_with_guarded_quit(
    app: &tauri::AppHandle,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuItem, MenuItemKind};

    let menu = tauri::menu::Menu::default(app)?;
    let app_submenu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) => Some(submenu),
        _ => None,
    });
    let Some(app_submenu) = app_submenu else {
        return Err(std::io::Error::other("the default menu has no application submenu").into());
    };

    let predefined_quit = app_submenu
        .items()?
        .into_iter()
        .find_map(|item| match &item {
            MenuItemKind::Predefined(predefined) => {
                let Ok(text) = predefined.text() else {
                    return None;
                };
                if is_predefined_quit_text(&text) {
                    Some(item)
                } else {
                    None
                }
            }
            _ => None,
        });
    let Some(predefined_quit) = predefined_quit else {
        return Err(std::io::Error::other(
            "the default application submenu has no predefined Quit item",
        )
        .into());
    };
    app_submenu.remove(&predefined_quit)?;

    let quit_text = format!("Quit {}", app.package_info().name);
    let quit_item =
        MenuItem::with_id(app, QUIT_MENU_ITEM_ID, quit_text, true, Some("CmdOrCtrl+Q"))?;
    app_submenu.append(&quit_item)?;

    Ok(menu)
}

/// Forwards the custom Quit menu item to the frontend guard. The window is
/// revealed first so a resulting Save/Discard/Cancel dialog can never open in
/// a hidden window. The process exits only when the frontend guard completes
/// and invokes `exit_after_guarded_quit`.
#[cfg(target_os = "macos")]
pub(crate) fn handle_macos_menu_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    if event.id() != QUIT_MENU_ITEM_ID {
        return;
    }
    reveal_main_window(app);
    if let Err(error) = app.emit_to("main", NATIVE_QUIT_REQUESTED_EVENT, ()) {
        log::warn!(
            target: env!("CARGO_CRATE_NAME"),
            "Failed to notify the frontend of a quit request: {error}"
        );
    }
}

/// Exits the application. Reachable only through the frontend guard's
/// terminal continuation: nothing in this app prevents `ExitRequested`, so a
/// failed or cancelled guard can never reach this command.
#[tauri::command]
pub(crate) fn exit_after_guarded_quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::first_supported_opened_path;
    #[cfg(target_os = "macos")]
    use super::is_predefined_quit_text;
    #[cfg(desktop)]
    use super::window_state_flags;
    use super::{cli_open_path_from_args, PendingOpenPath};
    use crate::test_support::{cleanup_temp_path, unique_temp_path};
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn pending_open_path_is_one_shot_and_latest_valid_request_wins() {
        let pending = PendingOpenPath::default();
        assert!(pending.replace_if_supported(PathBuf::from("/tmp/first.md")));
        assert!(pending.replace_if_supported(PathBuf::from("/tmp/latest.markdown")));

        assert_eq!(pending.take(), Some(PathBuf::from("/tmp/latest.markdown")));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn unsupported_open_does_not_clear_a_pending_supported_path() {
        let pending = PendingOpenPath::default();
        assert!(pending.replace_if_supported(PathBuf::from("/tmp/keep.md")));
        assert!(!pending.replace_if_supported(PathBuf::from("/tmp/ignore.txt")));
        assert_eq!(pending.take(), Some(PathBuf::from("/tmp/keep.md")));
    }

    #[test]
    fn the_same_path_can_be_opened_again_in_a_later_event() {
        let pending = PendingOpenPath::default();
        let path = PathBuf::from("/tmp/reopen.md");
        assert!(pending.replace_if_supported(path.clone()));
        assert_eq!(pending.take(), Some(path.clone()));
        assert!(pending.replace_if_supported(path.clone()));
        assert_eq!(pending.take(), Some(path));
    }

    #[test]
    #[cfg(desktop)]
    fn window_state_persistence_excludes_visibility_but_keeps_useful_state() {
        use tauri_plugin_window_state::StateFlags;

        let flags = window_state_flags();

        // A window hidden through the macOS close guard must never relaunch
        // invisibly, so visibility is excluded from persistence.
        assert!(!flags.contains(StateFlags::VISIBLE));
        // Size, position, maximized, and fullscreen restoration stay useful.
        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(flags.contains(StateFlags::FULLSCREEN));
        assert!(flags.contains(StateFlags::DECORATIONS));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn predefined_quit_items_are_identified_by_text() {
        // muda titles the default macOS Quit item "Quit <app name>".
        assert!(is_predefined_quit_text("Quit Bindars"));
        assert!(is_predefined_quit_text("  quit io.github.tcraid0.bindars "));
        // Nothing else in the default application submenu starts with "quit":
        // About, Services, Hide, Hide Others, and separators never match.
        assert!(!is_predefined_quit_text("Hide Bindars"));
        assert!(!is_predefined_quit_text("Hide Others"));
        assert!(!is_predefined_quit_text("About Bindars"));
        assert!(!is_predefined_quit_text("Services"));
        assert!(!is_predefined_quit_text(""));
    }

    #[test]
    fn cli_open_uses_only_the_first_existing_supported_argument() {
        let first = temp_path("md");
        let second = temp_path("fountain");
        fs::write(&first, "# First").expect("write first CLI fixture");
        fs::write(&second, "Title: Second").expect("write second CLI fixture");
        let args = [
            std::ffi::OsString::from("bindars"),
            first.clone().into_os_string(),
            second.clone().into_os_string(),
        ];

        assert_eq!(
            cli_open_path_from_args(args),
            Some(dunce::canonicalize(&first).expect("canonical first CLI fixture"))
        );
        cleanup(&first);
        cleanup(&second);
    }

    #[test]
    fn cli_open_ignores_missing_and_unsupported_first_arguments() {
        let unsupported = temp_path("txt");
        fs::write(&unsupported, "not supported").expect("write unsupported CLI fixture");
        let unsupported_args = [
            std::ffi::OsString::from("bindars"),
            unsupported.clone().into_os_string(),
        ];
        let missing_args = [
            std::ffi::OsString::from("bindars"),
            temp_path("md").into_os_string(),
        ];

        assert_eq!(cli_open_path_from_args(unsupported_args), None);
        assert_eq!(cli_open_path_from_args(missing_args), None);
        cleanup(&unsupported);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_decode_unicode_and_spaces_without_requiring_the_file_to_exist() {
        let urls = [
            tauri::Url::parse("https://example.com/ignored.md").expect("remote URL"),
            tauri::Url::parse("file:///tmp/Caf%C3%A9%20Notes.md").expect("file URL"),
        ];

        assert_eq!(
            first_supported_opened_path(&urls),
            Some(PathBuf::from("/tmp/Café Notes.md"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_choose_the_first_supported_local_file() {
        let urls = [
            tauri::Url::parse("file:///tmp/ignored.txt").expect("unsupported file URL"),
            tauri::Url::parse("file:///tmp/first.fountain").expect("first supported URL"),
            tauri::Url::parse("file:///tmp/second.md").expect("second supported URL"),
        ];

        assert_eq!(
            first_supported_opened_path(&urls),
            Some(PathBuf::from("/tmp/first.fountain"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opened_urls_reject_remote_file_hosts() {
        let urls =
            [tauri::Url::parse("file://example.com/tmp/remote.md").expect("remote file URL")];
        assert_eq!(first_supported_opened_path(&urls), None);
    }

    fn temp_path(ext: &str) -> PathBuf {
        unique_temp_path(ext)
    }

    fn cleanup(path: &Path) {
        cleanup_temp_path(path);
    }
}
