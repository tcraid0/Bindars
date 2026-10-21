//! Audit capability inputs and resolved native URL scopes without an OS opener.
use serde_json::json;
use std::path::{Path, PathBuf};

fn permission_input_files(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !directory.exists() {
        return files;
    }
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(permission_input_files(&path));
            continue;
        }
        let extension = path.extension().and_then(|ext| ext.to_str());
        // Match Tauri's recursive discovery and exclusion of generated schemas.
        if directory.file_name().and_then(|name| name.to_str()) == Some("schemas")
            || !matches!(extension, Some("json" | "toml" | "json5"))
        {
            continue;
        }
        files.push(path);
    }
    files
}

fn assert_no_custom_permissions(directory: &Path) {
    assert!(
        permission_input_files(directory).is_empty(),
        "review custom permission definitions before granting them"
    );
}

fn opener_grants(directory: &Path) -> Vec<serde_json::Value> {
    let mut grants = Vec::new();
    for path in permission_input_files(directory) {
        let extension = path.extension().and_then(|ext| ext.to_str());
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
                .expect("review capability shape")
                .iter()
                .filter(|permission| {
                    let identifier = permission
                        .as_str()
                        .or_else(|| permission["identifier"].as_str())
                        .expect("review permission shape");
                    assert!(
                        ["core:", "dialog:", "opener:", "shell:"]
                            .iter()
                            .any(|prefix| identifier.starts_with(prefix)),
                        "review custom permission grant: {identifier}"
                    );
                    identifier.starts_with("opener:") || identifier.starts_with("shell:")
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
    let file = directory.join("nested/extra.json");
    for value in [
        json!([]),
        json!({"capabilities": []}),
        json!({"permissions": [null]}),
        json!({"permissions": [{}]}),
        json!({"permissions": ["default"]}),
        json!({"permissions": [{"identifier": "review-open-alias"}]}),
    ] {
        std::fs::write(&file, value.to_string()).unwrap();
        assert!(std::panic::catch_unwind(|| opener_grants(&directory)).is_err());
    }
    let permissions = directory.join("app-permissions");
    std::fs::create_dir_all(permissions.join("nested")).unwrap();
    for extension in ["json", "toml", "json5"] {
        let file = permissions.join(format!("nested/custom.{extension}"));
        std::fs::write(&file, "must be reviewed").unwrap();
        assert!(std::panic::catch_unwind(|| assert_no_custom_permissions(&permissions)).is_err());
        std::fs::remove_file(file).unwrap();
    }
}

#[test]
fn web_and_email_only_in_resolved_native_url_scopes() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert!(config["app"]["security"]["capabilities"].is_null());
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    assert_no_custom_permissions(&Path::new(env!("CARGO_MANIFEST_DIR")).join("permissions"));
    assert_eq!(
        opener_grants(&directory),
        vec![json!({
            "identifier": "opener:allow-open-url",
            "allow": [{ "url": "http://*" }, { "url": "https://*" }, { "url": "mailto:*" }]
        })]
    );

    // Tauri still resolves the built app ACL and command/global scopes. The
    // test-only handler has no opener implementation: even a broadened grant
    // cannot launch an OS application. The real plugin is never initialized.
    let app = tauri::test::mock_builder()
        .plugin(
            tauri::plugin::Builder::<tauri::test::MockRuntime>::new("opener")
                .invoke_handler(tauri::generate_handler![open_url])
                .build(),
        )
        .build(tauri::generate_context!())
        .expect("build native permission test app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build mock webview");

    for (url, allowed) in [
        ("http://example.com", true),
        ("https://example.com/page", true),
        ("mailto:reader@example.com", true),
        ("tel:+15555550123", false),
        ("sms:+15555550123", false),
        ("file:///tmp/bindars-permission-test.md", false),
        ("javascript:alert(1)", false),
        ("data:text/plain,hello", false),
        ("ftp://example.com/file", false),
        ("bindars-test://example", false),
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
        let actual: bool = response
            .expect("resolve native scope")
            .deserialize()
            .unwrap();
        assert_eq!(actual, allowed, "{url}");
    }
}

// Deliberately supports only the audited literal-prefix scope format. This is
// a side-effect-free policy probe, not a replacement for the opener command.
#[tauri::command]
fn open_url(
    command_scope: tauri::ipc::CommandScope<serde_json::Value>,
    global_scope: tauri::ipc::GlobalScope<serde_json::Value>,
    url: String,
) -> Result<bool, String> {
    let allow: Vec<_> = command_scope
        .allows()
        .iter()
        .chain(global_scope.allows())
        .map(|v| v.as_ref())
        .collect();
    let deny: Vec<_> = command_scope
        .denies()
        .iter()
        .chain(global_scope.denies())
        .collect();
    let expected = [
        json!({"url":"http://*"}),
        json!({"url":"https://*"}),
        json!({"url":"mailto:*"}),
    ];
    if !deny.is_empty()
        || allow.len() != expected.len()
        || !expected.iter().all(|v| allow.contains(&v))
    {
        return Err("review resolved opener scopes".into());
    }
    Ok(allow
        .iter()
        .any(|entry| url.starts_with(entry["url"].as_str().unwrap().strip_suffix('*').unwrap())))
}

#[test]
fn application_alias_is_rejected_and_resolves_to_opener_without_dispatch() {
    use std::collections::BTreeMap;
    use tauri::utils::acl::{
        capability::Capability,
        manifest::{Manifest, PermissionFile},
        resolved::Resolved,
        APP_ACL_KEY,
    };
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/opener-alias");
    assert!(std::panic::catch_unwind(|| opener_grants(&fixture.join("capabilities"))).is_err());
    assert!(std::panic::catch_unwind(|| assert_no_custom_permissions(
        &fixture.join("permissions")
    ))
    .is_err());
    let permission: PermissionFile = serde_json::from_str(include_str!(
        "../../tests/fixtures/opener-alias/permissions/nested/alias.json"
    ))
    .unwrap();
    let capability: Capability = serde_json::from_str(include_str!(
        "../../tests/fixtures/opener-alias/capabilities/nested/alias.json"
    ))
    .unwrap();
    let acl = BTreeMap::from([(
        APP_ACL_KEY.to_string(),
        Manifest::new(vec![permission], None),
    )]);
    let resolved = Resolved::resolve(
        &acl,
        BTreeMap::from([("review-alias".into(), capability)]),
        tauri::utils::platform::Target::MacOS,
    )
    .unwrap();
    let commands = &resolved.allowed_commands["plugin:opener|open_url"];
    assert_eq!(commands.len(), 1);
    let scope = &resolved.command_scope[&commands[0].scope_id.unwrap()];
    assert_eq!(
        serde_json::to_value(&scope.allow).unwrap(),
        json!([{"url":"tel:*"}])
    );
}
