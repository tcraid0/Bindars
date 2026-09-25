use cap_fs_ext::{DirExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use tauri::http::{header, HeaderValue, Method, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;

use crate::document_io::canonicalize_markdown_path;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ImageError {
    OutsideDocument,
    Unavailable,
    TooLarge,
    Unsupported,
}

#[derive(Debug)]
pub(crate) struct DocumentImage {
    mime_type: String,
    bytes: Vec<u8>,
}

/// The document the frontend has accepted and is displaying. An image URL
/// carries a document path of its own, but that is only a claim: the protocol
/// serves a folder solely when the claim equals this session state, so
/// content that mints its own URLs (Mermaid image nodes, for example) cannot
/// choose another folder. Only the frontend's accepted-publication boundary
/// updates it; native reads that never publish (workspace indexing, cancelled
/// or superseded opens, stale reconciliation) leave it untouched.
#[derive(Debug, Default)]
pub(crate) struct AuthorizedDocument(Mutex<Option<PathBuf>>);

impl AuthorizedDocument {
    pub(crate) fn current(&self) -> Option<PathBuf> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn replace(&self, document: Option<PathBuf>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = document;
    }
}

/// `path` is the published canonical document path, or `None` for a virtual
/// draft, which authorizes nothing. The frontend serializes these calls so a
/// late call cannot overwrite a newer document's authorization.
#[tauri::command]
pub(crate) fn authorize_document_images(
    authorized: tauri::State<'_, AuthorizedDocument>,
    path: Option<String>,
) {
    authorized.replace(path.map(PathBuf::from));
}

/// Serve only bounded image bytes. The browser owns lazy loading and print
/// readiness, while this protocol owns all filesystem access. `authorized` is
/// the session's accepted document at request time; requests naming any other
/// document are refused before the filesystem is consulted.
pub(crate) fn protocol_response(
    request: Request<Vec<u8>>,
    authorized: Option<&Path>,
) -> Response<Vec<u8>> {
    let result = if request.method() != Method::GET {
        Err(StatusCode::METHOD_NOT_ALLOWED)
    } else {
        decode_image_request(request.uri().path(), request.uri().query())
            .map_err(|_| StatusCode::BAD_REQUEST)
            .and_then(|(document, image)| {
                // Exact match against the accepted path, not a canonicalized
                // one: the frontend already publishes the native canonical
                // path, and touching the filesystem for an unaccepted claim
                // would let content probe folders it may not read.
                if authorized != Some(Path::new(&document)) {
                    return Err(StatusCode::FORBIDDEN);
                }
                read_document_image_impl(Path::new(&document), Path::new(&image)).map_err(|error| {
                    match error {
                        ImageError::OutsideDocument => StatusCode::FORBIDDEN,
                        ImageError::Unavailable => StatusCode::NOT_FOUND,
                        ImageError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
                        ImageError::Unsupported => StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    }
                })
            })
    };
    let mut response = match result {
        Ok(image) => {
            let mut response = Response::new(image.bytes);
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&image.mime_type)
                    .unwrap_or(HeaderValue::from_static("application/octet-stream")),
            );
            response
        }
        Err(status) => {
            let mut response = Response::new(Vec::new());
            *response.status_mut() = status;
            response
        }
    };
    // Re-read through the confined handle when a document is reopened, rather
    // than retaining obsolete bytes when a path is replaced or becomes invalid.
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn decode_image_request(path: &str, query: Option<&str>) -> Result<(String, String), ()> {
    if query.is_some() || path.len() > 64 * 1024 {
        return Err(());
    }
    let encoded = path.strip_prefix('/').ok_or(())?;
    let decoded = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| ())?;
    serde_json::from_str(&decoded).map_err(|_| ())
}

struct ConfinedImage {
    directory: Dir,
    relative_path: PathBuf,
}

fn open_canonical_directory(path: &Path) -> Result<Dir, ImageError> {
    if !path.is_absolute() {
        return Err(ImageError::OutsideDocument);
    }
    let mut components = path.components().peekable();
    let mut root = PathBuf::new();
    while let Some(component @ (Component::Prefix(_) | Component::RootDir)) = components.peek() {
        root.push(component.as_os_str());
        components.next();
    }
    let mut directory = Dir::open_ambient_dir(root, cap_std::ambient_authority())
        .map_err(|_| ImageError::Unavailable)?;
    // Canonicalization already resolved legitimate aliases. Refuse a newly
    // substituted symlink in any component while acquiring the root handle.
    // Each step is relative to the preceding open directory, never a pathname
    // that can be redirected after its check.
    for component in components {
        let Component::Normal(name) = component else {
            return Err(ImageError::OutsideDocument);
        };
        directory = directory
            .open_dir_nofollow(name)
            .map_err(|_| ImageError::Unavailable)?;
    }
    Ok(directory)
}

impl ConfinedImage {
    fn resolve(document_path: &Path, image_path: &Path) -> Result<Self, ImageError> {
        if !document_path.is_absolute()
            || !image_path.is_absolute()
            || image_path
                .components()
                .any(|part| part == Component::ParentDir)
        {
            return Err(ImageError::OutsideDocument);
        }
        let document =
            canonicalize_markdown_path(document_path).map_err(|_| ImageError::Unavailable)?;
        // The accepted path is already canonical, so it must still resolve to
        // itself. If the document or an ancestor was replaced by a symlink
        // after acceptance, the name now identifies another document and must
        // not choose that document's folder.
        if document != document_path {
            return Err(ImageError::OutsideDocument);
        }
        let base = document.parent().ok_or(ImageError::Unavailable)?;
        // Keep a directory handle for the whole operation. Canonicalization is
        // only a name check; it must never be followed by an ambient file read.
        let directory = open_canonical_directory(base)?;
        let canonical_image =
            dunce::canonicalize(image_path).map_err(|_| ImageError::Unavailable)?;
        let relative_path = canonical_image
            .strip_prefix(base)
            .map_err(|_| ImageError::OutsideDocument)?
            .to_path_buf();
        if relative_path.as_os_str().is_empty() {
            return Err(ImageError::Unavailable);
        }
        Ok(Self {
            directory,
            relative_path,
        })
    }

    fn read(self) -> Result<DocumentImage, ImageError> {
        let mut options = OpenOptions::new();
        options.read(true);
        // Avoid blocking on a FIFO substituted before open. Metadata below is
        // checked on the same opened handle from which bytes are read.
        options.nonblock(true);
        // cap-std confines every path component and symlink to this directory,
        // including a symlink substituted after the canonical name check.
        let file = self
            .directory
            .open_with(&self.relative_path, &options)
            .map_err(|_| ImageError::Unavailable)?;
        let metadata = file.metadata().map_err(|_| ImageError::Unavailable)?;
        if !metadata.is_file() {
            return Err(ImageError::Unavailable);
        }
        if metadata.len() > MAX_IMAGE_BYTES {
            return Err(ImageError::TooLarge);
        }
        let mut bytes = Vec::new();
        file.take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ImageError::Unavailable)?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(ImageError::TooLarge);
        }
        let name = self.relative_path.to_string_lossy().to_ascii_lowercase();
        let mime_type = MimeType::parse_with_fallback(&bytes, &name, MimeType::OctetStream);
        if !mime_type.starts_with("image/") {
            return Err(ImageError::Unsupported);
        }
        Ok(DocumentImage { mime_type, bytes })
    }
}

fn read_document_image_impl(
    document_path: &Path,
    image_path: &Path,
) -> Result<DocumentImage, ImageError> {
    ConfinedImage::resolve(document_path, image_path)?.read()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::unique_temp_dir;
    use std::fs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\ninside image fixture";

    struct Fixture {
        root: PathBuf,
        document: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = unique_temp_dir("confined-image");
            fs::create_dir_all(root.join("document")).unwrap();
            // The app only ever accepts native canonical paths; the temp
            // directory itself may be an alias (macOS `/var` → `/private/var`).
            let root = dunce::canonicalize(root).unwrap();
            let document = root.join("document/readme.md");
            fs::write(&document, "# Images").unwrap();
            Self { root, document }
        }

        fn image(&self, relative: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }

        fn read(&self, path: &Path) -> Result<DocumentImage, ImageError> {
            read_document_image_impl(&self.document, path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn image_request(fixture: &Fixture, image: &Path, origin: &str) -> Request<Vec<u8>> {
        image_request_for(&fixture.document, image, origin)
    }

    fn image_request_for(document: &Path, image: &Path, origin: &str) -> Request<Vec<u8>> {
        let paths =
            serde_json::to_string(&(document.to_str().unwrap(), image.to_str().unwrap())).unwrap();
        let encoded =
            percent_encoding::utf8_percent_encode(&paths, percent_encoding::NON_ALPHANUMERIC);
        Request::builder()
            .uri(format!("{origin}/{encoded}"))
            .body(Vec::new())
            .unwrap()
    }

    /// Respond as the running app does while `fixture.document` is the
    /// accepted document.
    fn respond(fixture: &Fixture, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        protocol_response(request, Some(&fixture.document))
    }

    #[test]
    fn protocol_decodes_transport_once_and_serves_image_bytes_on_desktop_origins() {
        let fixture = Fixture::new();
        let image = fixture.image("document/café literal%20?#.png", PNG);
        for origin in [
            "document-image://localhost",
            "http://document-image.localhost",
        ] {
            let response = respond(&fixture, image_request(&fixture, &image, origin));
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.body(), PNG);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                response.headers()[header::X_CONTENT_TYPE_OPTIONS],
                "nosniff"
            );
        }
    }

    #[test]
    fn protocol_rejects_bad_transport_and_never_returns_error_file_contents() {
        let fixture = Fixture::new();
        for path in [
            "/not-json",
            "/%ff",
            "/%5B%22one%22%5D",
            "/%5B1%2C2%5D",
            "/%255B%2522one%2522%255D",
        ] {
            let request = Request::builder()
                .uri(format!("document-image://localhost{path}"))
                .body(Vec::new())
                .unwrap();
            let response = respond(&fixture, request);
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
            assert!(response.body().is_empty());
        }
        let outside = fixture.image("outside/private.png", PNG);
        let response = respond(
            &fixture,
            image_request(&fixture, &outside, "document-image://localhost"),
        );
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
        let text = fixture.image("document/private.txt", b"private text");
        let response = respond(
            &fixture,
            image_request(&fixture, &text, "document-image://localhost"),
        );
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(response.body().is_empty());
        let mut request = image_request(&fixture, &text, "document-image://localhost");
        *request.method_mut() = Method::POST;
        assert_eq!(
            respond(&fixture, request).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert!(decode_image_request("/[]", Some("path=elsewhere")).is_err());
    }

    #[test]
    fn protocol_serves_only_the_document_the_session_accepted() {
        // Document A is open. A request minted by content (a Mermaid image
        // node, for instance) names document B and an image in B's folder.
        // B's folder is otherwise a perfectly valid confinement root.
        let fixture = Fixture::new();
        let image_a = fixture.image("document/inside.png", PNG);
        let document_b = fixture.root.join("other/readme.md");
        fs::create_dir_all(document_b.parent().unwrap()).unwrap();
        fs::write(&document_b, "# Other").unwrap();
        let other_png: &[u8] = b"\x89PNG\r\n\x1a\nother folder";
        let image_b = fixture.image("other/private.png", other_png);
        let origin = "document-image://localhost";
        let request_a = || image_request_for(&fixture.document, &image_a, origin);
        let request_b = || image_request_for(&document_b, &image_b, origin);

        // Nothing accepted yet (startup, or a virtual draft): nothing served.
        for request in [request_a(), request_b()] {
            let response = protocol_response(request, None);
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(response.body().is_empty());
        }

        let response = protocol_response(request_a(), Some(&fixture.document));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), PNG);
        let response = protocol_response(request_b(), Some(&fixture.document));
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());

        // Opening B natively without the frontend accepting it (workspace
        // indexing, a cancelled open) changes nothing: acceptance is separate
        // state, not a side effect of reading.
        let session = AuthorizedDocument::default();
        session.replace(Some(fixture.document.clone()));
        crate::document_io::open_markdown_file_impl(document_b.to_string_lossy().into_owned())
            .unwrap();
        assert_eq!(
            session.current().as_deref(),
            Some(fixture.document.as_path())
        );
        let response = protocol_response(request_b(), session.current().as_deref());
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // Accepting B, as a real open or Save As does, swaps the served folder.
        session.replace(Some(document_b.clone()));
        let response = protocol_response(request_b(), session.current().as_deref());
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), other_png);
        let response = protocol_response(request_a(), session.current().as_deref());
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // Returning to a virtual draft clears authorization again.
        session.replace(None);
        assert_eq!(session.current(), None);
        let response = protocol_response(request_b(), session.current().as_deref());
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[cfg(unix)]
    #[test]
    fn protocol_requires_the_exact_accepted_path_rather_than_an_alias() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let image = fixture.image("document/inside.png", PNG);
        let alias = fixture.root.join("document-alias");
        symlink(fixture.document.parent().unwrap(), &alias).unwrap();
        let origin = "document-image://localhost";
        // The alias canonicalizes to the accepted document, but the claim is
        // compared before any filesystem lookup, so it is still refused.
        let aliased = image_request_for(&alias.join("readme.md"), &image, origin);
        assert_eq!(
            protocol_response(aliased, Some(&fixture.document)).status(),
            StatusCode::FORBIDDEN
        );
        // Images may still be named through an internal alias; confinement
        // canonicalizes them as before.
        let exact = image_request_for(&fixture.document, &alias.join("inside.png"), origin);
        assert_eq!(
            protocol_response(exact, Some(&fixture.document)).status(),
            StatusCode::OK
        );
    }

    #[test]
    fn reads_local_subdirectory_unicode_and_literal_percent_image_names() {
        let fixture = Fixture::new();
        for name in [
            "document/local.png",
            "document/images/café cover.png",
            "document/images/literal%20what?#.png",
        ] {
            let path = fixture.image(name, PNG);
            let result = fixture.read(&path).unwrap();
            assert_eq!(result.mime_type, "image/png");
            assert_eq!(result.bytes, PNG);
        }
    }

    #[test]
    fn accepts_svg_and_rejects_non_image_bytes() {
        let fixture = Fixture::new();
        let svg = fixture.image(
            "document/image.SVG",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        );
        assert_eq!(fixture.read(&svg).unwrap().mime_type, "image/svg+xml");
        let text = fixture.image("document/fake.png", b"a private text file");
        assert_eq!(fixture.read(&text).unwrap_err(), ImageError::Unsupported);
    }

    #[test]
    fn rejects_missing_directory_and_oversized_images() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture
                .read(&fixture.root.join("document/missing.png"))
                .unwrap_err(),
            ImageError::Unavailable
        );
        assert_eq!(
            fixture
                .read(fixture.document.parent().unwrap())
                .unwrap_err(),
            ImageError::Unavailable
        );
        let huge = fixture.image("document/huge.png", PNG);
        fs::OpenOptions::new()
            .write(true)
            .open(&huge)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert_eq!(fixture.read(&huge).unwrap_err(), ImageError::TooLarge);
    }

    #[test]
    fn rejects_direct_outside_paths_prefix_siblings_and_parent_traversal() {
        let fixture = Fixture::new();
        let outside = fixture.image("document-other/outside.png", PNG);
        assert_eq!(
            fixture.read(&outside).unwrap_err(),
            ImageError::OutsideDocument
        );
        let traversal = fixture
            .document
            .parent()
            .unwrap()
            .join("../document-other/outside.png");
        assert_eq!(
            fixture.read(&traversal).unwrap_err(),
            ImageError::OutsideDocument
        );
        assert_eq!(
            fixture.read(Path::new("image.png")).unwrap_err(),
            ImageError::OutsideDocument
        );
    }

    #[cfg(unix)]
    #[test]
    fn allows_internal_file_and_directory_symlinks_but_rejects_escapes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let inside = fixture.image("document/images/inside.png", PNG);
        let outside = fixture.image("outside/private.png", PNG);
        let base = fixture.document.parent().unwrap();
        for (name, target, allowed) in [
            ("internal-file.png", inside.clone(), true),
            (
                "relative-file.png",
                PathBuf::from("images/inside.png"),
                true,
            ),
            ("escape.png", outside.clone(), false),
        ] {
            let link = base.join(name);
            symlink(target, &link).unwrap();
            if allowed {
                assert_eq!(fixture.read(&link).unwrap().bytes, PNG);
            } else {
                assert_eq!(
                    fixture.read(&link).unwrap_err(),
                    ImageError::OutsideDocument
                );
            }
        }
        symlink(inside.parent().unwrap(), base.join("internal-dir")).unwrap();
        assert!(fixture.read(&base.join("internal-dir/inside.png")).is_ok());
        symlink(outside.parent().unwrap(), base.join("escape-dir")).unwrap();
        assert_eq!(
            fixture
                .read(&base.join("escape-dir/private.png"))
                .unwrap_err(),
            ImageError::OutsideDocument
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_file_and_directory_symlinks_substituted_after_validation() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let inside = fixture.image("document/images/inside.png", PNG);
        let outside = fixture.image(
            "outside/inside.png",
            b"\x89PNG\r\n\x1a\nprivate outside bytes",
        );
        let prepared = ConfinedImage::resolve(&fixture.document, &inside).unwrap();
        fs::remove_file(&inside).unwrap();
        symlink(&outside, &inside).unwrap();
        assert!(prepared.read().is_err());

        fs::remove_file(&inside).unwrap();
        fs::write(&inside, PNG).unwrap();
        let prepared = ConfinedImage::resolve(&fixture.document, &inside).unwrap();
        fs::rename(inside.parent().unwrap(), fixture.root.join("moved-images")).unwrap();
        symlink(outside.parent().unwrap(), inside.parent().unwrap()).unwrap();
        assert!(prepared.read().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn retains_the_open_document_directory_if_its_name_is_replaced() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let inside = fixture.image("document/image.png", PNG);
        let outside = fixture.image(
            "outside/image.png",
            b"\x89PNG\r\n\x1a\nprivate outside bytes",
        );
        let prepared = ConfinedImage::resolve(&fixture.document, &inside).unwrap();
        fs::rename(
            fixture.document.parent().unwrap(),
            fixture.root.join("moved-document"),
        )
        .unwrap();
        symlink(
            outside.parent().unwrap(),
            fixture.document.parent().unwrap(),
        )
        .unwrap();
        assert_eq!(prepared.read().unwrap().bytes, PNG);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_the_accepted_document_once_its_name_resolves_elsewhere() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let image = fixture.image("document/inside.png", PNG);
        let other_png: &[u8] = b"\x89PNG\r\n\x1a\nother folder";
        let document_b = fixture.root.join("other/readme.md");
        fs::create_dir_all(document_b.parent().unwrap()).unwrap();
        fs::write(&document_b, "# Other").unwrap();
        let image_b = fixture.image("other/private.png", other_png);
        let origin = "document-image://localhost";
        assert_eq!(
            respond(&fixture, image_request(&fixture, &image, origin)).status(),
            StatusCode::OK
        );
        // Another actor replaces the accepted document with a symlink to B
        // after acceptance. The claim still matches the accepted path, but the
        // name no longer identifies the accepted document, so neither B's
        // folder nor the old folder is served through it.
        fs::remove_file(&fixture.document).unwrap();
        symlink(&document_b, &fixture.document).unwrap();
        for target in [&image_b, &image] {
            let response = respond(&fixture, image_request(&fixture, target, origin));
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(response.body().is_empty());
        }
        // The same holds when an ancestor directory is redirected, and for a
        // document named through an alias of its own folder.
        fs::remove_file(&fixture.document).unwrap();
        fs::write(&fixture.document, "# Images").unwrap();
        let base = fixture.document.parent().unwrap();
        fs::rename(base, fixture.root.join("moved-document")).unwrap();
        symlink(document_b.parent().unwrap(), base).unwrap();
        assert_eq!(
            respond(&fixture, image_request(&fixture, &image_b, origin)).status(),
            StatusCode::FORBIDDEN
        );
        fs::remove_file(base).unwrap();
        fs::rename(fixture.root.join("moved-document"), base).unwrap();
        let alias = fixture.root.join("document-alias");
        symlink(base, &alias).unwrap();
        assert_eq!(
            read_document_image_impl(&alias.join("readme.md"), &image).unwrap_err(),
            ImageError::OutsideDocument
        );
        assert_eq!(fixture.read(&image).unwrap().bytes, PNG);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_substituted_while_acquiring_the_document_directory() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.image("document/nested/image.png", PNG);
        fixture.image(
            "outside/nested/image.png",
            b"\x89PNG\r\n\x1a\nprivate outside bytes",
        );
        let base = dunce::canonicalize(fixture.document.parent().unwrap()).unwrap();
        let nested = base.join("nested");
        fs::rename(&base, fixture.root.join("moved-document")).unwrap();
        symlink(fixture.root.join("outside"), &base).unwrap();
        // Refuse both a final-component substitution and an ancestor
        // substitution before any capability can be rooted in the wrong tree.
        assert!(open_canonical_directory(&base).is_err());
        assert!(open_canonical_directory(&nested).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_fifo_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let fixture = Fixture::new();
        let path = fixture.document.parent().unwrap().join("pipe.png");
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a valid NUL-terminated path owned for the call.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert_eq!(fixture.read(&path).unwrap_err(), ImageError::Unavailable);
    }
}
