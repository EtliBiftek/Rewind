import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStore } from "./store";
import type { CoachOverlay } from "../render/draw2d";

export function useCoachOverlay(): CoachOverlay | null {
  const match = useStore((s) => s.match);
  const rawId = useStore((s) => s.coachInsight);
  const active = useStore((s) => s.tab === "analysis" && s.analysisTab === "coach");
  const id = active ? rawId : null;
  return useMemo(() => {
    if (!match || id == null) return null;
    const ins = match.insightById.get(id);
    if (!ins || !ins.suggestion) return null;
    return { insight: ins, suggestion: ins.suggestion, grenade: ins.grenadeId != null ? (match.grenadeById.get(ins.grenadeId) ?? null) : null };
  }, [match, id]);
}

/** Observe element size (CSS px). */
export function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, set] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => set({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) }));
    ro.observe(el);
    set({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** requestAnimationFrame loop that always calls the latest callback. */
export function useRaf(cb: (now: number) => void, active = true) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = (t: number) => {
      if (!(window as any).__freeze) ref.current(t);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}
