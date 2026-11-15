import { useEffect, useRef, useState, useCallback } from "react";
import { clock } from "../lib/clock";
import { useStore } from "../lib/store";
import { useCoachOverlay, useRaf, useSize } from "../lib/hooks";
import { drawScene, fitView, type HeatLayer, type View2D } from "../render/draw2d";
import { blobToImage, clearRadar, loadRadar, saveRadar } from "../lib/radarStore";
import { isAlive, newPState, type PState } from "../lib/model";

interface Props {
  heat?: HeatLayer[];
  /** static = no entities / no interaction with the clock (used by player page) */
  mode?: "live" | "static";
  toolbar?: boolean;
}

export function Map2D({ heat, mode = "live", toolbar = true }: Props) {
  const match = useStore((s) => s.match)!;
  const st = useStore();
  const coach = useCoachOverlay();
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const { w, h } = useSize(wrap);
  const view = useRef<View2D | null>(null);
  const user = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const ps = useRef<PState>(newPState());
  const [hasRadar, setHasRadar] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const live = mode === "live";

  // refit when size / match changes and the user has not moved the view
  useEffect(() => {
    if (!w || !h) return;
    if (!view.current || !user.current) view.current = fitView(match, w, h);
  }, [w, h, match]);

  // load persisted radar image for this map
  useEffect(() => {
    let dead = false;
    loadRadar(match.demo.map.name).then((img) => {
      if (dead) return;
      useStore.setState({ radarImg: img });
      setHasRadar(!!img);
    });
    return () => {
      dead = true;
    };
  }, [match]);

  // focus on insight
  const focus = st.focus;
  useEffect(() => {
    if (!focus || !view.current || !live) return;
    const v = view.current;
    v.cx = focus.pos[0];
    v.cy = focus.pos[1];
    const fit = fitView(match, w || 800, h || 600);
    v.s = Math.max(v.s, fit.s * 2.4);
    user.current = true;
    useStore.setState({ follow: false });
  }, [focus?.ts]); // eslint-disable-line

  // frame coach throw
  useEffect(() => {
    if (!coach || !view.current || !live || !w) return;
    const xs: number[] = [coach.suggestion.from[0], coach.suggestion.land[0]];
    const ys: number[] = [coach.suggestion.from[1], coach.suggestion.land[1]];
    if (coach.grenade) {
      xs.push(coach.grenade.throwPos[0], ...(coach.grenade.detonatePos ? [coach.grenade.detonatePos[0]] : []));
      ys.push(coach.grenade.throwPos[1], ...(coach.grenade.detonatePos ? [coach.grenade.detonatePos[1]] : []));
    }
    const x0 = Math.min(...xs),
      x1 = Math.max(...xs),
      y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    const s = Math.min(w / Math.max(500, (x1 - x0) * 1.9), h / Math.max(500, (y1 - y0) * 1.9));
    view.current = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s };
    user.current = true;
    useStore.setState({ follow: false });
  }, [coach?.insight.id, w, h]); // eslint-disable-line

  useRaf((now) => {
    const c = cv.current;
    if (!c || !w || !h || !view.current || useStore.getState().exporting) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = useStore.getState();
    const tick = clock.tick;
    if (live && s.follow && !drag.current) {
      const p = match.sample(tick, s.selected, ps.current);
      if (isAlive(p)) {
        const v = view.current;
        v.cx += (p.x - v.cx) * 0.18;
        v.cy += (p.y - v.cy) * 0.18;
      }
    }
    drawScene(ctx, {
      match,
      tick,
      view: view.current,
      w,
      h,
      selected: s.selected,
      level: s.level,
      radarImg: s.radarImg,
      showRadar: s.showRadarImg,
      labels: s.showLabels,
      speaking: match.speakingSlots(tick),
      focus: live ? s.focus : null,
      coach: live ? coach : null,
      heat,
      hud: live,
      feed: live,
      entities: live,
      now,
    });
  });

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const v = view.current;
      if (!v || !cv.current) return;
      const r = cv.current.getBoundingClientRect();
      const mx = e.clientX - r.left,
        my = e.clientY - r.top;
      const wx = v.cx + (mx - w / 2) / v.s;
      const wy = v.cy - (my - h / 2) / v.s;
      const k = Math.exp(-e.deltaY * 0.0015);
      const fit = fitView(match, w, h);
      v.s = Math.min(fit.s * 14, Math.max(fit.s * 0.5, v.s * k));
      if (!useStore.getState().follow) {
        v.cx = wx - (mx - w / 2) / v.s;
        v.cy = wy + (my - h / 2) / v.s;
      }
      user.current = true;
    },
    [w, h, match],
  );

  const toolBtn = (active: boolean) => "chip" + (active ? " on" : "");
  const hasLower = match.demo.map.lowerLevelMaxZ != null;

  return (
    <div className="map2d" ref={wrap}>
      <canvas
        ref={cv}
        style={{ width: w, height: h, cursor: drag.current ? "grabbing" : "grab" }}
        onWheel={onWheel}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const v = view.current;
          if (!d || !v) return;
          v.cx -= (e.clientX - d.x) / v.s;
          v.cy += (e.clientY - d.y) / v.s;
          d.x = e.clientX;
          d.y = e.clientY;
          user.current = true;
          if (useStore.getState().follow) useStore.setState({ follow: false });
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => {
          view.current = fitView(match, w, h);
          user.current = false;
        }}
      />
      {toolbar && (
        <div className="viewbar">
          {live && (
            <button
              className={toolBtn(st.follow)}
              title="Seçili oyuncuyu takip et (F)"
              onClick={() => {
                if (!st.follow && view.current) view.current.s = Math.max(view.current.s, fitView(match, w, h).s * 2.4);
                st.set({ follow: !st.follow });
              }}
            >
              Takip
            </button>
          )}
          <button className={toolBtn(st.showLabels)} onClick={() => st.set({ showLabels: !st.showLabels })}>
            Etiketler
          </button>
          <button
            className="chip"
            title="Haritayı sığdır"
            onClick={() => {
              view.current = fitView(match, w, h);
              user.current = false;
            }}
          >
            Sığdır
          </button>
          {hasLower && (
            <select className="chip" value={st.level} onChange={(e) => st.set({ level: e.target.value as any })}>
              <option value="all">Tüm katlar</option>
              <option value="upper">Üst kat</option>
              <option value="lower">Alt kat</option>
            </select>
          )}
          <button className="chip" title="Kendi radar görselinizi (PNG) yükleyin" onClick={() => file.current?.click()}>
            Radar yükle
          </button>
          {hasRadar && (
            <>
              <button className={toolBtn(st.showRadarImg)} onClick={() => st.set({ showRadarImg: !st.showRadarImg })}>
                Radar görseli
              </button>
              <button
                className="chip"
                onClick={() => {
                  void clearRadar(match.demo.map.name);
                  useStore.setState({ radarImg: null });
                  setHasRadar(false);
                }}
              >
                Kaldır
              </button>
            </>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const img = await blobToImage(f);
              await saveRadar(match.demo.map.name, f);
              useStore.setState({ radarImg: img, showRadarImg: true });
              setHasRadar(true);
              if (!match.demo.map.known) alert("Bu harita için resmi radar dönüşümü bilinmiyor; görsel yalnızca bilinen haritalarda hizalanır.");
              e.target.value = "";
            }}
          />
        </div>
      )}
      {live && !match.demo.map.known && <div className="badge-warn">Bilinmeyen harita · zemin planı oyuncu konumlarından üretildi</div>}
    </div>
  );
}
