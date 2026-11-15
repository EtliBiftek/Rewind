import { FrameFlag } from "../lib/contract";
import { Match, SIDE_COLOR, has, isAlive, newPState, weaponLabel } from "../lib/model";
import { drawHud, drawKillFeed } from "./draw2d";
import type { CamMode } from "./scene3d";

/** Overlay for the 3D view (also composited into exported videos). */
export function drawOverlay3D(ctx: CanvasRenderingContext2D, m: Match, tick: number, selected: number, mode: CamMode, w: number, h: number, clear = true) {
  const ri = m.roundIndexAt(tick);
  if (clear) ctx.clearRect(0, 0, w, h);
  if (ri < 0) return;
  const ps = m.sample(tick, selected, newPState());
  if (mode === "pov") {
    // flashbang whiteout
    if (ps.flash > 0.05 && isAlive(ps)) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.97, 0.25 + ps.flash * 0.55)})`;
      ctx.fillRect(0, 0, w, h);
    }
    if (has(ps.flags, FrameFlag.Scoped) && isAlive(ps)) {
      const r = Math.min(w, h) * 0.46;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2, true);
      ctx.fill("evenodd");
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(w / 2 - r, h / 2);
      ctx.lineTo(w / 2 + r, h / 2);
      ctx.moveTo(w / 2, h / 2 - r);
      ctx.lineTo(w / 2, h / 2 + r);
      ctx.stroke();
    } else if (isAlive(ps)) {
      ctx.strokeStyle = "rgba(61,255,160,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w / 2 - 12, h / 2);
      ctx.lineTo(w / 2 - 4, h / 2);
      ctx.moveTo(w / 2 + 4, h / 2);
      ctx.lineTo(w / 2 + 12, h / 2);
      ctx.moveTo(w / 2, h / 2 - 12);
      ctx.lineTo(w / 2, h / 2 - 4);
      ctx.moveTo(w / 2, h / 2 + 4);
      ctx.lineTo(w / 2, h / 2 + 12);
      ctx.stroke();
    }
  }
  drawKillFeed(ctx, m, m.killsByRound[ri], tick, w);
  drawHud(ctx, m, tick, w);
  // player card (bottom-left)
  const side = has(ps.flags, FrameFlag.SideCT) ? "CT" : "T";
  const col = SIDE_COLOR[side];
  const bw = 230,
    bh = 58;
  const x = 12,
    y = h - bh - 12;
  ctx.fillStyle = "rgba(8,12,20,0.8)";
  ctx.beginPath();
  ctx.roundRect(x, y, bw, bh, 8);
  ctx.fill();
  ctx.fillStyle = col;
  ctx.fillRect(x, y + 8, 3, bh - 16);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.font = "700 13px system-ui, 'Segoe UI', sans-serif";
  ctx.fillStyle = "#f2f6fb";
  ctx.fillText(m.players[selected]?.name ?? "", x + 12, y + 8);
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.fillStyle = "#9fb0c8";
  const wn = weaponLabel(m.weaponName(ps.weapon));
  ctx.textAlign = "right";
  ctx.fillText(wn === "—" ? "" : wn, x + bw - 10, y + 10);
  ctx.textAlign = "left";
  // bars
  const hp = Math.max(0, Math.min(100, ps.health));
  ctx.fillStyle = "#26324a";
  ctx.fillRect(x + 12, y + 30, 100, 8);
  ctx.fillStyle = hp > 50 ? "#3ddc84" : hp > 25 ? "#ffcc4d" : "#ff5c6c";
  ctx.fillRect(x + 12, y + 30, hp, 8);
  ctx.fillStyle = "#26324a";
  ctx.fillRect(x + 122, y + 30, 100, 8);
  ctx.fillStyle = "#6aa7ff";
  ctx.fillRect(x + 122, y + 30, Math.max(0, Math.min(100, ps.armor)), 8);
  ctx.font = "600 10.5px system-ui, sans-serif";
  ctx.fillStyle = "#c9d3e2";
  ctx.fillText(`${Math.round(hp)} HP`, x + 12, y + 41);
  ctx.fillText(`${Math.round(ps.armor)} Zırh`, x + 122, y + 41);
}
