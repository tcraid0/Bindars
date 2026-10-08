import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const brand = path.join(root, "assets/brand");
const source = await readFile(path.join(brand, "bindars-icon.svg"), "utf8");
const artwork = source.replace(/^[\s\S]*?<svg\b[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim();

// A light tile keeps the dark blue page visible on either desktop appearance.
// The outer transparent margin is intentional for the macOS Dock. Only the
// placement/scale changes; all artist-supplied paths, colours and lettering stay.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="96" y="96" width="832" height="832" rx="184" fill="#F8F8F7"/>
  <g transform="translate(-87 -87) scale(1.17)">
${artwork}
  </g>
</svg>
`;
const input = path.join(brand, "app-icon.svg");
await writeFile(input, appIcon);

const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
function generate(args) {
  const result = spawnSync(process.execPath, [cli, "icon", input, ...args], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const output = path.join(root, "src-tauri/icons");
generate(["--output", output]);
// Preserve the existing standalone 64px asset; the SVG is the master.
generate(["--output", output, "--png", "64"]);
