#!/usr/bin/env python3
"""Release verification: prove the packaged CSP lets CodeMirror style headings.

Loads the built frontend (dist/) in real WebKit2GTK 4.1 -- the same engine the
Linux AppImage uses -- with the production CSP applied the way packaged Tauri
v2 delivers it, then drives the real UI: new file, insert headings, click the
Styled/Plain toggle, and assert computed styles change.

Why this exists: Tauri stamps a nonce onto every inline <style> and appends
'nonce-...' to style-src. Per the CSP spec a nonce makes 'unsafe-inline'
ignored, so every runtime-injected stylesheet (CodeMirror themes, Mermaid) is
refused -- in packaged builds only, because the dev-server path never applies
this packaged-asset transformation. This script mirrors Tauri's transform for
the *current* tauri.conf.json, so if the style-src exemption is ever removed
it reproduces the v1.4.0 bug and fails.

Usage (after `npm run build`, needs webkit2gtk-4.1, python-gobject, a display):
    python3 scripts/verify-webkit-csp-styles.py [dist-dir]

Tip: on machines needing it, run with WEBKIT_DISABLE_DMABUF_RENDERER=1.
Exit code 0 on success, 1 on any failed check.
"""

import base64
import functools
import hashlib
import http.server
import json
import re
import shutil
import sys
import tempfile
import threading
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STYLE_NONCE = "SIMULATED-TAURI-NONCE"
STEP_TIMEOUT_MS = 45_000


def build_production_html(dist_dir: Path, out_dir: Path) -> None:
    """Copy dist and apply Tauri's packaged-build HTML/CSP transform."""
    shutil.copytree(dist_dir, out_dir, dirs_exist_ok=True)
    conf = json.loads((PROJECT_ROOT / "src-tauri" / "tauri.conf.json").read_text())
    security = conf["app"]["security"]
    csp = security["csp"]
    disabled = security.get("dangerousDisableAssetCspModification", [])
    style_src_exempt = disabled is True or (
        isinstance(disabled, list) and "style-src" in disabled
    )
    script_src_exempt = disabled is True or (
        isinstance(disabled, list) and "script-src" in disabled
    )

    index = out_dir / "index.html"
    html = index.read_text()

    directives = {}
    order = []
    for part in filter(None, (p.strip() for p in csp.split(";"))):
        name, _, sources = part.partition(" ")
        directives[name] = sources.split()
        order.append(name)

    if not script_src_exempt:
        # Tauri hashes inline scripts at build time (normalizing only CRLF to
        # LF) and appends the hashes to script-src. Attribute-less <script>
        # tags are the inline ones; module/src tags are covered by 'self'.
        for script in re.findall(r"<script>(.*?)</script>", html, re.DOTALL):
            digest = hashlib.sha256(script.encode("utf-8")).digest()
            directives.setdefault("script-src", []).append(
                f"'sha256-{base64.b64encode(digest).decode('ascii')}'"
            )

    if not style_src_exempt:
        # Without the exemption, Tauri nonces every <style> element, which
        # cancels 'unsafe-inline' -- the v1.4.0 heading-toggle bug. Tauri uses
        # a distinct nonce per element; one shared nonce is CSP-equivalent.
        html = re.sub(r"<style\b", f'<style nonce="{STYLE_NONCE}"', html)
        directives.setdefault("style-src", []).append(f"'nonce-{STYLE_NONCE}'")

    final_csp = "; ".join(f"{name} {' '.join(directives[name])}".strip() for name in order)
    meta = f'<meta http-equiv="Content-Security-Policy" content="{final_csp}">'
    html = html.replace("<head>", f"<head>\n    {meta}", 1)
    index.write_text(html)


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(directory)
    )
    handler.log_message = lambda *args, **kwargs: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


# Minimal Tauri IPC stub so the real bundle boots without a backend; the
# securitypolicyviolation listener captures engine-level CSP refusals.
BOOT_STUB = """
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  plugins: { path: { sep: "/", delimiter: ":" } },
  transformCallback: function(cb, once) {
    var id = Math.floor(Math.random() * 1e9);
    window["_" + id] = function(r) { if (once) delete window["_" + id]; if (cb) cb(r); };
    return id;
  },
  unregisterCallback: function(id) { delete window["_" + id]; },
  convertFileSrc: function(p) { return p; },
  invoke: function(cmd) { return Promise.reject(new Error("verify-stub: " + cmd)); }
};
window.__cspViolations = [];
document.addEventListener("securitypolicyviolation", function(e) {
  window.__cspViolations.push(e.effectiveDirective + " blocked " + e.blockedURI);
});
window.addEventListener("unhandledrejection", function(e) { e.preventDefault(); });
"""

DIAG_JS = """
(function(){
  function info(el){
    if (!el) return null;
    var cs = getComputedStyle(el);
    return {cls: el.className, fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight};
  }
  var content = document.querySelector('.cm-content');
  var lines = content ? content.querySelectorAll('.cm-line') : [];
  var btn = document.querySelector('button[aria-label="Toggle markup formatting"]');
  return JSON.stringify({
    pressed: btn ? btn.getAttribute('aria-pressed') : null,
    h1: info(content && content.querySelector('.cm-md-h1')),
    h2: info(content && content.querySelector('.cm-md-h2')),
    body: lines.length ? info(lines[lines.length - 1]) : null,
    decoratedLines: content ? content.querySelectorAll('[class*="cm-md-h"]').length : 0,
    markers: content ? content.querySelectorAll('.cm-md-marker').length : 0,
    cspViolations: window.__cspViolations
  });
})()
"""

STEPS = [
    (3000, "new-file", """
(function(){
  var btns = document.querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    if ((btns[i].textContent || '').toLowerCase().indexOf('new') !== -1) {
      btns[i].click();
      return '"clicked"';
    }
  }
  return '"no-new-file-button"';
})()
"""),
    (1500, "insert-doc", """
(function(){
  var content = document.querySelector('.cm-content');
  if (!content) return '"no-editor"';
  content.focus();
  document.execCommand('insertText', false, '# Heading\\n\\n## Second\\n\\nBody');
  return '"inserted"';
})()
"""),
    (2000, "styled", DIAG_JS),
    (300, "toggle-to-plain", """
(function(){
  var btn = document.querySelector('button[aria-label="Toggle markup formatting"]');
  if (!btn) return '"no-toggle"';
  btn.click();
  return '"toggled"';
})()
"""),
    (1000, "plain", DIAG_JS),
    (300, "toggle-back", """
(function(){
  document.querySelector('button[aria-label="Toggle markup formatting"]').click();
  return '"toggled"';
})()
"""),
    (1000, "restyled", DIAG_JS),
]


def run_browser(url: str) -> dict:
    results = {}
    state = {"index": 0}

    ucm = WebKit2.UserContentManager()
    ucm.add_script(WebKit2.UserScript.new(
        BOOT_STUB,
        WebKit2.UserContentInjectedFrames.TOP_FRAME,
        WebKit2.UserScriptInjectionTime.START,
        None, None,
    ))
    view = WebKit2.WebView(user_content_manager=ucm)

    win = Gtk.Window(title="Bindars CSP verification")
    win.set_default_size(1200, 800)
    win.add(view)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()

    def run_step():
        _, name, js = STEPS[state["index"]]

        def cb(v, res):
            try:
                value = v.run_javascript_finish(res).get_js_value().to_string()
                results[name] = json.loads(value)
            except (GLib.Error, ValueError) as error:
                results[name] = {"probe-error": str(error)}
            state["index"] += 1
            schedule()

        view.run_javascript(js, None, cb)
        return False

    def schedule():
        if state["index"] >= len(STEPS):
            Gtk.main_quit()
            return
        GLib.timeout_add(STEPS[state["index"]][0], run_step)

    view.connect(
        "load-changed",
        lambda v, event: schedule() if event == WebKit2.LoadEvent.FINISHED else None,
    )
    view.load_uri(url)
    GLib.timeout_add(STEP_TIMEOUT_MS, Gtk.main_quit)
    Gtk.main()
    return results


def check(results: dict) -> list[str]:
    failures = []
    styled = results.get("styled") or {}
    plain = results.get("plain") or {}
    restyled = results.get("restyled") or {}

    for name, diag in ("styled", styled), ("plain", plain), ("restyled", restyled):
        if not diag or "probe-error" in diag or diag.get("body") is None:
            failures.append(f"{name}: probe did not reach the editor ({diag})")
    if failures:
        return failures

    violations = restyled.get("cspViolations", [])
    style_violations = [v for v in violations if v.startswith("style-src")]
    if style_violations:
        failures.append(
            f"CSP refused {len(style_violations)} stylesheet(s): {style_violations[:3]} "
            "-- runtime-injected styles are blocked (the v1.4.0 bug)"
        )

    for mode, diag in ("styled", styled), ("restyled", restyled):
        h1, h2, body = diag.get("h1"), diag.get("h2"), diag.get("body")
        if not h1 or not h2:
            failures.append(f"{mode}: heading lines missing cm-md-h1/cm-md-h2 classes")
            continue
        if h1["fontWeight"] != "700":
            failures.append(f"{mode}: H1 computed font-weight is {h1['fontWeight']}, expected 700")
        if not (h1["fontSize"] > h2["fontSize"] > body["fontSize"]):
            failures.append(
                f"{mode}: expected H1 > H2 > body font sizes, got "
                f"{h1['fontSize']} / {h2['fontSize']} / {body['fontSize']}"
            )
        if diag.get("markers", 0) < 2:
            failures.append(f"{mode}: expected 2 muted # markers, found {diag.get('markers')}")

    if plain.get("decoratedLines", -1) != 0:
        failures.append(
            f"plain: expected 0 decorated lines after toggling off, found {plain.get('decoratedLines')}"
        )
    return failures


def main() -> int:
    dist_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT_ROOT / "dist"
    if not (dist_dir / "index.html").exists():
        print(f"error: {dist_dir}/index.html not found -- run `npm run build` first")
        return 1

    staging = Path(tempfile.mkdtemp(prefix="bindars-csp-verify-"))
    try:
        build_production_html(dist_dir, staging)
        server, port = serve(staging)
        try:
            results = run_browser(f"http://127.0.0.1:{port}/index.html")
        finally:
            server.shutdown()
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    failures = check(results)
    styled = results.get("styled") or {}
    if styled.get("h1"):
        print(
            f"styled H1: {styled['h1']['fontSize']}px/{styled['h1']['fontWeight']}  "
            f"H2: {styled['h2']['fontSize']}px/{styled['h2']['fontWeight']}  "
            f"body: {styled['body']['fontSize']}px/{styled['body']['fontWeight']}"
        )
    if failures:
        print("FAIL: packaged CSP breaks editor styling")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("PASS: headings style, toggle round-trips, no style-src CSP violations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
