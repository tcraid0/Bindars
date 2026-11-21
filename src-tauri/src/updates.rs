//! Update check and install. macOS only; on other platforms the commands
//! exist but do nothing. An automatic check sends nothing unless the saved
//! setting `updates:auto-check` is true. That decision is made here.
use serde::Serialize;

#[cfg(target_os = "macos")]
const AUTO_CHECK_KEY: &str = "updates:auto-check";
#[cfg(target_os = "macos")]
const LAST_CHECK_KEY: &str = "updates:last-check";
#[cfg(any(target_os = "macos", test))]
const DAY_SECONDS: u64 = 24 * 60 * 60;
#[cfg(any(target_os = "macos", test))]
const DOWNLOAD_PREFIX: &str = "https://github.com/tcraid0/Bindars/releases/download/";

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum UpdateCheck {
    Skipped,
    UpToDate {
        current: String,
    },
    Available {
        current: String,
        version: String,
        installable: bool,
    },
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) enum UpdateError {
    Busy,
    Failed { detail: String },
    PreviousAppKept { path: String },
}

/// True when an automatic check may run now: the saved setting must be
/// exactly `true`, and either no check has been recorded yet, a day has
/// passed, or the clock moved backwards.
#[cfg(any(target_os = "macos", test))]
fn automatic_check_due(
    enabled: Option<&serde_json::Value>,
    last_check: Option<&serde_json::Value>,
    now: u64,
) -> bool {
    if enabled != Some(&serde_json::Value::Bool(true)) {
        return false;
    }
    let Some(serde_json::Value::Number(last)) = last_check else {
        return true;
    };
    let Some(last) = last.as_u64() else {
        return true;
    };
    if last > now {
        return true;
    }
    now - last >= DAY_SECONDS
}

/// False when the app cannot be replaced where it is: a translocated copy is
/// read-only and a disk-image copy lives on a read-only volume.
#[cfg(any(target_os = "macos", test))]
fn installable_location(executable: &std::path::Path) -> bool {
    let path = executable.to_string_lossy();
    if path.contains("/AppTranslocation/") {
        return false;
    }
    if path.starts_with("/Volumes/") {
        return false;
    }
    true
}

/// True when the download address is on the Bindars release page.
#[cfg(any(target_os = "macos", test))]
fn allowed_download_url(url: &str) -> bool {
    url.starts_with(DOWNLOAD_PREFIX)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{allowed_download_url, automatic_check_due, installable_location};
    use super::{UpdateCheck, UpdateError, AUTO_CHECK_KEY, LAST_CHECK_KEY};
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;

    #[derive(Default)]
    pub(crate) struct Updates {
        busy: std::sync::atomic::AtomicBool,
        found: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
        package: std::sync::Mutex<Option<Vec<u8>>>,
    }

    /// Releases the busy flag on every exit path, including errors and the
    /// cancellation of an awaiting command.
    struct BusyGuard<'a> {
        flag: &'a std::sync::atomic::AtomicBool,
    }

    impl Drop for BusyGuard<'_> {
        fn drop(&mut self) {
            self.flag.store(false, std::sync::atomic::Ordering::Release);
        }
    }

    /// Sets the busy flag from false to true, or reports `Busy` when another
    /// update operation is already running.
    fn take_busy(flag: &std::sync::atomic::AtomicBool) -> Result<BusyGuard<'_>, UpdateError> {
        flag.compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::Acquire,
            std::sync::atomic::Ordering::Relaxed,
        )
        .map(|_| BusyGuard { flag })
        .map_err(|_| UpdateError::Busy)
    }

    fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn failed(error: tauri_plugin_updater::Error) -> UpdateError {
        UpdateError::Failed {
            detail: error.to_string(),
        }
    }

    fn now_seconds() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    }

    /// Runs `request` only when a check is allowed: one update operation at a
    /// time, and an automatic check only with saved consent and a day since
    /// the last one. `None` means the request was never started, so nothing
    /// was sent. Every network request of a check goes through `request`.
    async fn admitted<T, F, Fut>(
        updates: &Updates,
        settings: &crate::settings::Settings,
        manual: bool,
        now: u64,
        request: F,
    ) -> Result<Option<T>, UpdateError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, UpdateError>>,
    {
        let _busy = take_busy(&updates.busy)?;
        let enabled = settings.get(AUTO_CHECK_KEY).ok().flatten();
        let last_check = settings.get(LAST_CHECK_KEY).ok().flatten();
        if !manual && !automatic_check_due(enabled.as_ref(), last_check.as_ref(), now) {
            return Ok(None);
        }
        request().await.map(Some)
    }

    pub(crate) async fn check(
        app: tauri::AppHandle,
        manual: bool,
    ) -> Result<UpdateCheck, UpdateError> {
        let state = app.state::<Updates>();
        let settings = app.state::<crate::settings::Settings>();
        let now = now_seconds();
        let checked = admitted(&state, &settings, manual, now, || {
            request_check(app.clone(), now)
        })
        .await?;
        Ok(checked.unwrap_or(UpdateCheck::Skipped))
    }

    async fn request_check(app: tauri::AppHandle, now: u64) -> Result<UpdateCheck, UpdateError> {
        let state = app.state::<Updates>();
        let updater = app
            .updater_builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(failed)?;
        let found = updater.check().await.map_err(failed)?;

        // Only an answered check counts toward the daily limit, so one failed
        // request does not postpone the next automatic check by a day. The
        // write replaces the settings file; keep it off the async workers.
        let writer = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = writer
                .state::<crate::settings::Settings>()
                .set(LAST_CHECK_KEY.to_string(), serde_json::json!(now));
        })
        .await;

        let current = app.package_info().version.to_string();
        let Some(update) = found else {
            *lock(&state.found) = None;
            *lock(&state.package) = None;
            return Ok(UpdateCheck::UpToDate { current });
        };

        if !allowed_download_url(update.download_url.as_str()) {
            return Err(UpdateError::Failed {
                detail: "unexpected download address".into(),
            });
        }
        let installable = std::env::current_exe()
            .map(|executable| installable_location(&executable))
            .unwrap_or(false);
        let version = update.version.clone();
        *lock(&state.found) = Some(update);
        *lock(&state.package) = None;
        Ok(UpdateCheck::Available {
            current,
            version,
            installable,
        })
    }

    pub(crate) async fn download(app: tauri::AppHandle) -> Result<(), UpdateError> {
        let state = app.state::<Updates>();
        let _busy = take_busy(&state.busy)?;

        if lock(&state.package).is_some() {
            return Ok(());
        }
        let found = lock(&state.found).clone();
        let Some(mut update) = found else {
            return Err(UpdateError::Failed {
                detail: "no update to download".into(),
            });
        };

        update.timeout = Some(std::time::Duration::from_secs(600));

        let mut downloaded: u64 = 0;
        let mut reported: u64 = 0;
        let emitter = app.clone();
        let bytes = update
            .download(
                move |chunk_len, total| {
                    downloaded += chunk_len as u64;
                    if downloaded - reported >= 262144 {
                        reported = downloaded;
                        use tauri::Emitter;
                        let _ = emitter.emit_to(
                            "main",
                            "bindars://update-progress",
                            serde_json::json!({ "downloaded": downloaded, "total": total }),
                        );
                    }
                },
                || {},
            )
            .await
            .map_err(failed)?;
        *lock(&state.package) = Some(bytes);
        Ok(())
    }

    pub(crate) async fn install_and_restart(app: tauri::AppHandle) -> Result<(), UpdateError> {
        let state = app.state::<Updates>();
        let _busy = take_busy(&state.busy)?;

        let found = lock(&state.found).clone();
        let bytes = lock(&state.package).take();
        let (Some(update), Some(bytes)) = (found, bytes) else {
            return Err(UpdateError::Failed {
                detail: "no downloaded update".into(),
            });
        };

        // The install can wait on a password prompt, so it must not run on
        // the main thread. The package comes back with the result so a failed
        // attempt can be retried without downloading again.
        let (installed, bytes) = tauri::async_runtime::spawn_blocking(move || {
            let installed = update.install(&bytes);
            (installed, bytes)
        })
        .await
        .map_err(|error| UpdateError::Failed {
            detail: error.to_string(),
        })?;

        match installed {
            Ok(()) => {
                app.request_restart();
                Ok(())
            }
            Err(error) => {
                *lock(&state.package) = Some(bytes);
                Err(match error {
                    tauri_plugin_updater::Error::PreviousAppNotRestored(path) => {
                        UpdateError::PreviousAppKept {
                            path: path.display().to_string(),
                        }
                    }
                    error => failed(error),
                })
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{admitted, Updates};
        use crate::settings::Settings;
        use crate::updates::{UpdateError, AUTO_CHECK_KEY, LAST_CHECK_KEY};
        use std::sync::atomic::{AtomicUsize, Ordering};

        const NOW: u64 = 1_700_000_000;

        fn settings(values: serde_json::Value) -> Settings {
            let serde_json::Value::Object(values) = values else {
                panic!("settings fixture must be an object");
            };
            let settings = Settings::default();
            settings.load(std::path::Path::new("/nonexistent/settings.json"), values);
            settings
        }

        /// Counts how many times a check reached the point of sending.
        fn requests(updates: &Updates, settings: &Settings, manual: bool) -> usize {
            let sent = AtomicUsize::new(0);
            let outcome = tauri::async_runtime::block_on(admitted(
                updates,
                settings,
                manual,
                NOW,
                || async {
                    sent.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            ));
            assert!(outcome.is_ok());
            sent.load(Ordering::SeqCst)
        }

        #[test]
        fn an_automatic_check_sends_nothing_without_saved_consent() {
            let updates = Updates::default();
            assert_eq!(
                requests(&updates, &settings(serde_json::json!({})), false),
                0
            );
            assert_eq!(
                requests(
                    &updates,
                    &settings(serde_json::json!({ AUTO_CHECK_KEY: false })),
                    false
                ),
                0
            );
            assert_eq!(
                requests(
                    &updates,
                    &settings(serde_json::json!({ AUTO_CHECK_KEY: "true" })),
                    false
                ),
                0
            );
        }

        #[test]
        fn an_automatic_check_with_consent_sends_at_most_once_a_day() {
            let updates = Updates::default();
            let recent =
                settings(serde_json::json!({ AUTO_CHECK_KEY: true, LAST_CHECK_KEY: NOW - 3600 }));
            assert_eq!(requests(&updates, &recent, false), 0);
            let due = settings(serde_json::json!({ AUTO_CHECK_KEY: true }));
            assert_eq!(requests(&updates, &due, false), 1);
        }

        #[test]
        fn a_manual_check_sends_whatever_the_setting_says() {
            let updates = Updates::default();
            assert_eq!(
                requests(&updates, &settings(serde_json::json!({})), true),
                1
            );
        }

        #[test]
        fn a_second_operation_is_refused_while_one_runs_and_admitted_afterwards() {
            let updates = Updates::default();
            let none = settings(serde_json::json!({}));
            let sent = AtomicUsize::new(0);
            let outcome =
                tauri::async_runtime::block_on(admitted(&updates, &none, true, NOW, || async {
                    // A second operation arrives while the first is in flight.
                    let second = admitted(&updates, &none, true, NOW, || async {
                        sent.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await;
                    assert_eq!(second, Err(UpdateError::Busy));
                    Ok(())
                }));
            assert_eq!(outcome, Ok(Some(())));
            assert_eq!(sent.load(Ordering::SeqCst), 0);
            // The first operation released the flag when it finished.
            assert_eq!(requests(&updates, &none, true), 1);
        }
    }
}

#[tauri::command]
pub(crate) async fn check_for_update(
    app: tauri::AppHandle,
    manual: bool,
) -> Result<UpdateCheck, UpdateError> {
    #[cfg(target_os = "macos")]
    {
        mac::check(app, manual).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, manual);
        Ok(UpdateCheck::Skipped)
    }
}

#[tauri::command]
pub(crate) async fn download_update(app: tauri::AppHandle) -> Result<(), UpdateError> {
    #[cfg(target_os = "macos")]
    {
        mac::download(app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn install_update_and_restart(app: tauri::AppHandle) -> Result<(), UpdateError> {
    #[cfg(target_os = "macos")]
    {
        mac::install_and_restart(app).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use mac::Updates;

#[cfg(test)]
mod tests {
    use super::{allowed_download_url, automatic_check_due, installable_location};
    use super::{UpdateCheck, UpdateError};

    #[test]
    fn automatic_check_requires_the_saved_setting_and_a_daily_interval() {
        let now: u64 = 1_700_000_000;
        // The setting is missing.
        assert!(!automatic_check_due(None, None, now));
        // The setting is false.
        assert!(!automatic_check_due(
            Some(&serde_json::json!(false)),
            None,
            now
        ));
        // The setting is true and no check has been recorded yet.
        assert!(automatic_check_due(
            Some(&serde_json::json!(true)),
            None,
            now
        ));
        // The setting is true and the last check was one hour ago.
        assert!(!automatic_check_due(
            Some(&serde_json::json!(true)),
            Some(&serde_json::json!(now - 3600)),
            now
        ));
        // The setting is true and the last check was 25 hours ago.
        assert!(automatic_check_due(
            Some(&serde_json::json!(true)),
            Some(&serde_json::json!(now - 25 * 3600)),
            now
        ));
        // The setting is true and the last check is in the future.
        assert!(automatic_check_due(
            Some(&serde_json::json!(true)),
            Some(&serde_json::json!(now + 100)),
            now
        ));
    }

    #[test]
    fn only_ordinary_application_locations_are_installable() {
        assert!(installable_location(std::path::Path::new(
            "/Applications/Bindars.app/Contents/MacOS/bindars"
        )));
        assert!(!installable_location(std::path::Path::new(
            "/Volumes/Bindars/Bindars.app/Contents/MacOS/bindars"
        )));
        assert!(!installable_location(std::path::Path::new(
            "/private/var/folders/ab/T/AppTranslocation/123/d/Bindars.app/Contents/MacOS/bindars"
        )));
    }

    #[test]
    fn download_addresses_must_stay_on_the_bindars_release_page() {
        assert!(allowed_download_url(
            "https://github.com/tcraid0/Bindars/releases/download/v1.6.5/Bindars.app.tar.gz"
        ));
        assert!(!allowed_download_url(
            "https://example.com/Bindars.app.tar.gz"
        ));
        assert!(!allowed_download_url(
            "https://github.com/someone-else/Bindars/releases/download/v1/x.tar.gz"
        ));
    }

    #[test]
    fn results_serialize_with_a_kind_tag() {
        assert_eq!(
            serde_json::to_value(UpdateCheck::Skipped).unwrap(),
            serde_json::json!({ "kind": "skipped" })
        );
        assert_eq!(
            serde_json::to_value(UpdateError::PreviousAppKept { path: "/x".into() }).unwrap(),
            serde_json::json!({ "kind": "previous-app-kept", "path": "/x" })
        );
    }
}
