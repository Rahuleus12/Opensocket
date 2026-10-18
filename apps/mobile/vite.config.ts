import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Tauri webview frontend (ADR 0001). `base: "./"` so built assets load via
// the tauri:// protocol; strictPort so `tauri dev` can rely on 5173.
export default defineConfig({
  plugins: [preact()],
  clearScreen: false,
  base: "./",
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
