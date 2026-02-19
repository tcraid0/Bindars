const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { extractCodeText } = require("../.tmp/workspace-tests/src/lib/code-text.js");

test("extractCodeText returns plain string content", () => {
  assert.equal(extractCodeText("npm install\n"), "npm install\n");
});

test("extractCodeText flattens syntax-highlighted nodes", () => {
  const highlighted = [
    React.createElement("span", { className: "hljs-keyword", key: "1" }, "const"),
    " answer = ",
    React.createElement("span", { className: "hljs-number", key: "2" }, "42"),
    ";\n",
  ];

  assert.equal(extractCodeText(highlighted), "const answer = 42;\n");
});

test("extractCodeText handles nested fragments and ignores empty values", () => {
  const nested = React.createElement(
    React.Fragment,
    null,
    "line 1\n",
    React.createElement(
      "span",
      { key: "line2" },
      [
        null,
        false,
        "line ",
        React.createElement("strong", { key: "num" }, "2"),
      ],
    ),
  );

  assert.equal(extractCodeText(nested), "line 1\nline 2");
});
