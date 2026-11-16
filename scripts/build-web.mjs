// Web version (GitHub Pages): Rust core -> WebAssembly (public/wasm), then the page with relative paths into dist-web/.
// Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli matching Cargo.lock's wasm-bindgen.
// usage: node scripts/build-web.mjs [--wasm-only]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" && cmd === "npx" });
const target = process.env.CARGO_TARGET_DIR ?? path.join(ROOT, "target");

run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "rewind-web"]);
const out = path.join(ROOT, "public/wasm");
fs.rmSync(out, { recursive: true, force: true });
run("wasm-bindgen", ["--target", "web", "--no-typescript", "--out-dir", out, path.join(target, "wasm32-unknown-unknown/release/rewind_web.wasm")]);
if (process.argv.includes("--wasm-only")) process.exit(0);
run("npx", ["vite", "build", "--mode", "web", "--base", "./", "--outDir", "dist-web"]);
if (fs.existsSync(path.join(ROOT, "dist-web/fixtures"))) throw new Error("dist-web/fixtures must not be published");
fs.writeFileSync(path.join(ROOT, "dist-web/.nojekyll"), "");
console.log("[web] dist-web ready");
