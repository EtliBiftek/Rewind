import { create } from "zustand";
import type { DemoData, Vec3 } from "./contract";
import { Match } from "./model";
import { clock } from "./clock";
import { getFrames, loadDemoFromPath, loadFixtureDemo, isTauri } from "./backend";

export type Tab = "watch" | "analysis" | "player";
export type AnalysisTab = "scoreboard" | "matrix" | "insights" | "coach";
export type ViewMode = "2d" | "3d" | "split";
export type CamMode = "pov" | "chase" | "free" | "top";
export type SidePanel = "players" | "insights" | "voice";

export interface InsightFilter {
  player: number | "all";
  round: number | "all";
  category: string | "all";
  severity: "all" | "good" | "bad" | "info";
}

export interface Store {
  phase: "start" | "loading" | "ready" | "error";
  progress: { stage: string; pct: number };
  error: string | null;
  match: Match | null;
  tab: Tab;
  analysisTab: AnalysisTab;
  sidePanel: SidePanel;
  viewMode: ViewMode;
  cam: CamMode;
  selected: number;
  playing: boolean;
  speed: number;
  skipFreeze: boolean;
  range: { a: number; b: number } | null;
  follow: boolean;
  level: "all" | "upper" | "lower";
  showLabels: boolean;
  showRadarImg: boolean;
  radarImg: HTMLImageElement | null;
  insightFilter: InsightFilter;
  coachInsight: number | null;
  focus: { pos: Vec3; ts: number } | null;
  exportOpen: boolean;
  exporting: boolean;
  helpOpen: boolean;
  voice: { master: boolean; masterVol: number; onlyTeam: boolean; mutes: Record<number, boolean>; vols: Record<number, number> };
  speakingTick: number;
  set: (p: Partial<Store>) => void;
  openPath: (path: string) => Promise<void>;
  openFixtures: () => Promise<void>;
  select: (slot: number) => void;
  jumpToRound: (idx: number) => void;
  focusInsight: (id: number) => void;
  setVoice: (p: Partial<Store["voice"]>) => void;
}

const defaultVoice = { master: true, masterVol: 1, onlyTeam: false, mutes: {}, vols: {} };

async function finishLoad(demo: DemoData, set: (p: Partial<Store>) => void, onStage: (s: string, p: number) => void) {
  onStage("Kare verisi alınıyor", 0.92);
  const buf = await getFrames();
  onStage("Dizinler oluşturuluyor", 0.97);
  const match = new Match(demo, buf);
  await new Promise((r) => setTimeout(r, 0));
  clock.setMatch(match);
  const r0 = match.rounds[0];
  if (r0) clock.seek(clock.skipFreeze ? r0.freezeEndTick : r0.startTick);
  // pick default watched player: first player of the best score
  const stats = demo.analysis?.players ?? [];
  let sel = 0;
  let best = -1;
  stats.forEach((s, i) => {
    if (s.score > best) {
      best = s.score;
      sel = i;
    }
  });
  set({
    phase: "ready",
    match,
    selected: sel,
    tab: "watch",
    range: null,
    coachInsight: null,
    focus: null,
    insightFilter: { player: "all", round: "all", category: "all", severity: "all" },
    voice: { ...defaultVoice },
    cam: match.demo.voice?.available ? "pov" : "pov",
  });
}

export const useStore = create<Store>((set, get) => ({
  phase: "start",
  progress: { stage: "", pct: 0 },
  error: null,
  match: null,
  tab: "watch",
  analysisTab: "scoreboard",
  sidePanel: "players",
  viewMode: "split",
  cam: "pov",
  selected: 0,
  playing: false,
  speed: 1,
  skipFreeze: true,
  range: null,
  follow: false,
  level: "all",
  showLabels: true,
  showRadarImg: true,
  radarImg: null,
  insightFilter: { player: "all", round: "all", category: "all", severity: "all" },
  coachInsight: null,
  focus: null,
  exportOpen: false,
  exporting: false,
  helpOpen: false,
  voice: { ...defaultVoice },
  speakingTick: 0,
  set: (p) => set(p),
  openPath: async (path) => {
    set({ phase: "loading", error: null, progress: { stage: "Demo okunuyor", pct: 0 } });
    try {
      const demo = await loadDemoFromPath(path, (p) => set({ progress: p }));
      await finishLoad(demo, set, (stage, pct) => set({ progress: { stage, pct } }));
    } catch (e) {
      set({ phase: "error", error: String((e as any)?.message ?? e) });
    }
  },
  openFixtures: async () => {
    set({ phase: "loading", error: null, progress: { stage: "Örnek veri yükleniyor", pct: 0 } });
    try {
      const demo = await loadFixtureDemo((p) => set({ progress: p }));
      await finishLoad(demo, set, (stage, pct) => set({ progress: { stage, pct } }));
    } catch (e) {
      set({ phase: "error", error: String((e as any)?.message ?? e) });
    }
  },
  select: (slot) => set({ selected: slot }),
  jumpToRound: (idx) => {
    const m = get().match;
    if (!m) return;
    const r = m.rounds[idx];
    if (!r) return;
    clock.seek(clock.skipFreeze ? r.freezeEndTick : r.startTick);
  },
  focusInsight: (id) => {
    const m = get().match;
    const ins = m?.insightById.get(id);
    if (!m || !ins) return;
    clock.seek(ins.tick - m.tickRate * 2);
    set({ selected: ins.player, focus: ins.pos ? { pos: ins.pos, ts: performance.now() } : null });
  },
  setVoice: (p) => set((s) => ({ voice: { ...s.voice, ...p } })),
}));

clock.on((e) => {
  if (e === "play" || e === "pause" || e === "speed") useStore.setState({ playing: clock.playing, speed: clock.speed, skipFreeze: clock.skipFreeze });
});

export { isTauri };
(window as any).__rewind = { clock, useStore };
