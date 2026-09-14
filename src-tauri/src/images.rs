use cap_fs_ext::{DirExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
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

/// Serve only bounded image bytes. The browser owns lazy loading and print
/// readiness, while this protocol owns all filesystem access.
pub(crate) fn protocol_response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let result = if request.method() != Method::GET {
        Err(StatusCode::METHOD_NOT_ALLOWED)
    } else {
        decode_image_request(request.uri().path(), request.uri().query())
            .map_err(|_| StatusCode::BAD_REQUEST)
            .and_then(|(document, image)| {
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
            let document = root.join("document/readme.md");
            fs::create_dir_all(document.parent().unwrap()).unwrap();
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
        let paths =
            serde_json::to_string(&(fixture.document.to_str().unwrap(), image.to_str().unwrap()))
                .unwrap();
        let encoded =
            percent_encoding::utf8_percent_encode(&paths, percent_encoding::NON_ALPHANUMERIC);
        Request::builder()
            .uri(format!("{origin}/{encoded}"))
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn protocol_decodes_transport_once_and_serves_image_bytes_on_desktop_origins() {
        let fixture = Fixture::new();
        let image = fixture.image("document/café literal%20?#.png", PNG);
        for origin in [
            "document-image://localhost",
            "http://document-image.localhost",
        ] {
            let response = protocol_response(image_request(&fixture, &image, origin));
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
            let response = protocol_response(request);
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
            assert!(response.body().is_empty());
        }
        let outside = fixture.image("outside/private.png", PNG);
        let response = protocol_response(image_request(
            &fixture,
            &outside,
            "document-image://localhost",
        ));
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.body().is_empty());
        let text = fixture.image("document/private.txt", b"private text");
        let response =
            protocol_response(image_request(&fixture, &text, "document-image://localhost"));
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(response.body().is_empty());
        let mut request = image_request(&fixture, &text, "document-image://localhost");
        *request.method_mut() = Method::POST;
        assert_eq!(
            protocol_response(request).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert!(decode_image_request("/[]", Some("path=elsewhere")).is_err());
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
    fn accepts_legitimate_document_directory_aliases_after_canonicalization() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let image = fixture.image("document/images/inside.png", PNG);
        let alias = fixture.root.join("document-alias");
        symlink(fixture.document.parent().unwrap(), &alias).unwrap();
        let result =
            read_document_image_impl(&alias.join("readme.md"), &alias.join("images/inside.png"))
                .unwrap();
        assert_eq!(result.bytes, PNG);
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
