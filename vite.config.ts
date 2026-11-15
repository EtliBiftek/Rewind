import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

/**
 * Browser/dev fixture mode: serve public/fixtures in dev and preview, but never ship it in dist/
 * (it is ~100 MB and would bloat the Tauri bundle).
 */
function fixtures(): Plugin {
  const dir = path.resolve(import.meta.dirname, "public/fixtures");
  const mw = (req: any, res: any, next: any) => {
    const url: string = (req.url ?? "").split("?")[0];
    if (!url.startsWith("/fixtures/")) return next();
    const f = path.join(dir, path.normalize(decodeURIComponent(url.slice("/fixtures/".length))));
    if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("Content-Type", f.endsWith(".json") ? "application/json" : "application/octet-stream");
    res.setHeader("Content-Length", fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  };
  return {
    name: "rewind-fixtures",
    configureServer: (s) => void s.middlewares.use(mw),
    configurePreviewServer: (s) => void s.middlewares.use(mw),
    closeBundle() {
      fs.rmSync(path.resolve(import.meta.dirname, "dist/fixtures"), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), fixtures()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  preview: { port: 1420, strictPort: true },
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 2000 },
});
