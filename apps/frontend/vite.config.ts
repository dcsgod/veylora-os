import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// monaco-editor's export map appends ".js" to deep paths, so its stylesheet is aliased explicitly.
const monacoRoot = dirname(fileURLToPath(import.meta.resolve("monaco-editor")));

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [{ find: /^monaco-codicon\.css$/, replacement: join(monacoRoot, "base/browser/ui/codicons/codicon/codicon.css") }],
  },
  server: { host: "127.0.0.1", port: 5174, strictPort: false },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as never);
