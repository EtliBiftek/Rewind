import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { clock } from "../lib/clock";
import { useStore, type CamMode } from "../lib/store";
import { useCoachOverlay, useRaf, useSize } from "../lib/hooks";
import { Scene3D, type FreeCam, type TopCam } from "../render/scene3d";
import { drawOverlay3D } from "../render/hud";
import { clearCurrentRealMap, loadRealMap, type RealMapAsset } from "../render/realmap";
import { cs2Status, isTauri, pickCs2Folder, setCs2Path } from "../lib/backend";
import { persist } from "../lib/store";
import type { MapQuality } from "../lib/contract";

const QUALITY_LABELS: Record<MapQuality, string> = { low: "Düşük", medium: "Orta", high: "Yüksek" };

/** Picks the CS2 folder (Tauri dialog), stores it and returns a Turkish error or null. */
export async function chooseCs2Folder(): Promise<string | null> {
  const p = await pickCs2Folder();
  if (!p) return null;
  try {
    const st = await setCs2Path(p);
    useStore.setState({ cs2: st });
    return null;
  } catch (e) {
    return String((e as any)?.message ?? e);
  }
}

function MapNotice() {
  const ms = useStore((s) => s.mapState);
  const real = useStore((s) => s.realMap);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!real) return null;
  if (ms.status === "loading")
    return (
      <div className="map-notice loading" data-testid="map-loading">
        <span className="spin" /> Gerçek harita yükleniyor · {ms.stage} {Math.round(ms.pct * 100)}%
      </div>
    );
  if (ms.status === "fallback" && hidden !== ms.message)
    return (
      <div className="map-notice warn" data-testid="map-fallback">
        <span>Basit görünüm: {ms.message}</span>
        {isTauri() && (
          <button className="chip" onClick={async () => {
            const err = await chooseCs2Folder();
            if (err) useStore.setState({ mapState: { ...useStore.getState().mapState, message: err } });
            else useStore.setState({ mapReload: useStore.getState().mapReload + 1 });
          }}>
            CS2 klasörünü seç
          </button>
        )}
        <button className="ibtn" title="Kapat" onClick={() => setHidden(ms.message)}>
          ×
        </button>
      </div>
    );
  return null;
}

function MapSettings({ onClose }: { onClose: () => void }) {
  const real = useStore((s) => s.realMap);
  const q = useStore((s) => s.mapQuality);
  const cs2 = useStore((s) => s.cs2);
  const ms = useStore((s) => s.mapState);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const m = useStore.getState().match;
    cs2Status(m?.demo.header.mapName).then((st) => useStore.setState({ cs2: st })).catch(() => {});
  }, []);
  return (
    <div className="map-settings" data-testid="map-settings" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ms-head">
        <b>Harita görünümü</b>
        <button className="ibtn" onClick={onClose}>×</button>
      </div>
      <div className="seg">
        <button className={real ? "on" : ""} onClick={() => (persist("realMap", "1"), useStore.setState({ realMap: true }))}>Gerçek harita</button>
        <button className={!real ? "on" : ""} onClick={() => (persist("realMap", "0"), useStore.setState({ realMap: false }))}>Basit görünüm</button>
      </div>
      <label className="ms-row">
        Kalite
        <select value={q} onChange={(e) => (persist("mapQuality", e.target.value), useStore.setState({ mapQuality: e.target.value as MapQuality }))}>
          {(Object.keys(QUALITY_LABELS) as MapQuality[]).map((k) => (
            <option key={k} value={k}>{QUALITY_LABELS[k]}</option>
          ))}
        </select>
      </label>
      <div className="ms-row col">
        <span className="muted">CS2 klasörü {cs2?.source === "manual" ? "(elle seçildi)" : cs2?.source === "auto" ? "(otomatik bulundu)" : ""}</span>
        <code data-testid="cs2-path">{cs2 ? (cs2.found ? cs2.path : cs2.error ?? "bulunamadı") : "…"}</code>
        {cs2?.found && <span className="muted">{cs2.maps.length} harita</span>}
      </div>
      {isTauri() && (
        <div className="ms-row">
          <button className="chip" onClick={async () => setErr(await chooseCs2Folder())}>CS2 klasörünü seç</button>
          {cs2?.source === "manual" && (
            <button className="chip" onClick={async () => { try { useStore.setState({ cs2: await setCs2Path(null) }); setErr(null); } catch (e) { setErr(String(e)); } }}>
              Otomatik bul
            </button>
          )}
        </div>
      )}
      {err && <div className="ms-err">{err}</div>}
      {ms.info && <div className="muted small" data-testid="map-info">{ms.info}</div>}
    </div>
  );
}

export const CAM_LABELS: Record<CamMode, string> = { pov: "Birinci şahıs", chase: "Takip", free: "Serbest", top: "Üstten" };

export function View3D() {
  const match = useStore((s) => s.match)!;
  const cam = useStore((s) => s.cam);
  const set = useStore((s) => s.set);
  const coach = useCoachOverlay();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const ov = useRef<HTMLCanvasElement>(null);
  const { w, h } = useSize(wrap);
  const scene = useRef<Scene3D | null>(null);
  const rend = useRef<THREE.WebGLRenderer | null>(null);
  const free = useRef<FreeCam | null>(null);
  const top = useRef<TopCam | null>(null);
  const keys = useRef(new Set<string>());
  const drag = useRef<{ x: number; y: number } | null>(null);
  const lastT = useRef(performance.now());
  const [err, setErr] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const realMap = useStore((s) => s.realMap);
  const mapQuality = useStore((s) => s.mapQuality);
  const mapReload = useStore((s) => s.mapReload);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    try {
      const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: false });
      r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      r.outputColorSpace = THREE.SRGBColorSpace;
      rend.current = r;
      const sc = new Scene3D(match, r);
      scene.current = sc;
      free.current = sc.defaultFree();
      top.current = sc.defaultTop();
      (window as any).__scene3d = sc;
    } catch (e) {
      setErr("WebGL başlatılamadı: " + String((e as Error).message ?? e));
    }
    return () => {
      scene.current?.dispose();
      rend.current?.dispose();
      scene.current = null;
      rend.current = null;
    };
  }, [match]);

  // real map: load (backend export / cache / fixture) and swap it in; fall back to the reconstructed floor
  useEffect(() => {
    const sc = scene.current;
    const r = rend.current;
    if (!sc || !r) return;
    const map = (match.demo.header.mapName || match.demo.map.name || "").split(/[\\/]/).pop()!.toLowerCase();
    if (!realMap) {
      sc.setRealMap(null);
      clearCurrentRealMap();
      useStore.setState({ mapState: { status: "off", map, stage: "", pct: 0, message: null, info: null } });
      return;
    }
    let alive = true;
    useStore.setState({ mapState: { status: "loading", map, stage: "Başlatılıyor", pct: 0, message: null, info: null } });
    loadRealMap(r, map, mapQuality, (p) => {
      if (alive) useStore.setState({ mapState: { ...useStore.getState().mapState, stage: p.stage, pct: p.pct } });
    })
      .then((asset: RealMapAsset) => {
        if (!alive || scene.current !== sc) return;
        sc.setRealMap(asset);
        const st = asset.stats;
        const info = `${(st.triangles / 1e6).toFixed(2)} M üçgen · ${st.drawCalls} çizim · ${st.materials} malzeme · ${st.textures} doku (${st.textureMB} MB) · ${st.glbMB} MB · ${st.fetchMs + st.parseMs} ms`;
        useStore.setState({ mapState: { status: "ready", map, stage: "Hazır", pct: 1, message: null, info } });
        (window as any).__realmap = asset;
      })
      .catch((e) => {
        if (!alive) return;
        sc.setRealMap(null);
        clearCurrentRealMap();
        useStore.setState({ mapState: { status: "fallback", map, stage: "", pct: 0, message: String((e as any)?.message ?? e), info: null } });
      });
    return () => {
      alive = false;
    };
  }, [match, realMap, mapQuality, mapReload]);

  // frame the coach throw: free camera behind the suggested stand position
  const coachId = coach?.insight.id;
  useEffect(() => {
    if (!coach || !free.current) return;
    const s = coach.suggestion;
    const g = coach.grenade;
    const fx = g ? g.throwPos[0] : s.from[0],
      fy = g ? g.throwPos[1] : s.from[1];
    const dx = s.land[0] - s.from[0],
      dy = s.land[1] - s.from[1];
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len,
      uy = dy / len;
    const cx = (s.from[0] + s.land[0] + (g?.detonatePos?.[0] ?? s.land[0])) / 3;
    const cy = (s.from[1] + s.land[1] + (g?.detonatePos?.[1] ?? s.land[1])) / 3;
    const dist = Math.max(450, len * 0.9);
    const pos = { x: s.from[0] - ux * dist * 0.7 + (fx - s.from[0]) * 0.3, y: s.from[1] - uy * dist * 0.7 + (fy - s.from[1]) * 0.3, z: s.from[2] + Math.max(260, len * 0.55) };
    const tx = cx,
      ty = cy,
      tz = s.from[2] + 80;
    const hd = Math.hypot(tx - pos.x, ty - pos.y);
    free.current = { ...pos, yaw: (Math.atan2(ty - pos.y, tx - pos.x) * 180) / Math.PI, pitch: (Math.atan2(pos.z - tz, hd) * 180) / Math.PI };
    if (useStore.getState().tab === "analysis") useStore.setState({ cam: "free" });
  }, [coachId]); // eslint-disable-line

  useEffect(() => {
    if (rend.current && w && h) rend.current.setSize(w, h, false);
  }, [w, h]);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      keys.current.add(e.key.toLowerCase());
    };
    const ku = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useRaf((now) => {
    const sc = scene.current;
    const o = ov.current;
    if (!sc || !w || !h || !free.current || !top.current || useStore.getState().exporting) return;
    const dt = Math.min(0.1, (now - lastT.current) / 1000);
    lastT.current = now;
    const s = useStore.getState();
    const f = free.current;
    if (s.cam === "free") {
      const k = keys.current;
      const sp = (k.has("shift") ? 2600 : 900) * dt;
      const yaw = (f.yaw * Math.PI) / 180;
      const pit = (-f.pitch * Math.PI) / 180;
      const fx = Math.cos(yaw) * Math.cos(pit),
        fy = Math.sin(yaw) * Math.cos(pit),
        fz = Math.sin(pit);
      const rx = Math.sin(yaw),
        ry = -Math.cos(yaw);
      if (k.has("w")) {
        f.x += fx * sp;
        f.y += fy * sp;
        f.z += fz * sp;
      }
      if (k.has("s")) {
        f.x -= fx * sp;
        f.y -= fy * sp;
        f.z -= fz * sp;
      }
      if (k.has("d")) {
        f.x += rx * sp;
        f.y += ry * sp;
      }
      if (k.has("a")) {
        f.x -= rx * sp;
        f.y -= ry * sp;
      }
      if (k.has("e")) f.z += sp;
      if (k.has("q")) f.z -= sp;
    }
    const tick = clock.tick;
    const speaking = match.speakingSlots(tick);
    sc.setCoach(coach);
    sc.update(tick, { mode: s.cam, selected: s.selected, free: f, top: top.current, w, h }, { speaking, focus: s.focus, now });
    if (o) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (o.width !== Math.floor(w * dpr)) {
        o.width = Math.floor(w * dpr);
        o.height = Math.floor(h * dpr);
      }
      const ctx = o.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay3D(ctx, match, tick, s.selected, s.cam, w, h);
    }
  });

  return (
    <div className="view3d" ref={wrap}>
      <canvas
        ref={cv}
        style={{ width: w, height: h, cursor: cam === "free" || cam === "top" ? "grab" : "default" }}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x,
            dy = e.clientY - d.y;
          d.x = e.clientX;
          d.y = e.clientY;
          if (cam === "free" && free.current) {
            free.current.yaw -= dx * 0.2;
            free.current.pitch = Math.max(-89, Math.min(89, free.current.pitch + dy * 0.2));
          } else if (cam === "top" && top.current) {
            const k = top.current.h / (h || 600) * 1.1;
            top.current.cx -= dx * k;
            top.current.cy += dy * k;
          }
        }}
        onWheel={(e) => {
          if (cam === "top" && top.current) top.current.h = Math.max(600, Math.min(20000, top.current.h * Math.exp(e.deltaY * 0.0012)));
          if (cam === "free" && free.current) {
            const f = free.current;
            const yaw = (f.yaw * Math.PI) / 180,
              pit = (-f.pitch * Math.PI) / 180;
            const sp = -e.deltaY * 1.2;
            f.x += Math.cos(yaw) * Math.cos(pit) * sp;
            f.y += Math.sin(yaw) * Math.cos(pit) * sp;
            f.z += Math.sin(pit) * sp;
          }
        }}
      />
      <canvas ref={ov} className="overlay" style={{ width: w, height: h }} />
      <div className="viewbar">
        {(Object.keys(CAM_LABELS) as CamMode[]).map((m) => (
          <button key={m} className={"chip" + (cam === m ? " on" : "")} onClick={() => set({ cam: m })}>
            {CAM_LABELS[m]}
          </button>
        ))}
        {cam === "free" && <span className="hint">WASD · Q/E · Shift hızlı · sürükle: bak</span>}
        {cam === "top" && <span className="hint">Sürükle: kaydır · tekerlek: yakınlaş</span>}
        <span className="grow" />
        <button className={"chip" + (showSettings ? " on" : "")} title="Harita ayarları" data-testid="map-settings-btn" onClick={() => setShowSettings((v) => !v)}>
          {realMap ? "Gerçek harita" : "Basit görünüm"} ⚙
        </button>
      </div>
      <MapNotice />
      {showSettings && <MapSettings onClose={() => setShowSettings(false)} />}
      {err && <div className="center-msg">{err}</div>}
    </div>
  );
}
