import { useMemo, useRef, useState } from "react";
import { clock, useTick } from "../lib/clock";
import { useStore } from "../lib/store";
import { useRaf, useSize } from "../lib/hooks";
import { Icon } from "./icons";
import { GRENADE_COLORS, GRENADE_NAMES, SIDE_COLOR, fmtClock, weaponLabel, type Match } from "../lib/model";

interface Marker {
  tick: number;
  row: number;
  kind: string;
  color: string;
  shape: "circle" | "tri" | "diamond" | "square" | "ring";
  text: string;
  seek: number;
}

const ROW_Y = [22, 38, 54, 70];
const GUT = 92;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

export function buildMarkers(m: Match, ri: number, sel: number): Marker[] {
  const out: Marker[] = [];
  const tr = m.tickRate;
  const r = m.rounds[ri];
  if (!r) return out;
  const name = (s: number | null) => (s == null ? "Dünya" : (m.players[s]?.name ?? "?"));
  for (const k of m.killsByRound[ri]) {
    if (k.attacker === sel)
      out.push({ tick: k.tick, row: 0, kind: "kill", color: "#3ddc84", shape: k.headshot ? "ring" : "circle", text: `Öldürme: ${name(k.victim)} · ${weaponLabel(k.weapon)}${k.headshot ? " · kafa" : ""}${k.isOpening ? " · açılış" : ""}${k.isTrade ? " · takas" : ""}`, seek: k.tick - 2 * tr });
    if (k.victim === sel)
      out.push({ tick: k.tick, row: 0, kind: "death", color: "#ff5c6c", shape: "circle", text: `Ölüm: ${name(k.attacker)} · ${weaponLabel(k.weapon)}${k.isOpening ? " · açılış ölümü" : ""}`, seek: k.tick - 3 * tr });
    if (k.assister === sel) out.push({ tick: k.tick, row: 0, kind: "assist", color: "#35d0ba", shape: "tri", text: `Asist: ${name(k.victim)}${k.flashAssist ? " (flaş)" : ""}`, seek: k.tick - 2 * tr });
  }
  for (const g of m.grenadesByRound[ri]) {
    if (g.thrower !== sel) continue;
    out.push({ tick: g.throwTick, row: 1, kind: "grenade", color: GRENADE_COLORS[g.type] ?? "#fff", shape: "diamond", text: `${GRENADE_NAMES[g.type] ?? g.type} atıldı${g.landPlace ? " → " + g.landPlace : ""}${g.enemiesFlashed ? ` · ${g.enemiesFlashed} rakip kör` : ""}`, seek: g.throwTick - 1.5 * tr });
  }
  const bl: Record<string, string> = { plant_begin: "Bomba kurulumu başladı", planted: "Bomba kuruldu", defuse_begin: "Etkisizleştirme başladı", defuse_abort: "Etkisizleştirme iptal", defused: "Bomba etkisiz", exploded: "Bomba patladı", drop: "Bomba düştü", pickup: "Bomba alındı" };
  for (const b of m.bombByRound[ri]) {
    const col = b.type === "defused" ? "#3ddc84" : b.type === "exploded" ? "#ff9b2f" : b.type === "planted" ? "#ff5c6c" : "#9aa8bd";
    out.push({ tick: b.tick, row: 2, kind: "bomb", color: col, shape: "square", text: `${bl[b.type] ?? b.type}${b.site ? " · " + b.site : ""}${b.player != null ? " · " + name(b.player) : ""}`, seek: b.tick - 1 * tr });
  }
  for (const i of m.demo.analysis?.insights ?? []) {
    if (i.round !== r.number || i.player !== sel) continue;
    out.push({ tick: i.tick, row: 3, kind: "insight", color: i.severity === "good" ? "#3ddc84" : i.severity === "bad" ? "#ff5c6c" : "#8fa0b8", shape: "circle", text: `${i.title} (${i.scoreDelta > 0 ? "+" : ""}${i.scoreDelta})`, seek: i.tick - 2 * tr });
  }
  return out;
}

function shape(ctx: CanvasRenderingContext2D, mk: Marker, x: number, y: number, hot: boolean) {
  const r = hot ? 6.5 : 5;
  ctx.fillStyle = mk.color;
  ctx.strokeStyle = "rgba(8,12,20,0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (mk.shape) {
    case "circle":
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case "ring":
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case "tri":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r * 0.8);
      ctx.lineTo(x - r, y + r * 0.8);
      ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case "square":
      ctx.rect(x - r + 1, y - r + 1, (r - 1) * 2, (r - 1) * 2);
      break;
  }
  ctx.fill();
  ctx.stroke();
  if (mk.shape === "ring") {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, r - 2.4, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function Transport() {
  const match = useStore((s) => s.match)!;
  const st = useStore();
  const tick = useTick(8);
  const ri = Math.max(0, match.roundIndexAt(tick));
  const r = match.rounds[ri];
  const kills = match.demo.kills ?? [];
  const sel = st.selected;
  const selKills = kills.filter((k) => k.attacker === sel);
  const nextKill = () => {
    const k = (selKills.length ? selKills : kills).find((q) => q.tick - 2 * match.tickRate > clock.tick + 8);
    if (k) clock.seek(k.tick - 2 * match.tickRate);
  };
  const prevKill = () => {
    const l = [...(selKills.length ? selKills : kills)].reverse().find((q) => q.tick - 2 * match.tickRate < clock.tick - match.tickRate);
    if (l) clock.seek(l.tick - 2 * match.tickRate);
  };
  const gotoRound = (d: number) => {
    const cur = match.roundIndexAt(clock.tick);
    const startCur = clock.skipFreeze ? match.rounds[cur].freezeEndTick : match.rounds[cur].startTick;
    let idx = cur + d;
    if (d < 0 && clock.tick - startCur > 3 * match.tickRate) idx = cur;
    st.jumpToRound(Math.max(0, Math.min(match.rounds.length - 1, idx)));
  };
  const sec = r ? (tick - r.freezeEndTick) / match.tickRate : 0;
  const rdur = r ? (r.endTick - r.freezeEndTick) / match.tickRate : 0;
  return (
    <div className="transport">
      <button className="ibtn" title="Önceki raunt ([)" onClick={() => gotoRound(-1)}>
        <Icon n="prev" />
      </button>
      <button className="ibtn" title="Önceki öldürme (J)" onClick={prevKill}>
        <Icon n="rew" />
      </button>
      <button className="ibtn play" title="Oynat / Duraklat (Boşluk)" onClick={() => clock.toggle()}>
        <Icon n={st.playing ? "pause" : "play"} size={18} />
      </button>
      <button className="ibtn" title="Sonraki öldürme (K)" onClick={nextKill}>
        <Icon n="fwd" />
      </button>
      <button className="ibtn" title="Sonraki raunt (])" onClick={() => gotoRound(1)}>
        <Icon n="next" />
      </button>
      <div className="timecode">
        <b>Raunt {r?.number ?? "-"}</b>
        <span>{fmtClock(sec)}</span>
        <i>/ {fmtClock(rdur)}</i>
      </div>
      <div className="speeds" role="group" aria-label="Hız">
        {SPEEDS.map((s) => (
          <button key={s} className={"chip" + (st.speed === s ? " on" : "")} onClick={() => clock.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <label className="check" title="Hazırlık süresini atla">
        <input type="checkbox" checked={st.skipFreeze} onChange={(e) => clock.setSkipFreeze(e.target.checked)} />
        Hazırlığı atla
      </label>
      <div className="grow" />
      <div className="rangectl">
        <span className="muted">Aralık:</span>
        <button className="chip" title="Bu turu seç" onClick={() => r && st.set({ range: { a: r.freezeEndTick, b: r.endTick } })}>
          Turu seç
        </button>
        <button className="chip" title="Başlangıç noktası (I)" onClick={() => st.set({ range: { a: clock.tick, b: Math.max(clock.tick + match.tickRate * 2, st.range?.b ?? clock.tick + match.tickRate * 10) } })}>
          Giriş
        </button>
        <button className="chip" title="Bitiş noktası (O)" onClick={() => st.set({ range: { a: Math.min(st.range?.a ?? clock.tick - match.tickRate * 10, clock.tick - match.tickRate * 2), b: clock.tick } })}>
          Çıkış
        </button>
        {st.range && (
          <>
            <span className="rangeinfo">{fmtClock((st.range.b - st.range.a) / match.tickRate)}</span>
            <button className="chip" onClick={() => st.set({ range: null })}>
              Temizle
            </button>
          </>
        )}
        <button className="chip accent" onClick={() => st.set({ exportOpen: true })}>
          Video dışa aktar
        </button>
      </div>
    </div>
  );
}

export function Timeline() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const range = useStore((s) => s.range);
  const setS = useStore((s) => s.set);
  const wrapA = useRef<HTMLDivElement>(null);
  const wrapB = useRef<HTMLDivElement>(null);
  const cvA = useRef<HTMLCanvasElement>(null);
  const cvB = useRef<HTMLCanvasElement>(null);
  const sA = useSize(wrapA);
  const sB = useSize(wrapB);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const hoverRef = useRef<Marker | null>(null);
  const dragRef = useRef<{ kind: "scrub" | "new" | "a" | "b" | "move"; t0: number; r0?: { a: number; b: number } } | null>(null);
  const tr = match.tickRate;
  const total = match.lastTick - match.firstTick || 1;
  const hv = useRef<{ x: number } | null>(null);

  const ri0 = () => Math.max(0, match.roundIndexAt(clock.tick));
  const markersFor = (ri: number) => buildMarkers(match, ri, sel);
  const t2 = useTick(2);
  const riMemo = Math.max(0, match.roundIndexAt(t2));
  const markers = useMemo(() => markersFor(riMemo), [match, sel, riMemo]); // eslint-disable-line

  const roundSpan = (ri: number) => {
    const r = match.rounds[ri];
    return { a: r.startTick, b: Math.max(r.officialEndTick, r.endTick + 1) };
  };

  useRaf(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const tick = clock.tick;
    const ri = ri0();
    // ----- match bar
    if (cvA.current && sA.w) {
      const c = cvA.current;
      if (c.width !== Math.floor(sA.w * dpr) || c.height !== Math.floor(sA.h * dpr)) {
        c.width = Math.floor(sA.w * dpr);
        c.height = Math.floor(sA.h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = sA.w,
        H = sA.h;
      ctx.clearRect(0, 0, W, H);
      const X = (t: number) => ((t - match.firstTick) / total) * W;
      match.rounds.forEach((r, i) => {
        const x0 = X(r.startTick),
          x1 = i + 1 < match.rounds.length ? X(match.rounds[i + 1].startTick) : W;
        const winCol = r.winner ? SIDE_COLOR[r.winner] : "#556";
        ctx.fillStyle = i === ri ? "#1d2a40" : "#141c2a";
        ctx.fillRect(x0 + 1, 0, Math.max(1, x1 - x0 - 2), H);
        ctx.fillStyle = winCol;
        ctx.globalAlpha = i === ri ? 1 : 0.75;
        ctx.fillRect(x0 + 1, H - 5, Math.max(1, x1 - x0 - 2), 5);
        ctx.globalAlpha = 1;
        // kills of watched player
        for (const k of match.killsByRound[i]) {
          if (k.attacker === sel) {
            ctx.fillStyle = "#3ddc84";
            ctx.fillRect(X(k.tick) - 1, 3, 2, H - 10);
          } else if (k.victim === sel) {
            ctx.fillStyle = "#ff5c6c";
            ctx.fillRect(X(k.tick) - 1, 3, 2, H - 10);
          }
        }
        if (x1 - x0 > 14) {
          ctx.fillStyle = i === ri ? "#fff" : "#7f8ea6";
          ctx.font = "600 10px system-ui, sans-serif";
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(String(r.number), x0 + 4, 3);
        }
      });
      if (range) {
        ctx.fillStyle = "rgba(53,208,186,0.25)";
        ctx.fillRect(X(range.a), 0, X(range.b) - X(range.a), H);
        ctx.strokeStyle = "#35d0ba";
        ctx.strokeRect(X(range.a) + 0.5, 0.5, X(range.b) - X(range.a), H - 1);
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect(X(tick) - 1, 0, 2, H);
    }
    // ----- round track
    if (cvB.current && sB.w) {
      const c = cvB.current;
      if (c.width !== Math.floor(sB.w * dpr) || c.height !== Math.floor(sB.h * dpr)) {
        c.width = Math.floor(sB.w * dpr);
        c.height = Math.floor(sB.h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = sB.w,
        H = sB.h;
      ctx.clearRect(0, 0, W, H);
      const r = match.rounds[ri];
      const sp = roundSpan(ri);
      const X = (t: number) => GUT + ((t - sp.a) / (sp.b - sp.a)) * (W - GUT - 8);
      // freeze
      ctx.fillStyle = "rgba(120,140,170,0.1)";
      ctx.fillRect(X(r.startTick), 0, X(r.freezeEndTick) - X(r.startTick), H);
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(GUT, ROW_Y[0] - 9, W - GUT - 8, 18);
      ctx.fillRect(GUT, ROW_Y[1] - 9, W - GUT - 8, 18);
      ctx.fillRect(GUT, ROW_Y[2] - 9, W - GUT - 8, 18);
      ctx.fillRect(GUT, ROW_Y[3] - 9, W - GUT - 8, 18);
      // after-end region
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(X(r.endTick), 0, W - X(r.endTick), H);
      // ruler
      ctx.fillStyle = "#6c7b92";
      ctx.font = "500 9.5px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.strokeStyle = "rgba(140,160,190,0.18)";
      ctx.lineWidth = 1;
      const startSec = Math.ceil((sp.a - r.freezeEndTick) / tr / 10) * 10;
      for (let s = startSec; r.freezeEndTick + s * tr < sp.b; s += 10) {
        const x = X(r.freezeEndTick + s * tr);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 11);
        ctx.lineTo(x + 0.5, H - 14);
        ctx.stroke();
        ctx.fillText(fmtClock(s), x, 0);
      }
      // row labels
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(127,142,166,0.75)";
      ctx.font = "500 9px system-ui, sans-serif";
      ["Öldürme / Ölüm", "Yardımcı", "Bomba", "İçgörü"].forEach((l, i) => ctx.fillText(l, 8, ROW_Y[i] - 4));
      for (const mk of markers) {
        const x = X(mk.tick);
        if (x < 0 || x > W) continue;
        shape(ctx, mk, x, ROW_Y[mk.row], hoverRef.current === mk);
      }
      // range strip
      const yy = H - 12;
      ctx.fillStyle = "rgba(127,142,166,0.75)";
      ctx.fillText("Aralık seç", 8, yy);
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(GUT, yy, W - GUT - 8, 9);
      if (range) {
        const x0 = X(Math.max(sp.a, range.a)),
          x1 = X(Math.min(sp.b, range.b));
        if (x1 > x0) {
          ctx.fillStyle = "rgba(53,208,186,0.35)";
          ctx.fillRect(x0, yy, x1 - x0, 9);
          ctx.fillStyle = "rgba(53,208,186,0.12)";
          ctx.fillRect(x0, 0, x1 - x0, yy);
        }
        ctx.fillStyle = "#35d0ba";
        if (range.a >= sp.a && range.a <= sp.b) ctx.fillRect(X(range.a) - 2, yy - 3, 4, 15);
        if (range.b >= sp.a && range.b <= sp.b) ctx.fillRect(X(range.b) - 2, yy - 3, 4, 15);
      }
      // playhead
      const px = X(tick);
      ctx.fillStyle = "#fff";
      ctx.fillRect(px - 1, 0, 2, H);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 6);
      ctx.fill();
      // hover guide
      if (hv.current) {
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(hv.current.x, 0, 1, H);
      }
    }
  });

  const trackTick = (e: React.PointerEvent, ri: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sp = roundSpan(ri);
    const f = (e.clientX - rect.left - GUT) / (rect.width - GUT - 8);
    return Math.max(sp.a, Math.min(sp.b, sp.a + f * (sp.b - sp.a)));
  };
  const matchTick = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return match.firstTick + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total;
  };

  const onDownB = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const ri = ri0();
    const t = trackTick(e, ri);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const sp = roundSpan(ri);
    const pxPerTick = (rect.width - GUT - 8) / (sp.b - sp.a);
    if (y > rect.height - 18) {
      const rg = useStore.getState().range;
      if (rg && Math.abs(t - rg.a) * pxPerTick < 7) dragRef.current = { kind: "a", t0: t };
      else if (rg && Math.abs(t - rg.b) * pxPerTick < 7) dragRef.current = { kind: "b", t0: t };
      else if (rg && t > rg.a && t < rg.b) dragRef.current = { kind: "move", t0: t, r0: { ...rg } };
      else {
        dragRef.current = { kind: "new", t0: t };
        setS({ range: { a: t, b: t + 1 } });
      }
      return;
    }
    // marker click?
    const mk = nearestMarker(e, ri);
    if (mk) {
      clock.seek(mk.seek);
      return;
    }
    dragRef.current = { kind: "scrub", t0: t };
    clock.seek(t);
  };
  const nearestMarker = (e: React.PointerEvent, ri: number): Marker | null => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const sp = roundSpan(ri);
    const px = e.clientX - rect.left,
      py = e.clientY - rect.top;
    let best: Marker | null = null;
    let bd = 1e9;
    for (const mk of markers) {
      const x = GUT + ((mk.tick - sp.a) / (sp.b - sp.a)) * (rect.width - GUT - 8);
      const d = Math.hypot(x - px, ROW_Y[mk.row] - py);
      if (d < 9 && d < bd) {
        best = mk;
        bd = d;
      }
    }
    return best;
  };
  const onMoveB = (e: React.PointerEvent) => {
    const ri = ri0();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    hv.current = { x: e.clientX - rect.left };
    const d = dragRef.current;
    const t = trackTick(e, ri);
    if (d) {
      if (d.kind === "scrub") clock.seek(t);
      else if (d.kind === "new") setS({ range: { a: Math.min(d.t0, t), b: Math.max(d.t0, t) } });
      else if (d.kind === "a") {
        const rg = useStore.getState().range!;
        setS({ range: { a: Math.min(t, rg.b - tr), b: rg.b } });
      } else if (d.kind === "b") {
        const rg = useStore.getState().range!;
        setS({ range: { a: rg.a, b: Math.max(t, rg.a + tr) } });
      } else if (d.kind === "move" && d.r0) {
        const dt = t - d.t0;
        setS({ range: { a: d.r0.a + dt, b: d.r0.b + dt } });
      }
      setTip(null);
      return;
    }
    const mk = nearestMarker(e, ri);
    hoverRef.current = mk;
    const r = match.rounds[ri];
    if (mk) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: `${fmtClock((mk.tick - r.freezeEndTick) / tr)} · ${mk.text}` });
    else setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: fmtClock((t - r.freezeEndTick) / tr) });
  };

  const down = useRef(false);
  return (
    <div className="timeline">
      <div ref={wrapA} className="tl-match">
        <canvas
          ref={cvA}
          style={{ width: sA.w, height: sA.h }}
          onPointerDown={(e) => {
            down.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            clock.seek(matchTick(e));
          }}
          onPointerMove={(e) => down.current && clock.seek(matchTick(e))}
          onPointerUp={() => (down.current = false)}
        />
      </div>
      <div ref={wrapB} className="tl-round">
        <canvas
          ref={cvB}
          style={{ width: sB.w, height: sB.h }}
          onPointerDown={onDownB}
          onPointerMove={onMoveB}
          onPointerUp={() => (dragRef.current = null)}
          onPointerLeave={() => {
            setTip(null);
            hoverRef.current = null;
            hv.current = null;
          }}
        />
        {tip && (
          <div className="tip" style={{ left: Math.min(tip.x + 12, sB.w - 240), top: Math.max(0, tip.y - 34) }}>
            {tip.text}
          </div>
        )}
      </div>
    </div>
  );
}
