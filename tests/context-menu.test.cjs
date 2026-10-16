const test = require("node:test");
const assert = require("node:assert/strict");
const { installContextMenuPolicy } = require("../.tmp/workspace-tests/src/lib/context-menu.js");

function contextmenu(target, clientX = 15, clientY = 15) {
  const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}
function fixture(t, html) {
  const host = document.createElement("div"); host.innerHTML = html; document.body.append(host);
  const remove = installContextMenuPolicy();
  t.after(() => { remove(); host.remove(); document.getSelection().removeAllRanges(); });
  return host;
}

for (const tag of ["main", "aside", "nav", "header", "dialog", "section"]) {
  test(`blank ${tag} suppresses the browser menu`, t => {
    const host = fixture(t, `<${tag}></${tag}>`);
    assert.equal(contextmenu(host.firstChild), true);
  });
}
for (const html of ['<input>', '<textarea></textarea>', '<select><option>one</option></select>',
  '<div class="cm-editor"><div contenteditable="true"><span>misspelled</span></div></div>',
  '<div class="cm-panel"><input></div>']) {
  test(`editing menu remains native: ${html}`, t => {
    const host = fixture(t, html);
    const target = host.querySelector("input, textarea, select, span");
    // happy-dom does not implement inherited isContentEditable.
    if (target.tagName === "SPAN") Object.defineProperty(target, "isContentEditable", { value: true });
    assert.equal(contextmenu(target), false);
  });
}
for (const href of ["other.md", "https://example.com", "#section"]) {
  test(`link menu is suppressed before selection handling: ${href}`, t => {
    const host = fixture(t, `<a href="${href}"><span>link</span><img src="sample.png"></a>`);
    const range = document.createRange(); range.selectNodeContents(host.querySelector("span"));
    document.getSelection().addRange(range);
    assert.equal(contextmenu(host.querySelector("span")), true);
    assert.equal(contextmenu(host.querySelector("img")), true);
  });
}

test("unlinked images keep the native menu", t => {
  const host = fixture(t, '<img src="sample.png">');
  assert.equal(contextmenu(host.firstChild), false);
});

test("selected text keeps its menu only at the pointer, including a nearest-caret blank margin", t => {
  const host = fixture(t, "<main><p>selected text</p><p>unselected</p></main>");
  const range = document.createRange(); range.selectNodeContents(host.querySelector("p"));
  document.getSelection().addRange(range);
  const selected = document.getSelection().getRangeAt(0);
  selected.getClientRects = () => [{ left: 10, top: 10, right: 100, bottom: 30 }];
  const caret = document.createRange(); caret.setStart(host.querySelector("p").firstChild, 4); caret.collapse(true);
  const original = document.caretRangeFromPoint;
  document.caretRangeFromPoint = () => caret;
  t.after(() => { document.caretRangeFromPoint = original; });
  assert.equal(contextmenu(host.querySelector("p")), false);
  assert.ok(contextmenu(host.querySelector("main"), 150, 15));
  caret.setStart(host.querySelectorAll("p")[1].firstChild, 2);
  assert.equal(contextmenu(host.querySelectorAll("p")[1]), true);
  document.caretRangeFromPoint = () => null;
  assert.equal(contextmenu(host.querySelector("main")), true);
  document.caretRangeFromPoint = undefined;
  assert.equal(contextmenu(host.querySelector("main")), true);
});

test("the policy leaves left-clicks alone and can remove its single listener", t => {
  const host = fixture(t, '<a href="#section">link</a>');
  const click = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  host.firstChild.dispatchEvent(click); assert.equal(click.defaultPrevented, false);
  assert.equal(contextmenu(document), true);
  const remove = installContextMenuPolicy(); remove();
  assert.equal(contextmenu(host), false);
});
