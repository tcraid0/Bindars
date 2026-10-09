import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { svgArtwork } from "./scripts/brand-artwork.mjs";

const host = process.env.TAURI_DEV_HOST;
const documentPerformanceProbe = process.env.BINDARS_DOCUMENT_PERFORMANCE_PROBE === "1";

// The startup screen must show the icon in its very first frame, and the welcome
// screen continues from it, so the brand sources are inlined into index.html
// instead of being loaded as images. Each replaces a `<!-- file name -->` there.
const BRAND_ARTWORK = ["bindars-icon.svg", "bindars-wordmark.svg"];

function brandArtwork(): Plugin {
  return {
    name: "bindars-brand-artwork",
    transformIndexHtml(html) {
      for (const file of BRAND_ARTWORK) {
        const placeholder = `<!-- ${file} -->`;
        if (!html.includes(placeholder)) throw new Error(`index.html is missing ${placeholder}`);
        const source = readFileSync(new URL(`./assets/brand/${file}`, import.meta.url), "utf8");
        html = html.replace(placeholder, () => svgArtwork(source));
      }
      return html;
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), brandArtwork()],
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
