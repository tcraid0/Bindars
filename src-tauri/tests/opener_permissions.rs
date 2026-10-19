//! Exercise the installed opener's native IPC guard without opening any application.
use serde_json::json;

#[test]
fn unsupported_urls_are_rejected_by_the_native_opener_scope() {
    // Fail before invoking anything if a regression could launch an external app.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert!(config["app"]["security"]["capabilities"].is_null());
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut opener_grants = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        assert_eq!(path.extension().and_then(|ext| ext.to_str()), Some("json"));
        let capability: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        opener_grants.extend(
            capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|permission| {
                    permission
                        .as_str()
                        .or_else(|| permission["identifier"].as_str())
                        .is_some_and(|identifier| identifier.starts_with("opener:"))
                })
                .cloned(),
        );
    }
    assert_eq!(
        opener_grants,
        vec![json!({
            "identifier": "opener:allow-open-url",
            "allow": [{ "url": "http://*" }, { "url": "https://*" }, { "url": "mailto:*" }]
        })]
    );

    // MockRuntime avoids a real window; ACL resolution and the installed Rust
    // plugin command/scope implementation still execute. No frontend IPC mock.
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_opener::init())
        .build(tauri::generate_context!())
        .expect("build native permission test app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build mock webview");

    for url in [
        "tel:+15555550123",
        "sms:+15555550123",
        "file:///tmp/bindars-permission-test.md",
        "javascript:alert(1)",
        "data:text/plain,hello",
        "ftp://example.com/file",
        "bindars-test://example",
    ] {
        let response = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "plugin:opener|open_url".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: webview.url().expect("local test webview URL"),
                body: tauri::ipc::InvokeBody::Json(json!({ "url": url })),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        let error = response.expect_err("unsupported URL must not reach the OS opener");
        assert_eq!(error, json!(format!("Not allowed to open url {url}")));
    }
}
