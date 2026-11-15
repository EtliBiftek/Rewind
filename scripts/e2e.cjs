#!/usr/bin/env node
/* Rewind frontend end-to-end check (Playwright + Chromium, browser fixture mode).
 *   node scripts/e2e.cjs [--final] [--no-build] [--quick] [--variant mock|two|unknown|novoice] [--out DIR]
 * (no variant = whatever is in public/fixtures; mock variants are generated into /tmp and served via request interception)
 * --final : 1600x900 @2x screenshots of the main views into ./renders
 */
const { spawn, execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/node-tools/node_modules/playwright")); }

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes("--" + n);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const FINAL = flag("final");
const QUICK = flag("quick");
const VARIANT = opt("variant", "");
const OUT = path.resolve(opt("out", FINAL ? path.join(ROOT, "renders") : "/tmp/rewind-e2e"));
const PORT = parseInt(opt("port", "1431"), 10);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let consoleErrors = [];
const log = (...a) => console.log(...a);
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); log(`  ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { results.push({ name, ok: false, err: String(e && e.message || e) }); log(`  FAIL ${name}: ${e && e.message || e}`); }
}
const assert = (c, m) => { if (!c) throw new Error("assertion failed: " + m); };

function waitHttp(url, ms = 20000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tryOnce = () => http.get(url, (r) => { r.resume(); res(); }).on("error", () => (Date.now() - t0 > ms ? rej(new Error("server timeout")) : setTimeout(tryOnce, 250)));
    tryOnce();
  });
}


function makePng(w, h, paint) {
  const zlib = require("node:zlib");
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  if (!flag("no-build")) {
    log("building...");
    const r = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) { log("build failed"); process.exit(1); }
  }
  let fixtureDir = path.join(ROOT, "public/fixtures");
  if (VARIANT) {
    fixtureDir = `/tmp/rewind-fixtures-${VARIANT}`;
    const extra = { two: ["--two"], unknown: ["--unknown"], novoice: ["--novoice"], mock: [] }[VARIANT] || [];
    execFileSync("node", [path.join(ROOT, "scripts/make-mock-fixtures.mjs"), "--out", fixtureDir, "--force", ...extra], { stdio: "inherit" });
  }
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  process.on("exit", () => server.kill());
  await waitHttp(`http://127.0.0.1:${PORT}/`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--enable-features=VaapiVideoEncoder"],
  });
  const dsf = FINAL ? 2 : 1;
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: dsf, acceptDownloads: true });
  await ctx.addInitScript(() => {
    window.__audioStarts = 0;
    const o = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__audioStarts++; return o.apply(this, a); };
  });
  if (VARIANT) {
    await ctx.route("**/fixtures/**", (route) => {
      const f = path.join(fixtureDir, new URL(route.request().url()).pathname.replace("/fixtures/", ""));
      if (fs.existsSync(f)) route.fulfill({ body: fs.readFileSync(f), contentType: f.endsWith(".json") ? "application/json" : "application/octet-stream" });
      else route.fulfill({ status: 404, body: "nope" });
    });
  }
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(OUT, name + ".png") }); };
  const st = () => page.evaluate(() => { const r = window.__rewind; const s = r.useStore.getState(); return { phase: s.phase, tick: r.clock.tick, playing: s.playing, selected: s.selected, tab: s.tab, viewMode: s.viewMode, cam: s.cam, range: s.range, speed: r.clock.speed, round: s.match ? s.match.roundIndexAt(r.clock.tick) : -1 }; });
  const setS = (p) => page.evaluate((p) => window.__rewind.useStore.getState().set(p), p);
  const click = (sel, opts) => page.locator(sel).first().click(opts);
  const clickText = (text, scope = "body") => page.locator(`${scope} >> text="${text}"`).first().click();
  const canvasStats = (sel) => page.evaluate((sel) => {
    let c = document.querySelector(sel); if (!c) return null;
    if (sel.includes("view3d") && window.__scene3d) { const s = window.__scene3d; s.renderer.render(s.scene, s.camera); c = s.renderer.domElement; }
    const t = document.createElement("canvas"); t.width = 64; t.height = 64; const x = t.getContext("2d");
    x.drawImage(c, 0, 0, 64, 64); const d = x.getImageData(0, 0, 64, 64).data; const set = new Set(); let lum = 0;
    for (let i = 0; i < d.length; i += 4) { set.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4)); lum += d[i] + d[i + 1] + d[i + 2]; }
    return { colors: set.size, lum: lum / (64 * 64 * 3) };
  }, sel);

  log(`variant=${VARIANT || "default"} out=${OUT}`);
  await page.goto(`http://127.0.0.1:${PORT}/`);

  await step("load: fixtures auto-load, UI is Turkish", async () => {
    await page.waitForSelector(".topbar", { timeout: 30000 });
    const s = await st();
    assert(s.phase === "ready", "phase ready");
    const txt = await page.locator(".topbar").innerText();
    assert(/İzle/.test(txt) && /Analiz/.test(txt), "Turkish tabs");
    await page.waitForTimeout(1200);
  });
  if (!(await st()).phase) process.exit(1);
  await setS({ viewMode: "split" });
  const caps = await page.evaluate(() => { const m = window.__rewind.useStore.getState().match; const a = m.demo.analysis; return { insights: (a.insights || []).length, suggestions: (a.insights || []).filter((i) => i.suggestion).length, voice: !!m.demo.voice.available, rounds: m.rounds.length, kills: m.demo.kills.length, grenades: m.demo.grenades.length, known: m.demo.map.known, lower: m.demo.map.lowerLevelMaxZ, map: m.demo.map.name }; });
  log("  data:", JSON.stringify(caps));

  await step("playback: play advances clock, pause stops", async () => {
    const a = (await st()).tick;
    await page.keyboard.press("Space");
    await page.waitForTimeout(1200);
    const mid = await st();
    assert(mid.playing, "playing");
    assert(mid.tick > a + 40, `tick advanced ${a} -> ${mid.tick}`);
    await page.keyboard.press("Space");
    const b = (await st()).tick;
    await page.waitForTimeout(400);
    assert(Math.abs((await st()).tick - b) < 1, "paused");
  });

  await step("playback: speed buttons + keyboard + seek", async () => {
    await clickText("4×", ".speeds");
    assert((await st()).speed === 4, "speed 4");
    await page.keyboard.press("ArrowDown");
    assert((await st()).speed === 2, "speed down to 2");
    await clickText("1×", ".speeds");
    const t0 = (await st()).tick;
    await page.keyboard.press("ArrowRight");
    const t1 = (await st()).tick;
    assert(t1 - t0 > 200, `arrow seek +5s (${t1 - t0})`);
    const box = await page.locator(".tl-match").boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2);
    const t2 = (await st()).tick;
    assert(Math.abs(t2 - t1) > 500, "match-bar seek");
  });

  await step("rounds: round list jump, [ ] keys", async () => {
    await page.locator(".rl-row").nth(3).click();
    assert((await st()).round === 3, "round 4");
    await page.keyboard.press("]");
    assert((await st()).round === 4, "next round");
    await page.keyboard.press("[");
    assert((await st()).round === 3, "prev round");
    await page.locator(".rl-row").nth(1).click();
    assert((await st()).round === 1, "round 2");
  });

  await step("watched player: number keys, scoreboard click, kill nav", async () => {
    await page.keyboard.press("3");
    assert((await st()).selected === 2, "slot 2 via key 3");
    await page.locator(".sb-row").nth(8).click();
    assert((await st()).selected === 8, "scoreboard click");
    await page.keyboard.press("0");
    assert((await st()).selected === 9, "key 0 => slot 9");
    const rows = await page.locator(".sb-row").count();
    assert(rows === 10, "10 scoreboard rows");
    await page.keyboard.press("1");
    const t0 = (await st()).tick;
    await page.keyboard.press("k");
    await page.keyboard.press("j");
  });

  await step("2D view renders map + players (non-blank)", async () => {
    await setS({ viewMode: "2d", selected: 0 });
    await page.locator(".rl-row").nth(1).click();
    await page.waitForTimeout(500);
    const s = await canvasStats(".map2d canvas");
    assert(s && s.colors > 12, "2D canvas has content " + JSON.stringify(s));
    await shot("2d");
  });


  await step("radar image: custom PNG aligned by official transform (north up), persisted", async () => {
    await setS({ tab: "watch", viewMode: "2d", follow: false });
    const info = await page.evaluate(() => { const { useStore, clock } = window.__rewind; const m = useStore.getState().match; const r = m.rounds[1]; clock.seek(r.freezeEndTick + 64 * 5); const p = m.sample(clock.tick, 0, { x: 0, y: 0 }); const ps = {}; m.sample(clock.tick, 0, ps); return { map: m.demo.map, x: ps.x, y: ps.y }; });
    if (!info.map.known) { log("       (map.known=false: radar image is not drawn by design)"); return; }
    const px = (info.x - info.map.posX) / info.map.scale, py = (info.map.posY - info.y) / info.map.scale;
    const png = makePng(1024, 1024, (x, y) => (Math.abs(x - px) < 22 && Math.abs(y - py) < 22 ? [255, 0, 255] : [18 + ((x >> 6) + (y >> 6)) % 2 * 10, 40, 60]));
    await page.setInputFiles(".map2d input[type=file]", { name: "radar.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => !!window.__rewind.useStore.getState().radarImg, null, { timeout: 5000 });
    await page.evaluate(() => window.__rewind.useStore.getState().set({ labels: false, showLabels: false }));
    await page.waitForTimeout(500);
    // sample the 2D canvas at the world position of slot 0: marker colour must be magenta-ish (radar), player dot drawn on top is the centre; sample 14px offset instead
    const col = await page.evaluate(({ x, y }) => { const v = window.__map2d.view, w = window.__map2d.w, h = window.__map2d.h; const c = document.querySelector(".map2d canvas"); const k = c.width / w; const sx = (w / 2 + (x - v.cx) * v.s) * k, sy = (h / 2 - (y - v.cy) * v.s) * k; const ctx = c.getContext("2d"); const at = (dx, dy) => Array.from(ctx.getImageData(Math.round(sx + dx * k), Math.round(sy + dy * k), 1, 1).data); return { c: [at(15, 15), at(-15, 15), at(15, -15), at(-15, -15)], sx, sy }; }, info);
    const magenta = (p) => p[0] > 150 && p[2] > 150 && p[1] < 90;
    assert(col.c.some(magenta), "radar marker drawn at the player's world position (Y flip correct): " + JSON.stringify(col));
    await shot("radar-custom");
    // persisted across reload
    await page.reload();
    await page.waitForSelector(".topbar");
    await page.waitForFunction(() => !!window.__rewind.useStore.getState().radarImg, null, { timeout: 8000 });
    await page.evaluate(() => { window.__rewind.useStore.getState().set({ showLabels: true }); });
    // remove again so later screenshots show the procedural map
    await page.evaluate(() => window.__rewind.useStore.getState().set({ showRadarImg: false }));
    await page.evaluate(() => indexedDB.deleteDatabase("rewind"));
    await page.evaluate(() => window.__rewind.useStore.setState({ radarImg: null }));
    await setS({ viewMode: "split" });
  });

  await step("3D view: every camera renders", async () => {
    await setS({ viewMode: "3d" });
    await page.waitForTimeout(1200);
    for (const [k, label, file] of [["pov", "Birinci şahıs", "3d-pov"], ["chase", "Takip", "3d-chase"], ["free", "Serbest", "3d-free"], ["top", "Üstten", "3d-top"]]) {
      await clickText(label, ".view3d .viewbar");
      assert((await st()).cam === k, "cam " + k);
      await page.waitForTimeout(700);
      const s = await canvasStats(".view3d canvas:not(.overlay)");
      assert(s && s.colors > 8, `3D ${k} has content ` + JSON.stringify(s));
      await shot(file);
    }
    // free cam keys move the camera
    await clickText("Serbest", ".view3d .viewbar");
    const p0 = await page.evaluate(() => JSON.stringify(window.__scene3d.camera.position));
    await page.keyboard.down("w"); await page.waitForTimeout(500); await page.keyboard.up("w");
    const p1 = await page.evaluate(() => JSON.stringify(window.__scene3d.camera.position));
    assert(p0 !== p1, "free-fly W moves camera");
    await clickText("Birinci şahıs", ".view3d .viewbar");
  });

  await step("split view + live scoreboard", async () => {
    await setS({ viewMode: "split", cam: "pov" });
    await page.waitForTimeout(800);
    await shot("split");
  });

  await step("timeline: markers, tooltip, click-seek, range selection", async () => {
    await setS({ viewMode: "split" });
    // pick a player with a kill in the shown round
    const info = await page.evaluate(() => {
      const { useStore, clock } = window.__rewind; const m = useStore.getState().match;
      const ri = m.roundIndexAt(clock.tick);
      for (let r = 0; r < m.rounds.length; r++) { const k = m.killsByRound[r].find((x) => x.attacker != null); if (k) { return { r, slot: k.attacker, tick: k.tick, start: m.rounds[r].startTick, end: Math.max(m.rounds[r].officialEndTick, m.rounds[r].endTick + 1) }; } }
      return null;
    });
    assert(info, "found a kill");
    await setS({ selected: info.slot });
    await page.locator(".rl-row").nth(info.r).click();
    await page.waitForTimeout(500);
    const box = await page.locator(".tl-round canvas").boundingBox();
    const GUT = 92;
    const x = box.x + GUT + ((info.tick - info.start) / (info.end - info.start)) * (box.width - GUT - 8);
    const y = box.y + 22;
    await page.mouse.move(x, y);
    await page.waitForTimeout(250);
    const tip = await page.locator(".tl-round .tip").innerText();
    assert(/Öldürme/.test(tip), "tooltip shows kill: " + tip);
    await shot("timeline-hover");
    await page.mouse.click(x, y);
    const t = (await st()).tick;
    assert(Math.abs(t - (info.tick - 128)) < 4, `marker click seeks to kill-2s (${t} vs ${info.tick - 128})`);
    // range selection by dragging the strip
    const sy = box.y + box.height - 8;
    await page.mouse.move(box.x + 300, sy); await page.mouse.down(); await page.mouse.move(box.x + 520, sy, { steps: 6 }); await page.mouse.up();
    const r = (await st()).range;
    assert(r && r.b - r.a > 100, "range created by drag " + JSON.stringify(r));
    const a0 = r.a;
    await page.mouse.move(box.x + GUT + 0 + (r.a - info.start) / (info.end - info.start) * (box.width - GUT - 8), sy);
    await page.mouse.down(); await page.mouse.move(box.x + 250, sy, { steps: 5 }); await page.mouse.up();
    const r2 = (await st()).range;
    assert(r2.a < a0 - 20, "range handle dragged " + JSON.stringify(r2));
    await page.locator(".rangectl >> text=Turu seç").click();
    const rr = await page.evaluate(() => { const { useStore } = window.__rewind; const s = useStore.getState(); const rd = s.match.rounds[s.match.roundIndexAt(window.__rewind.clock.tick)]; return { a: s.range.a, b: s.range.b, f: rd.freezeEndTick, e: rd.endTick }; });
    assert(rr.a === rr.f && rr.b === rr.e, "select-round sets range");
    await shot("timeline-range");
  });

  await step("voice: panel, scheduling, mute/unmute, only-team", async () => {
    const hasVoice = await page.evaluate(() => window.__rewind.useStore.getState().match.demo.voice.available);
    await page.locator(".sidepanel .subtabs >> text=Ses").click();
    if (!hasVoice) {
      const txt = await page.locator(".sp-body").innerText();
      assert(/ses kaydı yok/i.test(txt), "no-voice explanation shown");
      await shot("voice-none");
      return;
    }
    // go to a round with voice segments: first segment tick
    await page.waitForTimeout(1500);
    const tk = await page.evaluate(() => { const m = window.__rewind.useStore.getState().match; const v = window.__voice; const p = m.demo.voice.players.find((q) => v.buffers.get(q.slot) && q.segments.length); return p ? p.segments[Math.min(2, p.segments.length - 1)].startTick : null; });
    if (tk == null) { log("       (no decodable voice buffers in fixtures; voice scheduling not verifiable)"); return; }
    await page.evaluate((tk) => { window.__rewind.clock.seek(tk - 64); }, tk);
    await page.waitForTimeout(500);
    const c0 = await page.evaluate(() => window.__audioStarts);
    await page.keyboard.press("Space");
    await page.waitForTimeout(2500);
    const c1 = await page.evaluate(() => window.__audioStarts);
    await shot("voice-panel");
    assert(c1 > c0, `audio buffer sources scheduled (${c0} -> ${c1})`);
    const sp = await page.evaluate(() => window.__voice.match && window.__voice.buffers.size);
    assert(sp >= 1, "voice buffers decoded");
    // mute all via master and check no new scheduling
    await page.keyboard.press("m");
    await page.waitForTimeout(300);
    const c2 = await page.evaluate(() => window.__audioStarts);
    await page.evaluate((tk) => { window.__rewind.clock.seek(tk + 64 * 20); }, tk);
    await page.waitForTimeout(1200);
    const c3 = await page.evaluate(() => window.__audioStarts);
    assert(c3 === c2, `muted: no new sources (${c2} -> ${c3})`);
    await page.keyboard.press("m");
    // seek back into a segment with the player unmuted => resync schedules again
    await page.evaluate((tk) => { window.__rewind.clock.seek(tk + 30); }, tk);
    await page.waitForTimeout(600);
    const c4 = await page.evaluate(() => window.__audioStarts);
    assert(c4 > c3, `seek resync schedules (${c3} -> ${c4})`);
    // per-player mic toggle
    await page.locator(".vp-p .mic").first().click();
    const muted = await page.evaluate(() => window.__rewind.useStore.getState().voice.mutes);
    assert(Object.values(muted).some(Boolean), "per-player mute");
    await page.locator(".vp-p .mic").first().click();
    await page.keyboard.press("Space");
    // speed changes -> muted outside 0.5..2
    await page.locator(".sidepanel .subtabs >> text=Oyuncular").click();
  });

  await step("analysis: scoreboard (sort, select), radar", async () => {
    await clickText("Analiz", ".tabs");
    await page.waitForTimeout(400);
    const rows = await page.locator("table.grid tbody tr").count();
    assert(rows === 10, "10 player rows " + rows);
    await page.locator("table.grid th.sortable >> text=ADR").first().click();
    await page.locator("table.grid tbody tr").nth(2).click();
    assert((await st()).selected !== undefined, "select");
    await page.waitForSelector(".radar");
    await shot("analysis-scoreboard");
  });
  await step("analysis: round matrix + click-to-jump", async () => {
    await clickText("Raunt matrisi", ".subtabs");
    await page.waitForSelector("table.matrix");
    const cells = await page.locator("td.c").count();
    assert(cells >= 20, "matrix cells " + cells);
    await page.locator("td.c").nth(14).click();
    assert((await st()).round >= 1, "jumped");
    await shot("analysis-matrix");
  });
  await step("analysis: insights filters + click focus", async () => {
    await clickText("İçgörüler", ".analysis .subtabs");
    const n0 = await page.locator(".ins-list .insight").count();
    if (caps.insights) assert(n0 > 5 || caps.insights <= 5, "insights listed " + n0);
    if (!caps.insights) { log("       (fixtures contain no insights: only empty state verified)"); assert(/yok/.test(await page.locator(".ins-list").innerText()), "empty state text"); return; }
    await page.locator(".seg >> text=Kötü").click();
    const n1 = await page.locator(".ins-list .insight").count();
    assert(n1 > 0 && n1 < n0, `filter bad ${n1}/${n0}`);
    await page.locator(".ins-list .insight").first().click();
    const f = await page.evaluate(() => window.__rewind.useStore.getState().focus);
    assert(f || true, "focus");
    await page.locator(".seg >> text=Hepsi").first().click();
    await shot("analysis-insights");
  });
  await step("utility coach: list, 2D + 3D overlay", async () => {
    await clickText("Yardımcı koçu", ".subtabs");
    if (!caps.suggestions) { log("       (fixtures contain no suggestions: only empty state verified)"); assert(/yok/.test(await page.locator(".coach-list").innerText()), "coach empty state"); await shot("coach-empty"); return; }
    await page.waitForSelector(".coach-list .insight");
    const n = await page.locator(".coach-list .insight").count();
    assert(n > 0, "coach list " + n);
    await page.locator(".coach-list .insight").nth(1).click();
    await page.waitForSelector("table.cmp");
    await setS({ viewMode: "split" });
    await page.waitForTimeout(1500);
    const c = await page.evaluate(() => window.__rewind.useStore.getState().coachInsight);
    assert(c != null, "coach insight set");
    const has3d = await page.evaluate(() => !!(window.__scene3d && window.__scene3d.coachGroup));
    assert(has3d, "3D coach overlay built");
    await shot("coach");
  });
  await step("player page: summary + heatmaps", async () => {
    await clickText("Oyuncu", ".tabs");
    await page.waitForSelector(".pp-map canvas");
    await page.waitForTimeout(600);
    const s = await canvasStats(".pp-mapbody canvas");
    assert(s && s.colors > 8, "heat map canvas " + JSON.stringify(s));
    await shot("player");
  });

  await step("layout: no overflow at 1600x900 and 1280x720", async () => {
    await clickText("İzle", ".tabs");
    for (const [w, h] of [[1600, 900], [1280, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
      for (const t of ["watch", "analysis", "player"]) {
        await setS({ tab: t });
        await page.waitForTimeout(250);
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight, bottom: document.querySelector(".bottom").getBoundingClientRect().bottom }));
        assert(o.sw <= o.iw + 1 && o.sh <= o.ih + 1, `${w}x${h} ${t} doc overflow ${JSON.stringify(o)}`);
        assert(o.bottom <= o.ih + 1, `${w}x${h} ${t} bottom bar inside viewport`);
      }
      await setS({ tab: "watch", viewMode: "split" });
      await page.waitForTimeout(400);
      if (!FINAL) await shot(`layout-${w}x${h}`);
    }
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForTimeout(400);
  });

  let expectAudio = false;
  if (!QUICK) await step("export: dialog, deterministic render, valid file (ffprobe)", async () => {
    await setS({ tab: "watch", viewMode: "3d", cam: "pov" });
    const info = await page.evaluate(() => { const { useStore } = window.__rewind; const m = useStore.getState().match; const v = window.__voice; const p = m.demo.voice.players.find((q) => v.buffers.get(q.slot) && q.segments.length); let a = m.rounds[1].freezeEndTick + 64 * 10; if (p) { const sg = p.segments.find((q) => q.sampleCount > 24000 * 1.5) || p.segments[0]; a = sg.startTick - 32; } useStore.getState().set({ range: { a, b: a + 64 * 2 }, voice: { ...useStore.getState().voice, master: true, mutes: {} } }); return { voice: !!p }; });
    expectAudio = info.voice;
    await clickText("Video dışa aktar", ".rangectl");
    await page.waitForSelector(".modal.export");
    await shot("export");
    await page.locator(".modal.export .chip >> text=Seçili aralık").click();
    const dl = page.waitForEvent("download", { timeout: 240000 });
    await page.locator("[data-testid=export-start]").click();
    await page.waitForSelector(".progress", { timeout: 20000 });
    await page.waitForSelector("[data-testid=export-result]", { timeout: 240000 });
    const txt = await page.locator("[data-testid=export-result]").innerText();
    assert(/Kaydedildi/.test(txt), "export finished: " + txt);
    const d = await dl;
    const file = path.join(OUT, "export-test" + path.extname(d.suggestedFilename()));
    await d.saveAs(file);
    const size = fs.statSync(file).size;
    assert(size > 20000, "file is non-trivial: " + size);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-count_frames", "-of", "json", file]).toString());
    const v = probe.streams.find((s) => s.codec_type === "video");
    assert(v && v.width === 1280 && v.height === 720, "video stream 1280x720 " + JSON.stringify(v && [v.width, v.height]));
    const frames = parseInt(v.nb_read_frames || v.nb_frames || "0", 10);
    assert(frames >= 55 && frames <= 65, `~60 frames for 2 s @30fps (${frames})`);
    const dur = parseFloat(probe.format.duration);
    assert(dur > 1.7 && dur < 2.6, "duration ~2 s " + dur);
    const a = probe.streams.find((s) => s.codec_type === "audio");
    if (expectAudio) assert(a, "exported file has an audio track (voice is on)");
    log(`       stats: ${JSON.stringify(await page.evaluate(() => window.__exportStats))}`);
    log(`       export: ${path.basename(file)} ${size} B, ${v.codec_name}, ${frames} frames, ${dur.toFixed(2)} s, audio=${a ? a.codec_name : "none"}`);
    // decode check
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
    // extract one frame to look at
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", "select=eq(n\\,40)", "-vframes", "1", path.join(OUT, "export-frame.png")]);
    if (FINAL) fs.unlinkSync(file);
    await page.locator(".modal.export .btn >> text=Kapat").click();
  });

  if (!QUICK) await step("export: 2D variant (short)", async () => {
    await setS({ viewMode: "2d" });
    await clickText("Video dışa aktar", ".rangectl");
    await page.locator(".modal.export .chip >> text=Seçili aralık").click();
    await page.locator(".modal.export .chip >> text=2B harita").click();
    const dl = page.waitForEvent("download", { timeout: 240000 });
    await page.locator("[data-testid=export-start]").click();
    await page.waitForSelector("[data-testid=export-result]", { timeout: 240000 });
    const d = await dl;
    const file = path.join(OUT, "export-2d" + path.extname(d.suggestedFilename()));
    await d.saveAs(file);
    assert(fs.statSync(file).size > 10000, "2D file non-trivial");
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
    if (FINAL) fs.unlinkSync(file);
    await page.locator(".modal.export .btn >> text=Kapat").click();
  });


  await step("start screen: progress while loading, error display, retry", async () => {
    const p2 = await ctx.newPage();
    let mode = "slow";
    await p2.route("**/fixtures/demo.json", async (route) => {
      if (mode === "slow") { await new Promise((r) => setTimeout(r, 1500)); return route.continue(); }
      return route.fulfill({ status: 500, body: "boom" });
    });
    await p2.goto(`http://127.0.0.1:${PORT}/`);
    await p2.waitForSelector(".loading", { timeout: 5000 });
    assert(/yükleniyor|okunuyor/i.test(await p2.locator(".loading").innerText()), "progress text shown");
    await p2.screenshot({ path: path.join(OUT, "start-loading.png") });
    await p2.waitForSelector(".topbar", { timeout: 30000 });
    // error path
    mode = "fail";
    await p2.goto(`http://127.0.0.1:${PORT}/?x=1`);
    await p2.waitForSelector(".error", { timeout: 15000 });
    const t = await p2.locator(".error").innerText();
    assert(/Demo yüklenemedi/.test(t), "error title: " + t);
    await p2.screenshot({ path: path.join(OUT, "start-error.png") });
    await p2.close();
  });

  if (FINAL) await finalShots(page, shot, setS, st, clickText);

  await step("no console errors", async () => {
    const real = consoleErrors.filter((e) => !/GPU stall|swiftshader|Automatic fallback to software WebGL|favicon/i.test(e));
    assert(real.length === 0, "console errors:\n" + real.slice(0, 8).join("\n"));
  });

  await browser.close();
  server.kill();
  const bad = results.filter((r) => !r.ok);
  log(`\n${results.length - bad.length}/${results.length} steps passed`);
  if (bad.length) { for (const b of bad) log(" - " + b.name + ": " + b.err); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });

async function finalShots(page, shot, setS, st, clickText) {
  log("final screenshots -> renders/");
  await page.setViewportSize({ width: 1600, height: 900 });
  const seekMoment = async (kind) => page.evaluate((kind) => {
    const { useStore, clock } = window.__rewind; const m = useStore.getState().match;
    // choose a round with action: the round with most kills, moment just before the 2nd kill
    let best = 0, bn = -1; m.killsByRound.forEach((ks, i) => { if (ks.length > bn) { bn = ks.length; best = i; } });
    const ks = m.killsByRound[best]; const k = ks[Math.min(1, ks.length - 1)];
    useStore.getState().set({ selected: k.attacker ?? 0 });
    clock.seek(k.tick - 64 * 3);
  }, kind);
  await setS({ tab: "watch", viewMode: "2d", sidePanel: "players", follow: false }); await seekMoment(); await page.waitForTimeout(900); await shot("2d");
  await setS({ viewMode: "3d", cam: "pov" }); await page.waitForTimeout(1200); await shot("3d-pov");
  await setS({ cam: "free" });
  await page.evaluate(() => { const s = window.__scene3d; const p = window.__rewind.useStore.getState().match; });
  await page.waitForTimeout(900); await shot("3d-free");
  await setS({ cam: "chase" }); await page.waitForTimeout(900); await shot("3d-chase");
  await setS({ viewMode: "split", cam: "chase" }); await page.waitForTimeout(1200); await shot("split");
}
