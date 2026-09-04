use tauri::{plugin::TauriPlugin, Runtime, Url};

// Keep these origins aligned with tauri.conf.json and Tauri's pinned
// WebviewUrl::App resolution. Desktop development loads the configured devUrl.
// Mobile development is proxied through the same app origins used in packaged
// builds. `useHttpsScheme` is not enabled, so Windows and Android use HTTP.
#[cfg(all(dev, desktop))]
const INTERNAL_APP_ORIGIN: &str = "http://localhost:5173";
#[cfg(all(not(all(dev, desktop)), any(windows, target_os = "android")))]
const INTERNAL_APP_ORIGIN: &str = "http://tauri.localhost";
#[cfg(all(not(all(dev, desktop)), not(any(windows, target_os = "android"))))]
const INTERNAL_APP_ORIGIN: &str = "tauri://localhost";

fn has_same_origin(url: &Url, expected_origin: &Url) -> bool {
    url.scheme() == expected_origin.scheme()
        && url.host_str() == expected_origin.host_str()
        && url.port_or_known_default() == expected_origin.port_or_known_default()
}

fn is_internal_navigation(url: &Url) -> bool {
    Url::parse(INTERNAL_APP_ORIGIN)
        .is_ok_and(|expected_origin| has_same_origin(url, &expected_origin))
}

pub(crate) fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-boundary")
        .on_navigation(|_webview, url| is_internal_navigation(url))
        .build()
}

#[cfg(test)]
mod tests {
    use super::{has_same_origin, is_internal_navigation, INTERNAL_APP_ORIGIN};
    use tauri::Url;

    fn parse(url: &str) -> Url {
        Url::parse(url).unwrap_or_else(|error| panic!("invalid test URL {url}: {error}"))
    }

    #[test]
    fn current_internal_origin_allows_paths_queries_and_fragments() {
        let internal_url = format!("{INTERNAL_APP_ORIGIN}/assets/index.js?theme=dark#reader");

        assert!(is_internal_navigation(&parse(&internal_url)));
    }

    #[test]
    fn required_development_and_packaged_origins_are_exact() {
        let cases = [
            ("http://localhost:5173", "http://localhost:5173/document"),
            ("tauri://localhost", "tauri://localhost/document"),
            ("http://tauri.localhost", "http://tauri.localhost/document"),
        ];

        for (origin, candidate) in cases {
            assert!(has_same_origin(&parse(candidate), &parse(origin)));
        }

        assert!(!has_same_origin(
            &parse("http://127.0.0.1:5173/document"),
            &parse("http://localhost:5173"),
        ));
        assert!(!has_same_origin(
            &parse("http://localhost:5174/document"),
            &parse("http://localhost:5173"),
        ));
        assert!(!has_same_origin(
            &parse("https://tauri.localhost/document"),
            &parse("http://tauri.localhost"),
        ));
        assert!(!has_same_origin(
            &parse("tauri://remote/document"),
            &parse("tauri://localhost"),
        ));
    }

    #[test]
    fn arbitrary_remote_and_non_app_navigation_is_blocked() {
        for blocked_url in [
            "https://example.com/",
            "http://127.0.0.1:4174/r0-target.html",
            "asset://localhost/tmp/image.png",
            "file:///tmp/document.md",
            "data:text/html,remote",
        ] {
            assert!(
                !is_internal_navigation(&parse(blocked_url)),
                "unexpectedly allowed {blocked_url}",
            );
        }
    }
}
