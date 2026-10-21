//! Native regression for the production AppKit approval hook, using a separate
//! identity, no webview, no persistence plugins and no document access.
//! Run on macOS: cargo run --example macos_termination_probe --locked
//! Two AppKit termination attempts must return to the event loop; the third
//! simulates guard approval via app.exit(0). A watchdog makes failure nonzero.
#[cfg(target_os = "macos")]
#[path = "../src/macos_termination.rs"]
mod macos_termination;

#[cfg(target_os = "macos")]
fn main() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let requests = Arc::new(AtomicUsize::new(0));
    let (observed, acknowledgements) = std::sync::mpsc::channel();
    let mut acknowledgements = Some(acknowledgements);
    let count = requests.clone();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "local.bindars.termination-regression".into();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            macos_termination::install(move || {
                let request = count.fetch_add(1, Ordering::SeqCst) + 1;
                println!("Guard request {request}");
                observed.send(request).expect("probe driver");
                if request == 3 {
                    // This is the same terminal route as exit_after_guarded_quit.
                    handle.exit(0);
                }
            })?;
            Ok(())
        })
        .build(context)
        .expect("isolated native probe setup");
    let count = requests.clone();
    app.run(move |handle, event| match event {
        tauri::RunEvent::Ready => {
            let handle = handle.clone();
            let requests = requests.clone();
            let acknowledgements = acknowledgements.take().expect("one Ready event");
            std::thread::spawn(move || {
                for expected in 1..=3 {
                    std::thread::sleep(Duration::from_millis(150));
                    let requests = requests.clone();
                    handle
                        .run_on_main_thread(move || {
                            let mtm = MainThreadMarker::new().expect("main thread");
                            NSApplication::sharedApplication(mtm).terminate(None);
                            // The guard dispatch runs only after AppKit has
                            // returned to the event loop, just as in Bindars.
                            assert_eq!(requests.load(Ordering::SeqCst), expected - 1);
                            println!("AppKit returned after request {expected}");
                        })
                        .expect("schedule AppKit termination");
                    let observed = acknowledgements
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap_or_else(|_| {
                            eprintln!("FAIL: termination did not reach the guard");
                            std::process::exit(1);
                        });
                    assert_eq!(observed, expected);
                }
                std::thread::sleep(Duration::from_secs(5));
                eprintln!("FAIL: the authorized Tauri exit did not complete");
                std::process::exit(1);
            });
        }
        tauri::RunEvent::ExitRequested { .. } => {
            assert_eq!(count.load(Ordering::SeqCst), 3);
            println!("Authorized ExitRequested");
        }
        tauri::RunEvent::Exit => {
            assert_eq!(count.load(Ordering::SeqCst), 3);
            println!("PASS: two cancelled AppKit requests, then authorized Tauri exit");
        }
        _ => {}
    });
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The native termination probe requires macOS");
}
