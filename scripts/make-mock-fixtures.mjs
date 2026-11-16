#!/usr/bin/env node
// Deterministic contract-valid mock fixtures for developing without a real demo.
// usage: node scripts/make-mock-fixtures.mjs [--out public/fixtures] [--two] [--rounds 6] [--unknown] [--novoice] [--force]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n) => args.includes("--" + n);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt("out", "public/fixtures"));
const TWO = flag("two");
const UNKNOWN = flag("unknown");
const NOVOICE = flag("novoice");
const ROUNDS = parseInt(opt("rounds", "6"), 10);
fs.mkdirSync(OUT, { recursive: true });
const existing = path.join(OUT, "demo.json");
if (fs.existsSync(existing) && !flag("force")) {
  try {
    const d = JSON.parse(fs.readFileSync(existing, "utf8"));
    if (d.header && d.header.serverName !== "Rewind Mock") {
      console.log("[mock] real fixtures present in", OUT, "- not overwriting (use --force)");
      process.exit(0);
    }
  } catch { /* overwrite */ }
}

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(1337);
const rr = (a, b) => a + rng() * (b - a);
const ri = (a, b) => Math.floor(rr(a, b + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;

const TICK = 64, INTERVAL = 4;
const CX = -670, CY = -850; // world centre of the mock map (inside mirage-like overview)
const L = (x, y) => [CX + x, CY + y];

// ---- world layout -------------------------------------------------------
const PLACES = [
  ["T Spawn", 0, -1400], ["CT Spawn", 0, 1300], ["Orta", 0, 0], ["A Sitesi", 900, 900], ["B Sitesi", -900, 900],
  ["A Uzun", 1100, -300], ["B Tüneller", -1100, -300], ["Pencere", 450, 450], ["Alt Orta", 0, -700], ["Konnektör", -450, 450],
].map(([n, x, y]) => ({ name: n, pos: L(x, y) }));
const nearestPlace = (x, y) => { let b = null, bd = 1e18; for (const p of PLACES) { const d = (p.pos[0] - x) ** 2 + (p.pos[1] - y) ** 2; if (d < bd) { bd = d; b = p; } } return b.name; };
const lowerZ = -500;
function zAt(x, y) {
  if (!TWO) return 0 + Math.max(0, Math.min(60, (x - (CX + 700)) * 0.06)); // small ramp on A side
  // B tunnels are a lower level between y=-1000..400
  const lx = x - CX, ly = y - CY;
  if (lx < -700 && ly > -1000 && ly < 400) {
    const t = Math.min(1, Math.min(ly + 1000, 400 - ly) / 300);
    return lowerZ * t;
  }
  return 0;
}
const LANES = {
  A: [L(0, -1400), L(600, -1250), L(1100, -1000), L(1100, -300), L(1000, 600), L(900, 900)],
  B: [L(0, -1400), L(-600, -1250), L(-1100, -1000), L(-1100, -300), L(-1000, 600), L(-900, 900)],
  M: [L(0, -1400), L(0, -700), L(0, 0), L(300, 350), L(450, 450)],
};
const CT_HOLDS = { A: [L(0, 1300), L(500, 1100), L(850, 950)], B: [L(0, 1300), L(-500, 1100), L(-850, 950)], M: [L(0, 1300), L(0, 800), L(0, 300)] };
const SITE = { A: L(900, 900), B: L(-900, 900) };

// ---- players ------------------------------------------------------------
const NAMES = ["kaan", "efe", "arda", "mert", "baran", "deniz", "cem", "yiğit", "onur", "selin"];
const players = NAMES.map((name, i) => ({ slot: i, steamId: String(76561198000000000n + BigInt(1000 + i * 37)), name, team: i < 5 ? 0 : 1, teamName: i < 5 ? "Takım Alfa" : "Takım Bravo", isBot: false }));

// ---- round simulation ---------------------------------------------------
const WEAPONS = ["knife", "glock", "usp_silencer", "ak47", "m4a1", "awp", "galilar", "famas", "deagle", "hegrenade", "flashbang", "smokegrenade", "molotov", "incgrenade", "mac10", "mp9"];
const W = Object.fromEntries(WEAPONS.map((w, i) => [w, i]));
const rounds = [], kills = [], damages = [], shots = [], blinds = [], grenades = [], bombEvents = [], chat = [], insights = [];
const roundPlans = [];
let tickCursor = 128;
const score = [0, 0];
let gid = 1, iid = 1;
const mkFlag = (o) => (o.conn ? 1 : 0) | (o.alive ? 2 : 0) | (o.ct ? 4 : 0) | (o.duck ? 8 : 0) | (o.scoped ? 16 : 0) | (o.defusing ? 32 : 0) | (o.bomb ? 64 : 0) | (o.defuser ? 128 : 0) | (o.helmet ? 256 : 0) | (o.air ? 512 : 0) | (o.walk ? 1024 : 0) | (o.planting ? 2048 : 0);

function pathLen(pts) { let d = 0; const cum = [0]; for (let i = 1; i < pts.length; i++) { d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(d); } return { total: d, cum }; }
function pathAt(pts, dist) {
  const { total, cum } = pathLen(pts);
  if (dist >= total) { const a = pts[Math.max(0, pts.length - 2)], b = pts[pts.length - 1]; return { x: b[0], y: b[1], yaw: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, done: true }; }
  let i = 1; while (cum[i] < dist) i++;
  const f = (dist - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]); const a = pts[i - 1], b = pts[i];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, yaw: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI, done: false };
}

for (let r = 0; r < ROUNDS; r++) {
  const half = Math.floor(ROUNDS / 2);
  const swapped = r >= half;
  const teamSides = swapped ? ["T", "CT"] : ["CT", "T"]; // index = constant team
  const sideOf = (slot) => teamSides[players[slot].team];
  const start = tickCursor, freezeEnd = start + 15 * TICK;
  const tAt = (sec) => freezeEnd + Math.round(sec * TICK);
  const slotsOf = (side) => players.filter((p) => sideOf(p.slot) === side).map((p) => p.slot);
  const T = slotsOf("T"), CT = slotsOf("CT");
  const pistol = r === 0 || r === half;
  const buy = [pistol ? "pistol" : pick(["eco", "force", "full", "full", "full"]), pistol ? "pistol" : pick(["eco", "force", "full", "full"])];
  const eqv = buy.map((b) => ({ pistol: 800, eco: 1200, force: 2800, full: 4600 })[b] * 5 + ri(-200, 200));

  // plans
  const plan = {};
  const tTarget = {}; const tt = ["A", "B", "M", "A", "B"]; T.forEach((s, i) => { tTarget[s] = tt[(i + r) % 5]; });
  const ctTarget = {}; const ct = ["A", "B", "M", "A", "B"]; CT.forEach((s, i) => { ctTarget[s] = ct[(i + 2 * r) % 5]; });
  const spawnT = (i) => L(-300 + i * 150, -1450 - (i % 2) * 90), spawnCT = (i) => L(-300 + i * 150, 1330 + (i % 2) * 90);
  T.forEach((s, i) => { const sp = spawnT(i); const lane = LANES[tTarget[s]]; plan[s] = { legs: [{ t0: 0, pts: [sp, ...lane.slice(1)], speed: rr(200, 245), delay: rr(0.2, 2.5) }] }; });
  CT.forEach((s, i) => { const sp = spawnCT(i); const lane = CT_HOLDS[ctTarget[s]]; plan[s] = { legs: [{ t0: 0, pts: [sp, ...lane.slice(1)], speed: rr(220, 250), delay: rr(0.2, 2) }] }; });

  // event sim
  const alive = new Set(players.map((p) => p.slot));
  let t = rr(14, 26); const roundKills = [];
  const planter = pick(T); const doPlant = rng() < 0.6; const tPlant = rr(42, 60); let planted = false, plantSite = pick(["A", "B"]);
  let end = null, winner = null, reason = null, plantTime = null, defuseTime = null, deadAt = {};
  while (true) {
    const aT = T.filter((s) => alive.has(s)), aCT = CT.filter((s) => alive.has(s));
    if (aT.length === 0) { if (planted) { defuseTime = t + 6; end = defuseTime; winner = "CT"; reason = "bomb_defused"; } else { end = t - 1.5; winner = "CT"; reason = "t_eliminated"; } break; }
    if (aCT.length === 0) { end = t - 1.5; winner = "T"; reason = "ct_eliminated"; break; }
    if (doPlant && !planted && t > tPlant && alive.has(planter)) { planted = true; plantTime = tPlant; }
    if (planted && t > plantTime + 38) { end = plantTime + 40; winner = "T"; reason = "bomb_exploded"; break; }
    if (planted && aCT.length && rng() < 0.12 && t > plantTime + 10) { defuseTime = t + 5; end = defuseTime; winner = "CT"; reason = "bomb_defused"; break; }
    if (t > 110) { end = 115; winner = "CT"; reason = "time_expired"; break; }
    // kill
    const tWins = rng() < 0.48 + (swapped ? 0 : 0);
    const att = pick(tWins ? aT : aCT), vic = pick(tWins ? aCT : aT);
    const assist = rng() < 0.3 ? pick((tWins ? aT : aCT).filter((s) => s !== att).concat([null])) : null;
    roundKills.push({ t, att, vic, assist });
    alive.delete(vic); deadAt[vic] = t;
    t += rr(3, 12);
  }
  const endTick = tAt(end), officialEnd = endTick + 5 * TICK;
  const winTeam = teamSides.indexOf(winner);
  const scoreBefore = [...score]; score[winTeam]++;

  // after plant: CT rotate to site, planter stands at site
  if (planted && alive) {
    for (const s of CT) { const p = plan[s]; const leg0 = p.legs[0]; const ex = pathAt(leg0.pts, leg0.speed * Math.max(0, plantTime + 1 - leg0.delay)); p.legs.push({ t0: plantTime + 1, pts: [[ex.x, ex.y], SITE[plantSite]], speed: 250, delay: 0 }); }
    const pl = plan[planter]; const leg0 = pl.legs[0]; pl.legs[0].pts = [...leg0.pts.slice(0, -1), SITE[plantSite]]; if (tTarget[planter] !== plantSite) { pl.legs[0].pts = [leg0.pts[0], ...LANES[plantSite].slice(1)]; }
  }
  roundPlans.push({ start, freezeEnd, end: endTick, plan, deadAt, roundKills, planter, plantTime, planted });

  const posAtSec = (slot, sec) => {
    const p = plan[slot]; let leg = p.legs[0]; for (const l of p.legs) if (l.t0 <= sec) leg = l;
    const d = Math.max(0, sec - leg.t0 - (leg === p.legs[0] ? leg.delay : 0)) * leg.speed;
    let q = pathAt(leg.pts, d); let x = q.x, y = q.y, yaw = q.yaw;
    if (q.done || sec < leg.t0 + (leg === p.legs[0] ? leg.delay : 0)) { x += Math.sin(sec * 0.7 + slot) * 25; y += Math.cos(sec * 0.5 + slot * 2) * 25; yaw = sideOf(slot) === "T" ? 90 + Math.sin(sec * 0.3 + slot) * 35 : -90 + Math.sin(sec * 0.3 + slot) * 35; }
    const moving = !q.done && sec >= leg.t0 + (leg === p.legs[0] ? leg.delay : 0);
    return { x, y, z: zAt(x, y), yaw, moving, speed: moving ? leg.speed : 0 };
  };
  roundPlans[r].posAtSec = posAtSec;

  const rd = { number: r + 1, startTick: start, freezeEndTick: freezeEnd, endTick, officialEndTick: officialEnd, winner, endReason: reason, teamSides, scoreBefore, buyTypes: buy, equipValues: eqv, bombPlantedTick: planted ? tAt(plantTime) : null, bombSite: planted ? plantSite : null };
  rounds.push(rd);

  // kills + damage + shots
  const rk = [];
  roundKills.forEach((k, idx) => {
    const tick = tAt(k.t);
    const vp = posAtSec(k.vic, k.t), ap = k.att != null ? posAtSec(k.att, k.t) : null;
    const wpn = sideOf(k.att) === "T" ? pick(["ak47", "ak47", "ak47", "awp", "glock", "galilar", "deagle"]) : pick(["m4a1", "m4a1", "awp", "usp_silencer", "famas", "deagle"]);
    const prev = rk.find((q) => q.victim === k.att && tick - q.tick <= 5 * TICK && q.attacker === k.vic);
    const rec = { tick, round: r + 1, attacker: k.att, victim: k.vic, assister: k.assist, flashAssist: rng() < 0.12, weapon: wpn, headshot: rng() < 0.4, wallbang: rng() < 0.05, throughSmoke: rng() < 0.05, noScope: wpn === "awp" && rng() < 0.05, attackerBlind: rng() < 0.03, attackerPos: [r1(ap.x), r1(ap.y), r1(ap.z + 0)], victimPos: [r1(vp.x), r1(vp.y), r1(vp.z)], distance: r1(Math.hypot(ap.x - vp.x, ap.y - vp.y)), isOpening: idx === 0, isTrade: false, victimTraded: false };
    rk.push(rec);
  });
  // trade flags
  for (const k of rk) { const killer = k.attacker; const tr = rk.find((q) => q.victim === killer && q.tick > k.tick && q.tick - k.tick <= 5 * TICK && sideOf(q.attacker) !== sideOf(killer)); if (tr) { k.victimTraded = true; tr.isTrade = true; } }
  kills.push(...rk);
  // damage + shots
  for (const k of rk) {
    const v = k.victim;
    if (k.attacker == null) continue;
    const pre = ri(0, 2) ? ri(15, 60) : 0;
    if (pre) damages.push({ tick: k.tick - 20, round: r + 1, attacker: k.attacker, victim: v, weapon: k.weapon, hpDamage: pre, armorDamage: ri(0, 8), hitgroup: pick(["chest", "stomach", "arm", "leg"]) });
    damages.push({ tick: k.tick, round: r + 1, attacker: k.attacker, victim: v, weapon: k.weapon, hpDamage: 100 - pre, armorDamage: ri(0, 10), hitgroup: k.headshot ? "head" : "chest" });
    for (let s = 0; s < ri(2, 6); s++) shots.push({ tick: k.tick - ri(2, 70), player: k.attacker, weapon: k.weapon });
  }
  // grenades
  const throwers = players.map((p) => p.slot);
  for (const s of throwers) {
    const n = buy[players[s].team] === "eco" ? ri(0, 1) : ri(1, 3);
    for (let g = 0; g < n; g++) {
      const type = pick(["smoke", "flash", "flash", "he", "molotov", "smoke", "flash"]);
      const dead = deadAt[s] ?? end; const sec = rr(6, Math.max(8, Math.min(dead - 3, end - 3))); if (sec > dead - 2.5) continue;
      const tp = posAtSec(s, sec); const side = sideOf(s);
      const target = side === "T" ? pick([L(900, 700), L(-900, 700), L(0, 300), L(450, 450), L(1100, 0)]) : pick([L(0, -500), L(1100, -700), L(-1100, -700), L(0, -200)]);
      const lx = target[0] + rr(-90, 90), ly = target[1] + rr(-90, 90);
      const lz = zAt(lx, ly);
      const throwTick = tAt(sec); const flight = Math.min(3.2, Math.max(0.9, Math.hypot(lx - tp.x, ly - tp.y) / 1100));
      const fuse = type === "flash" ? 1.6 : type === "he" ? 1.6 : 0; // smoke/molotov: detonate on landing
      const detTick = throwTick + Math.round(Math.max(flight, fuse) * TICK);
      const tz0 = tp.z + 64; const traj = [];
      const nSamp = Math.max(2, Math.round((detTick - throwTick) / INTERVAL));
      for (let i = 0; i <= nSamp; i++) { const f = Math.min(1, (i * INTERVAL) / Math.max(1, detTick - throwTick)); const ff = Math.min(1, f * (detTick - throwTick) / (flight * TICK)); traj.push(throwTick + i * INTERVAL, r1(tp.x + (lx - tp.x) * ff), r1(tp.y + (ly - tp.y) * ff), r1(tz0 + (lz + 4 - tz0) * ff + Math.sin(Math.PI * ff) * 160)); }
      const yaw = (Math.atan2(ly - tp.y, lx - tp.x) * 180) / Math.PI; const pitch = -35 + rr(-6, 6);
      const gr = { id: gid++, type, thrower: s, round: r + 1, throwTick, throwPos: [r1(tp.x), r1(tp.y), r1(tp.z)], throwYaw: r1(yaw), throwPitch: r1(pitch), throwStyle: pick(["stand", "jump", "run", "crouch", "walk"]), detonateTick: detTick, detonatePos: [r1(lx), r1(ly), r1(lz + 8)], expireTick: type === "smoke" ? detTick + 18 * TICK : type === "molotov" ? detTick + 7 * TICK : null, trajectory: traj, landPlace: nearestPlace(lx, ly), throwPlace: nearestPlace(tp.x, tp.y), enemiesFlashed: 0, teammatesFlashed: 0, enemyBlindSeconds: 0, teamBlindSeconds: 0, damage: 0, teamDamage: 0 };
      if (detTick > endTick + 3 * TICK) { gr.detonateTick = null; gr.detonatePos = null; gr.expireTick = null; }
      if (type === "flash" && gr.detonateTick) {
        for (const o of players) { if (o.slot === s || !(posAtSec(o.slot, (detTick - freezeEnd) / TICK))) continue; const dsec = (detTick - freezeEnd) / TICK; if ((deadAt[o.slot] ?? 999) < dsec) continue; const op = posAtSec(o.slot, dsec); const d = Math.hypot(op.x - lx, op.y - ly); if (d < 650 && rng() < 0.7) { const dur = rr(1, 3.6); const team = sideOf(o.slot) === side; blinds.push({ tick: detTick, round: r + 1, attacker: s, victim: o.slot, duration: r1(dur), teamFlash: team, grenadeId: gr.id }); if (team) { gr.teammatesFlashed++; gr.teamBlindSeconds += dur; } else { gr.enemiesFlashed++; gr.enemyBlindSeconds += dur; } } }
        gr.enemyBlindSeconds = r1(gr.enemyBlindSeconds); gr.teamBlindSeconds = r1(gr.teamBlindSeconds);
      }
      if (type === "he" && gr.detonateTick) { if (rng() < 0.4) gr.damage = ri(10, 70); if (rng() < 0.1) gr.teamDamage = ri(5, 30); }
      if (type === "molotov" && gr.detonateTick && rng() < 0.3) gr.damage = ri(10, 40);
      grenades.push(gr);
    }
  }
  // bomb events
  if (planted) {
    const sp = SITE[plantSite]; const z = zAt(sp[0], sp[1]);
    bombEvents.push({ tick: tAt(plantTime) - 3 * TICK, round: r + 1, type: "plant_begin", player: planter, site: plantSite, pos: [r1(sp[0]), r1(sp[1]), r1(z)] });
    bombEvents.push({ tick: tAt(plantTime), round: r + 1, type: "planted", player: planter, site: plantSite, pos: [r1(sp[0]), r1(sp[1]), r1(z)] });
    if (reason === "bomb_defused") { const df = CT.find((s) => !(deadAt[s] < defuseTime)) ?? CT[0]; bombEvents.push({ tick: tAt(defuseTime) - 5 * TICK, round: r + 1, type: "defuse_begin", player: df, site: plantSite, pos: null }); bombEvents.push({ tick: tAt(defuseTime), round: r + 1, type: "defused", player: df, site: plantSite, pos: null }); roundPlans[r].defuser = df; roundPlans[r].defuseTime = defuseTime; }
    if (reason === "bomb_exploded") bombEvents.push({ tick: endTick, round: r + 1, type: "exploded", player: null, site: plantSite, pos: [r1(sp[0]), r1(sp[1]), r1(z)] });
  }
  chat.push({ tick: start + 200, player: r % 10, text: pick(["gg", "rush B", "smoke at orta", "eco bu raunt", "iyi atış!"]), teamOnly: rng() < 0.5 });
  tickCursor = officialEnd;
}
const totalTicks = tickCursor + 64;

// ---- frames -------------------------------------------------------------
const startTick = 128;
const frameCount = Math.floor((totalTicks - startTick) / INTERVAL) + 1;
const stride = 12, PC = 10;
const data = new Float32Array(frameCount * PC * stride);
const healthEvents = {}; // key round:slot -> [{tick,hp}]
for (const d of damages) { (healthEvents[d.round + ":" + d.victim] ??= []).push(d); }
const bombCarrier = (rp, r) => rp.plan && null;
for (let f = 0; f < frameCount; f++) {
  const tick = startTick + f * INTERVAL;
  let ri_ = rounds.findIndex((rd) => tick >= rd.startTick && tick < rd.officialEndTick); if (ri_ < 0) ri_ = rounds.length - 1;
  const rd = rounds[ri_], rp = roundPlans[ri_]; const sec = (tick - rp.freezeEnd) / TICK;
  for (let s = 0; s < PC; s++) {
    const o = (f * PC + s) * stride; const side = rd.teamSides[players[s].team]; const isCT = side === "CT";
    const dsec = rp.deadAt[s]; const dead = dsec !== undefined && sec >= dsec;
    const p = rp.posAtSec(s, dead ? dsec : Math.max(sec, 0));
    // yaw toward victim when about to kill
    let yaw = p.yaw, pitch = Math.sin(sec * 0.4 + s) * 4; let scoped = false;
    for (const k of rp.roundKills) if (k.att === s && sec > k.t - 1.4 && sec <= k.t + 0.3) { const vp = rp.posAtSec(k.vic, k.t); const a = rp.posAtSec(s, k.t); yaw = (Math.atan2(vp.y - a.y, vp.x - a.x) * 180) / Math.PI; pitch = 0; scoped = false; }
    let hp = 100; if (dead) hp = 0; else { for (const d of healthEvents[rd.number + ":" + s] ?? []) if (d.tick <= tick) hp -= d.hpDamage; hp = Math.max(1, hp); }
    // death or victims of damage should keep >0 until kill
    const gHold = grenades.find((g) => g.thrower === s && g.round === rd.number && tick >= g.throwTick - 40 && tick <= g.throwTick + 8);
    const planting = rp.planted && s === rp.planter && sec > rp.plantTime - 3 && sec < rp.plantTime;
    const defusing = rp.defuser === s && sec > rp.defuseTime - 5 && sec < rp.defuseTime;
    let bomb = !rp.planted ? side === "T" && s === rp.planter : false; if (rp.planted && sec < rp.plantTime) bomb = s === rp.planter;
    if (dead) bomb = false;
    let blind = 0; for (const b of blinds) if (b.victim === s && b.round === rd.number && tick >= b.tick) blind = Math.max(blind, b.duration - (tick - b.tick) / TICK);
    const full = rd.buyTypes[players[s].team] === "full" || rd.buyTypes[players[s].team] === "force";
    const wname = gHold ? ({ smoke: "smokegrenade", flash: "flashbang", he: "hegrenade", molotov: "molotov", decoy: "flashbang" })[gHold.type] : isCT ? (full ? (s % 5 === 0 ? "awp" : "m4a1") : "usp_silencer") : (full ? (s % 5 === 0 ? "awp" : "ak47") : "glock");
    if (wname === "awp" && !dead && !p.moving && sec > 20 && Math.sin(sec * 0.3 + s) > 0.6) scoped = true;
    data[o] = p.x; data[o + 1] = p.y; data[o + 2] = p.z; data[o + 3] = ((yaw + 540) % 360) - 180; data[o + 4] = pitch; data[o + 5] = dead ? 0 : hp;
    data[o + 6] = dead ? 0 : full ? 100 : 0;
    data[o + 7] = mkFlag({ conn: true, alive: !dead, ct: isCT, duck: !dead && !p.moving && Math.sin(sec * 0.9 + s * 3) > 0.85, scoped, defusing, bomb, defuser: isCT && full && !dead, helmet: full, air: false, walk: p.moving && p.speed < 130, planting });
    data[o + 8] = dead ? 0 : Math.max(0, blind); data[o + 9] = dead ? -1 : W[wname]; data[o + 10] = ri_ === 0 ? 800 : 1000 + ((s * 731 + ri_ * 977) % 6000); data[o + 11] = rd.equipValues[players[s].team] / 5;
  }
}

// ---- analysis -----------------------------------------------------------
const stats = players.map((p) => {
  const ks = kills.filter((k) => k.attacker === p.slot), ds = kills.filter((k) => k.victim === p.slot), as = kills.filter((k) => k.assister === p.slot);
  const dmg = damages.filter((d) => d.attacker === p.slot).reduce((a, d) => a + d.hpDamage, 0);
  const g = grenades.filter((x) => x.thrower === p.slot);
  const gt = { smoke: 0, flash: 0, he: 0, molotov: 0, decoy: 0 }; g.forEach((x) => gt[x.type]++);
  const sh = shots.filter((x) => x.player === p.slot).length;
  const nr = rounds.length;
  const sub = {}; for (const k of ["aim", "entry", "trade", "utility", "clutch", "survival", "economy", "positioning"]) sub[k] = clamp(Math.round(30 + rng() * 60), 0, 100);
  const score100 = Math.round(Object.values(sub).reduce((a, b) => a + b, 0) / 8);
  return { slot: p.slot, score: score100, rating: r1(0.55 + ks.length / nr * 0.7 - ds.length / nr * 0.2 + 0.4) , subScores: sub, kills: ks.length, deaths: ds.length, assists: as.length, adr: r1(dmg / nr), kast: r1(60 + rng() * 30), hsPercent: ks.length ? r1(ks.filter((k) => k.headshot).length / ks.length * 100) : 0, kpr: r1(ks.length / nr * 100) / 100, dpr: r1(ds.length / nr * 100) / 100, impact: r1(0.6 + rng()), openingKills: ks.filter((k) => k.isOpening).length, openingDeaths: ds.filter((k) => k.isOpening).length, tradeKills: ks.filter((k) => k.isTrade).length, tradedDeaths: ds.filter((k) => k.victimTraded).length, untradedDeaths: ds.filter((k) => !k.victimTraded).length, multiKills: { k2: 0, k3: 0, k4: 0, k5: 0 }, clutchesWon: { v1: 0, v2: 0, v3: 0, v4: 0, v5: 0 }, clutchesLost: 0, flashAssists: as.filter((k) => k.flashAssist).length, enemiesFlashed: g.reduce((a, x) => a + x.enemiesFlashed, 0), enemyBlindSeconds: r1(g.reduce((a, x) => a + x.enemyBlindSeconds, 0)), teammatesFlashed: g.reduce((a, x) => a + x.teammatesFlashed, 0), utilityDamage: g.reduce((a, x) => a + x.damage, 0), grenadesThrown: gt, accuracy: sh ? r1(clamp(ks.length / sh * 140, 5, 60)) : 0, avgTimeAlive: r1(rr(35, 70)), mvpRounds: 0 };
});
const roundAn = rounds.map((rd) => {
  const lines = players.map((p) => {
    const side = rd.teamSides[p.team]; const ks = kills.filter((k) => k.round === rd.number && k.attacker === p.slot).length; const died = kills.some((k) => k.round === rd.number && k.victim === p.slot);
    const won = rd.winner === side; const sc = clamp(Math.round(ks * 26 - (died ? 22 : 0) + (won ? 14 : -6) + rr(-12, 12)), -100, 100);
    return { slot: p.slot, side, score: sc, kills: ks, died, damage: damages.filter((d) => d.round === rd.number && d.attacker === p.slot).reduce((a, d) => a + d.hpDamage, 0), survived: !died, equipValue: rd.equipValues[p.team], verdict: sc > 20 ? "good" : sc < -15 ? "bad" : "neutral" };
  });
  const mvp = lines.reduce((a, b) => (b.score > a.score ? b : a)).slot; stats[mvp].mvpRounds++;
  return { round: rd.number, players: lines, mvp, summary: `${rd.winner === "T" ? "T" : "CT"} turu kazandı (${({ bomb_exploded: "bomba patladı", bomb_defused: "bomba etkisiz hale getirildi", t_eliminated: "T takımı elendi", ct_eliminated: "CT takımı elendi", time_expired: "süre doldu" })[rd.endReason] ?? "bilinmiyor"}).` };
});
const mk = (o) => ({ id: iid++, pos: null, grenadeId: null, suggestion: null, ...o });
for (const k of kills) {
  if (k.attacker != null && k.isOpening) { insights.push(mk({ round: k.round, tick: k.tick, player: k.attacker, kind: "opening_kill", category: "entry", severity: "good", title: "Açılış öldürmesi", detail: `Raundun ilk öldürmesini ${players[k.victim].name} oyuncusuna karşı aldın.`, scoreDelta: 12, pos: k.attackerPos })); }
  if (k.isOpening) insights.push(mk({ round: k.round, tick: k.tick, player: k.victim, kind: "opening_death", category: "entry", severity: "bad", title: "Açılış ölümü", detail: "Raundun ilk ölümü sende oldu; takım dezavantajlı başladı.", scoreDelta: -12, pos: k.victimPos }));
  if (!k.victimTraded && !k.isOpening) insights.push(mk({ round: k.round, tick: k.tick, player: k.victim, kind: "untraded_death", category: "trade", severity: "bad", title: "Takasız ölüm", detail: "Takım arkadaşların 5 saniye içinde rövanş alamadı. Takım arkadaşına daha yakın pozisyon al.", scoreDelta: -8, pos: k.victimPos }));
  if (k.isTrade && k.attacker != null) insights.push(mk({ round: k.round, tick: k.tick, player: k.attacker, kind: "trade_kill", category: "trade", severity: "good", title: "Takas öldürmesi", detail: "Takım arkadaşının rövanşını aldın.", scoreDelta: 7, pos: k.attackerPos }));
}
for (const g of grenades) {
  const p = players[g.thrower];
  const sug = (why) => { const from = [g.throwPos[0] + 60, g.throwPos[1] + 40, g.throwPos[2]]; const land = g.detonatePos ? [g.detonatePos[0] + 120, g.detonatePos[1] + 60, g.detonatePos[2]] : [g.throwPos[0], g.throwPos[1] + 800, g.throwPos[2]]; const tr = []; for (let i = 0; i <= 14; i++) { const f = i / 14; tr.push(r1(from[0] + (land[0] - from[0]) * f), r1(from[1] + (land[1] - from[1]) * f), r1(from[2] + 64 + (land[2] - from[2] - 64) * f + Math.sin(Math.PI * f) * 180)); } return { type: g.type, label: `${nearestPlace(land[0], land[1])} ${({ smoke: "smoke", flash: "flaş", he: "HE", molotov: "molotof", decoy: "decoy" })[g.type]} (${nearestPlace(from[0], from[1])}'den, zıplayarak)`, from, fromPlace: nearestPlace(from[0], from[1]), aimYaw: r1((Math.atan2(land[1] - from[1], land[0] - from[0]) * 180) / Math.PI), aimPitch: -38.5, throwStyle: "jump", land, landPlace: nearestPlace(land[0], land[1]), trajectory: tr, source: pick(["seed", "library", "this_demo"]), support: ri(3, 40), reason: why }; };
  if (g.type === "flash" && g.teammatesFlashed > 0) insights.push(mk({ round: g.round, tick: g.detonateTick ?? g.throwTick, player: g.thrower, kind: "team_flash", category: "utility", severity: "bad", title: "Takım arkadaşını kör ettin", detail: `${g.teammatesFlashed} takım arkadaşı toplam ${g.teamBlindSeconds} sn kör oldu.`, scoreDelta: -6, pos: g.detonatePos, grenadeId: g.id, suggestion: sug("Flaşı takım arkadaşlarının önünden değil, rakibin açısına doğru at.") }));
  else if (g.type === "flash" && g.enemiesFlashed === 0) insights.push(mk({ round: g.round, tick: g.detonateTick ?? g.throwTick, player: g.thrower, kind: "wasted_flash", category: "utility", severity: "bad", title: "Boşa giden flaş", detail: "Flaş hiçbir rakibi kör etmedi.", scoreDelta: -3, pos: g.detonatePos, grenadeId: g.id, suggestion: sug("Bu açıdan atılan flaş rakip pozisyonunun üzerinde patlar.") }));
  else if (g.type === "flash" && g.enemiesFlashed >= 2) insights.push(mk({ round: g.round, tick: g.detonateTick ?? g.throwTick, player: g.thrower, kind: "good_flash", category: "utility", severity: "good", title: "Etkili flaş", detail: `${g.enemiesFlashed} rakibi ${g.enemyBlindSeconds} sn kör ettin.`, scoreDelta: 6, pos: g.detonatePos, grenadeId: g.id }));
  else if (g.type === "smoke" && g.id % 3 === 0) insights.push(mk({ round: g.round, tick: g.detonateTick ?? g.throwTick, player: g.thrower, kind: "bad_smoke", category: "utility", severity: "bad", title: "Yanlış yere atılmış smoke", detail: `${g.landPlace ?? "Bilinmeyen"} noktasına düşen smoke kritik görüş hattını kapatmadı.`, scoreDelta: -4, pos: g.detonatePos, grenadeId: g.id, suggestion: sug("Standart smoke noktası görüş hattını tamamen kapatır.") }));
  else if (g.type === "he" && g.damage === 0 && g.id % 2 === 0) insights.push(mk({ round: g.round, tick: g.detonateTick ?? g.throwTick, player: g.thrower, kind: "wasted_he", category: "utility", severity: "bad", title: "Hasarsız HE", detail: "HE bombası kimseye hasar vermedi.", scoreDelta: -2, pos: g.detonatePos, grenadeId: g.id, suggestion: sug("Rakiplerin sık beklediği köşeye atılmalıydı.") }));
}
insights.push(mk({ round: 2, tick: rounds[1].startTick + 3000, player: 3, kind: "future_kind_xyz", category: "positioning", severity: "info", title: "Bilinmeyen tür öngörüsü", detail: "Arayüz bilinmeyen insight türlerini genel olarak göstermelidir.", scoreDelta: 0, pos: null }));
insights.sort((a, b) => a.tick - b.tick); insights.forEach((x, i) => (x.id = i + 1));

// ---- voice --------------------------------------------------------------
const SR = 24000;
const voicePlayers = []; const voiceFiles = {};
if (!NOVOICE) {
  for (const [slot, freq] of [[0, 330], [5, 523]]) {
    const segs = []; const chunks = []; let off = 0;
    for (const rd of rounds) for (let i = 0; i < 3; i++) {
      const startT = rd.freezeEndTick + ri(1, 40) * TICK + i * 12 * TICK; if (startT > rd.endTick - 128) continue;
      const n = Math.round(rr(1.2, 2.6) * SR); const buf = new Int16Array(n);
      for (let j = 0; j < n; j++) { const env = Math.min(1, j / 800, (n - j) / 800); buf[j] = Math.round(Math.sin((2 * Math.PI * freq * j) / SR) * 9000 * env * (0.6 + 0.4 * Math.sin(j / 3000))); }
      segs.push({ startTick: startT, sampleOffset: off, sampleCount: n }); chunks.push(buf); off += n;
    }
    const all = new Int16Array(off); let p = 0; for (const c of chunks) { all.set(c, p); p += c.length; }
    voicePlayers.push({ slot, steamId: players[slot].steamId, totalSamples: off, segments: segs });
    voiceFiles[players[slot].steamId] = Buffer.from(all.buffer);
  }
}

// ---- map ----------------------------------------------------------------
let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
for (let i = 0; i < data.length; i += stride) { minX = Math.min(minX, data[i]); maxX = Math.max(maxX, data[i]); minY = Math.min(minY, data[i + 1]); maxY = Math.max(maxY, data[i + 1]); minZ = Math.min(minZ, data[i + 2]); maxZ = Math.max(maxZ, data[i + 2]); }
const map = UNKNOWN
  ? { name: "de_bilinmeyen", posX: minX - 200, posY: maxY + 200, scale: Math.max(maxX - minX, maxY - minY) / 900 + 1, lowerLevelMaxZ: TWO ? -200 : null, known: false, boundsMin: [minX, minY, minZ], boundsMax: [maxX, maxY, maxZ] }
  : { name: "de_mock", posX: -3230, posY: 1713, scale: 5, lowerLevelMaxZ: TWO ? -200 : null, known: true, boundsMin: [minX, minY, minZ], boundsMax: [maxX, maxY, maxZ] };

const demo = {
  header: { fileName: "mock.dem", mapName: map.name, serverName: "Rewind Mock", source: "unknown", tickRate: TICK, totalTicks, durationSeconds: totalTicks / TICK },
  map, players, rounds, kills, damages, shots, blinds, grenades, bombEvents, chat,
  frames: { startTick, sampleInterval: INTERVAL, frameCount, playerCount: PC, stride, weapons: WEAPONS },
  voice: { available: !NOVOICE, sampleRate: SR, players: voicePlayers },
  analysis: { players: stats, rounds: roundAn, insights },
};
fs.writeFileSync(path.join(OUT, "demo.json"), JSON.stringify(demo));
fs.writeFileSync(path.join(OUT, "frames.bin"), Buffer.from(data.buffer));
for (const [id, buf] of Object.entries(voiceFiles)) fs.writeFileSync(path.join(OUT, `voice_${id}.bin`), buf);
console.log(`[mock] wrote ${OUT}: ${rounds.length} rounds, ${frameCount} frames, ${grenades.length} grenades, ${kills.length} kills, ${insights.length} insights`);
