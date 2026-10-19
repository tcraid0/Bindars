//! Exercise the installed opener's native IPC guard without opening any application.
use serde_json::json;
use std::path::{Path, PathBuf};

fn opener_grants(directory: &Path) -> Vec<serde_json::Value> {
    let mut grants = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            grants.extend(opener_grants(&path));
            continue;
        }
        let extension = path.extension().and_then(|ext| ext.to_str());
        // Match Tauri's recursive discovery and exclusion of generated schemas.
        if directory.file_name().and_then(|name| name.to_str()) == Some("schemas")
            || !matches!(extension, Some("json" | "toml" | "json5"))
        {
            continue;
        }
        assert_eq!(
            extension,
            Some("json"),
            "review capability format: {path:?}"
        );
        let capability: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        grants.extend(
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
    grants
}

#[test]
fn capability_discovery_ignores_unrelated_files_and_checks_nested_capabilities() {
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let directory = std::env::temp_dir().join(format!(
        "bindars-capabilities-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let _fixture = Fixture(directory.clone());
    std::fs::create_dir(directory.join("nested")).unwrap();
    std::fs::create_dir(directory.join("schemas")).unwrap();
    for file in [
        ".DS_Store",
        "README.md",
        "nested/ignored.JSON",
        "schemas/schema.json",
    ] {
        std::fs::write(directory.join(file), "not a capability").unwrap();
    }
    std::fs::write(
        directory.join("nested/extra.json"),
        json!({ "permissions": ["core:event:allow-listen", "opener:allow-default-urls"] })
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        opener_grants(&directory),
        vec![json!("opener:allow-default-urls")]
    );
    for extension in ["toml", "json5"] {
        let file = directory.join(format!("nested/extra.{extension}"));
        std::fs::write(&file, "must be reviewed").unwrap();
        let error = std::panic::catch_unwind(|| opener_grants(&directory))
            .expect_err("new capability formats must require review");
        let message = error.downcast_ref::<String>().unwrap();
        assert!(message.contains("review capability format"), "{message}");
        std::fs::remove_file(file).unwrap();
    }
}

#[test]
fn unsupported_urls_are_rejected_by_the_native_opener_scope() {
    // Fail before invoking anything if a regression could launch an external app.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert!(config["app"]["security"]["capabilities"].is_null());
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    assert_eq!(
        opener_grants(&directory),
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
