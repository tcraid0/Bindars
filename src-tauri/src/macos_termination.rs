//! Route AppKit termination (Dock Quit, logout, shutdown) through the same
//! asynchronous save guard as the application's Quit menu.
use std::io;
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};

static REQUEST_QUIT: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

extern "C-unwind" fn application_should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _application: &NSApplication,
) -> NSApplicationTerminateReply {
    // Cancel first rather than entering AppKit's nested modal loop with
    // NSTerminateLater: our decision UI and file writes need the normal event
    // loop. The authorized continuation exits through Tauri's app.exit().
    // A logout may consequently need to be requested again after Bindars quits.
    dispatch2::DispatchQueue::main().exec_async(|| {
        if let Some(request) = REQUEST_QUIT.get() {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(request)).is_err() {
                log::error!("Failed to request guarded macOS termination; keeping the app open");
            }
        }
    });
    NSApplicationTerminateReply::TerminateCancel
}

pub(crate) fn install(request_quit: impl Fn() + Send + Sync + 'static) -> io::Result<()> {
    let mtm = MainThreadMarker::new().ok_or_else(|| {
        io::Error::other("The macOS quit guard must be installed on the main thread")
    })?;
    let application = NSApplication::sharedApplication(mtm);
    let delegate = application
        .delegate()
        .ok_or_else(|| io::Error::other("The macOS application delegate is missing"))?;
    let object: &AnyObject = (*delegate).as_ref();
    let class = object.class();
    let selector = sel!(applicationShouldTerminate:);
    // Tao 0.35 has no approval hook. Add only that missing method, preserving
    // its existing open/reopen/termination callbacks and the delegate itself.
    // Refuse a future upstream implementation instead of silently replacing it.
    if class.instance_method(selector).is_some() {
        return Err(io::Error::other(
            "The macOS delegate already handles termination approval",
        ));
    }
    REQUEST_QUIT
        .set(Box::new(request_quit))
        .map_err(|_| io::Error::other("The macOS quit guard was already initialized"))?;
    // SAFETY: the method has AppKit's NSUInteger-returning (id, SEL, id) ABI
    // on 64-bit macOS. Its callback lives for the process lifetime. Adding a
    // missing method is supported on registered classes; no method is swizzled.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            std::mem::transmute::<
                extern "C-unwind" fn(
                    &AnyObject,
                    Sel,
                    &NSApplication,
                ) -> NSApplicationTerminateReply,
                Imp,
            >(application_should_terminate),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err(io::Error::other(
            "Could not install the macOS termination approval hook",
        ));
    }
    // Refresh any cached optional delegate selectors after adding the method.
    application.setDelegate(Some(&delegate));
    Ok(())
}
