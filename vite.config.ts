import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { svgArtwork } from "./scripts/brand-artwork.mjs";

const host = process.env.TAURI_DEV_HOST;
const documentPerformanceProbe = process.env.BINDARS_DOCUMENT_PERFORMANCE_PROBE === "1";

// The startup screen must show the icon in its very first frame, so the brand
// source is inlined into index.html instead of being loaded as an image.
const STARTUP_MARK = "<!-- startup mark -->";

function startupMark(): Plugin {
  return {
    name: "bindars-startup-mark",
    transformIndexHtml(html) {
      if (!html.includes(STARTUP_MARK)) throw new Error(`index.html is missing ${STARTUP_MARK}`);
      const source = readFileSync(new URL("./assets/brand/bindars-icon.svg", import.meta.url), "utf8");
      return html.replace(STARTUP_MARK, svgArtwork(source));
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), startupMark()],
  define: {
    __BINDARS_DOCUMENT_PERFORMANCE_PROBE__: JSON.stringify(documentPerformanceProbe),
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
