// Publishes dist-web/ (made by `npm run build:web`) to the public site repo's main branch (GitHub Pages).
// Only the built page goes there: Rewind's source stays in its own repo. usage: node scripts/deploy-web.mjs [owner/repo]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = process.argv[2] ?? "EtliBiftek/rewind-web";
const dist = path.join(ROOT, "dist-web");
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("dist-web yok: önce npm run build:web");
// never publish demos or anything exported from a CS2 install
const bad = fs.readdirSync(dist, { recursive: true }).filter((f) => /(^|[\/])fixtures([\/]|$)|\.(dem|glb|vmdl|vnmclip|vnmskel)$/i.test(String(f)));
if (bad.length) throw new Error("yayınlanmaması gereken dosyalar: " + bad.join(", "));
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-web-"));
fs.cpSync(dist, tmp, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: tmp, stdio: "inherit" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=Claude", "-c", "user.email=noreply@anthropic.com", "commit", "-q", "-m", `Rewind web build ${sha}`);
git("push", "-q", "--force", `https://github.com/${REPO}.git`, "main");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[web] pushed ${sha} to ${REPO}`);
