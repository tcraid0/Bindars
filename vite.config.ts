import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;
const documentPerformanceProbe = process.env.BINDARS_DOCUMENT_PERFORMANCE_PROBE === "1";

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
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
