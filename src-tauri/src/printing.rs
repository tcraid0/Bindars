//! Printing is restricted to the invoking main webview. No document or output
//! paths cross this boundary; the native sheet owns destination selection.

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrintOutcome {
    Completed,
    CancelledOrFailed,
}

fn validate_caller(label: &str, local: bool) -> Result<(), String> {
    if label != "main" || !local {
        return Err("Printing is only available in the local main reader.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn print_current_webview(webview: tauri::Webview) -> Result<PrintOutcome, String> {
    let url = webview.url().map_err(|e| e.to_string())?;
    let local = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    #[cfg(debug_assertions)]
    let local = {
        use tauri::Manager;
        local
            || webview
                .app_handle()
                .config()
                .build
                .dev_url
                .as_ref()
                .is_some_and(|dev| dev.origin() == url.origin())
    };
    validate_caller(webview.label(), local)?;
    #[cfg(target_os = "macos")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        webview
            .with_webview(move |platform| {
                if let Err(error) = macos::start(platform, sender.clone()) {
                    let _ = sender.try_send(Err(error));
                }
            })
            .map_err(|e| format!("Couldn't request printing: {e}"))?;
        // This result comes from the sheet completion delegate, not dispatch.
        receiver
            .recv()
            .await
            .ok_or("The native print operation disconnected.")?
    }
    #[cfg(not(target_os = "macos"))]
    Err("Use the browser print command on this platform.".into())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::PrintOutcome;
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, sel, AnyThread, Message};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSWindow};
    use objc2_foundation::{MainThreadMarker, NSCopying, NSObject, NSObjectProtocol};
    use objc2_web_kit::WKWebView;
    use std::{cell::RefCell, ffi::c_void};

    // Keep synchronized with @page margin: 2cm in src/app.css. AppKit uses points.
    const PRINT_MARGIN_POINTS: f64 = 2.0 / 2.54 * 72.0;
    type Sender = tauri::async_runtime::Sender<Result<PrintOutcome, String>>;

    struct ActivePrint {
        _view: Retained<WKWebView>,
        _window: Retained<NSWindow>,
        _info: Retained<NSPrintInfo>,
        _operation: Retained<NSPrintOperation>,
        _delegate: Retained<PrintDelegate>,
        sender: Sender,
    }

    thread_local! {
        // Created and released exclusively on AppKit's main thread.
        static ACTIVE: RefCell<Option<ActivePrint>> = const { RefCell::new(None) };
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. This stateless
        // delegate can be called on AppKit's print worker. It only dispatches
        // a boolean result; native objects remain owned by the main thread.
        #[unsafe(super = NSObject)]
        #[thread_kind = AnyThread]
        struct PrintDelegate;
        unsafe impl NSObjectProtocol for PrintDelegate {}
        impl PrintDelegate {
            // Public NSPrintOperation completion selector signature.
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, operation: &NSPrintOperation, success: bool, _context: *mut c_void) {
                // AppKit may run this on its print worker. The main-queue block
                // below is the only place ACTIVE is released, and it cannot run
                // before this callback dispatches it, so these references are
                // taken while the objects are certainly alive. They keep the
                // delegate and operation alive until this callback returns,
                // whatever AppKit itself retains.
                let _delegate = self.retain();
                let _operation = operation.retain();
                dispatch2::DispatchQueue::main().exec_async(move || {
                    let active = ACTIVE.with(|slot| slot.borrow_mut().take());
                    if let Some(active) = active {
                        let outcome = if success { PrintOutcome::Completed } else { PrintOutcome::CancelledOrFailed };
                        let _ = active.sender.try_send(Ok(outcome));
                    }
                });
            }
        }
    );

    pub(super) fn start(
        platform: tauri::webview::PlatformWebview,
        sender: Sender,
    ) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("Printing requires the main thread.")?;
        if ACTIVE.with(|slot| slot.borrow().is_some())
            || NSPrintOperation::currentOperation(mtm).is_some()
        {
            return Err("A print operation is already active.".into());
        }
        // SAFETY: Tauri supplies this WKWebView on the main thread. Retain it
        // before the closure returns, and retain its own window for the sheet.
        unsafe {
            let view = Retained::retain(platform.inner().cast::<WKWebView>())
                .ok_or("The reader webview is unavailable.")?;
            let window = view.window().ok_or("The reader window is unavailable.")?;
            if !view.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
                return Err("Native printing is unavailable on this system.".into());
            }
            let info = NSPrintInfo::sharedPrintInfo().copy();
            info.setTopMargin(PRINT_MARGIN_POINTS);
            info.setBottomMargin(PRINT_MARGIN_POINTS);
            info.setLeftMargin(PRINT_MARGIN_POINTS);
            info.setRightMargin(PRINT_MARGIN_POINTS);
            // Apple's public API permits nil when printing is unsupported.
            let operation: Option<Retained<NSPrintOperation>> =
                msg_send![&view, printOperationWithPrintInfo: &*info];
            let operation = operation.ok_or("Couldn't create the native print operation.")?;
            // WKWebView needs AppKit's asynchronous print path to render page
            // content. The synchronous path can produce correctly counted but
            // blank pages. The delegate must therefore accept worker callbacks.
            operation.setCanSpawnSeparateThread(true);
            let delegate: Retained<PrintDelegate> = msg_send![PrintDelegate::alloc(), init];
            ACTIVE.with(|slot| {
                *slot.borrow_mut() = Some(ActivePrint {
                    _view: view,
                    _window: window.clone(),
                    _info: info,
                    _operation: operation.clone(),
                    _delegate: delegate.clone(),
                    sender,
                })
            });
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn native_margin_matches_two_centimeters() {
            assert!((super::PRINT_MARGIN_POINTS - 56.69291338582677).abs() < 1e-10);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn printing_rejects_other_views_and_remote_content() {
        assert!(super::validate_caller("main", true).is_ok());
        assert!(super::validate_caller("other", true).is_err());
        assert!(super::validate_caller("main", false).is_err());
    }
}
