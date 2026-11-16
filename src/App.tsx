import { useEffect } from "react";
import { clock } from "./lib/clock";
import { useStore, type CamMode, type ViewMode } from "./lib/store";
import { wireVoice } from "./lib/voice";
import { StartScreen } from "./components/StartScreen";
import { Map2D } from "./components/Map2D";
import { View3D } from "./components/View3D";
import { Timeline, Transport } from "./components/Timeline";
import { LiveScoreboard, RoundList, SideInsights, VoicePanel } from "./components/Panels";
import { AnalysisPage } from "./components/Analysis";
import { PlayerPage } from "./components/PlayerPage";
import { ExportDialog } from "./components/ExportDialog";
import { Icon } from "./components/icons";
import { isTauri } from "./lib/backend";

wireVoice();

function Viewport({ stack }: { stack?: boolean }) {
  const mode = useStore((s) => s.viewMode);
  return (
    <div className={"viewport" + (stack ? " stack" : "")}>
      {(mode === "2d" || mode === "split") && (
        <div className="vp-pane">
          <Map2D />
        </div>
      )}
      {(mode === "3d" || mode === "split") && (
        <div className="vp-pane">
          <View3D />
        </div>
      )}
    </div>
  );
}

function SidePanel() {
  const panel = useStore((s) => s.sidePanel);
  const set = useStore((s) => s.set);
  const match = useStore((s) => s.match)!;
  const tabs = [
    { k: "players", l: "Oyuncular" },
    { k: "insights", l: "İçgörüler" },
    { k: "voice", l: "Ses" },
  ] as const;
  return (
    <div className="sidepanel">
      <div className="subtabs small">
        {tabs.map((t) => (
          <button key={t.k} className={panel === t.k ? "on" : ""} onClick={() => set({ sidePanel: t.k })}>
            {t.l}
            {t.k === "voice" && !match.demo.voice?.available && <em className="off">yok</em>}
          </button>
        ))}
      </div>
      <div className="sp-body">
        {panel === "players" && <LiveScoreboard />}
        {panel === "insights" && <SideInsights />}
        {panel === "voice" && <VoicePanel />}
      </div>
    </div>
  );
}

function TopBar() {
  const st = useStore();
  const m = st.match!;
  const last = m.rounds[m.rounds.length - 1];
  const w = last?.winner ? last.teamSides.indexOf(last.winner) : -1;
  const sc = last ? [last.scoreBefore[0] + (w === 0 ? 1 : 0), last.scoreBefore[1] + (w === 1 ? 1 : 0)] : [0, 0];
  const t0 = m.players.find((p) => p.team === 0)?.teamName ?? "Takım 1";
  const t1 = m.players.find((p) => p.team === 1)?.teamName ?? "Takım 2";
  const tabs = [
    { k: "watch", l: "İzle", i: "play" },
    { k: "analysis", l: "Analiz", i: "chart" },
    { k: "player", l: "Oyuncu", i: "user" },
  ] as const;
  const views: { k: ViewMode; l: string; i: string }[] = [
    { k: "2d", l: "2B", i: "map" },
    { k: "3d", l: "3B", i: "cube" },
    { k: "split", l: "Bölünmüş", i: "split" },
  ];
  return (
    <div className="topbar">
      <div className="brand">
        <svg width="22" height="22" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="8" fill="#13202e" stroke="#2a3d55" />
          <path d="M17 8l-9 8 9 8v-6c5 0 8 2 10 5-1-6-4-11-10-12z" fill="#35d0ba" />
        </svg>
        <b>Rewind</b>
      </div>
      <div className="matchinfo" title={m.demo.header.fileName}>
        <span className="mapname">{m.demo.header.mapName}</span>
        <span className="team" style={{ color: "#5aa9ff" }}>
          {t0}
        </span>
        <b className="scoreline">
          {sc[0]} : {sc[1]}
        </b>
        <span className="team" style={{ color: "#f0a64a" }}>
          {t1}
        </span>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.k} className={st.tab === t.k ? "on" : ""} onClick={() => st.set({ tab: t.k })}>
            <Icon n={t.i} size={14} /> {t.l}
          </button>
        ))}
      </div>
      <div className="grow" />
      {st.tab !== "player" && (
        <div className="seg views" role="group" aria-label="Görünüm">
          {views.map((v) => (
            <button key={v.k} className={"chip" + (st.viewMode === v.k ? " on" : "")} onClick={() => st.set({ viewMode: v.k })} title={`${v.l} görünüm (V)`}>
              <Icon n={v.i} size={13} /> {v.l}
            </button>
          ))}
        </div>
      )}
      <div className="watched" title="İzlenen oyuncu (1–9, 0 tuşları)">
        <Icon n="user" size={13} />
        <select value={st.selected} onChange={(e) => st.select(parseInt(e.target.value))}>
          {m.players.map((p) => (
            <option key={p.slot} value={p.slot}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <button className="chip" title="Klavye kısayolları (?)" onClick={() => st.set({ helpOpen: true })}>
        <Icon n="help" size={13} />
      </button>
      <button
        className="chip"
        onClick={() => {
          clock.pause();
          useStore.setState({ phase: "start", match: null });
          clock.setMatch(null);
          if (!isTauri()) history.replaceState(null, "", "?manual");
        }}
      >
        <Icon n="folder" size={13} /> Başka demo
      </button>
    </div>
  );
}

function Help() {
  const set = useStore((s) => s.set);
  const rows: [string, string][] = [
    ["Boşluk", "Oynat / duraklat"],
    ["← / →", "5 sn geri / ileri (Shift: 1 sn, Ctrl: 15 sn)"],
    ["↑ / ↓", "Hızı artır / azalt"],
    ["[  ]", "Önceki / sonraki raunt"],
    ["J / K", "Önceki / sonraki öldürme"],
    ["1–9, 0", "Oyuncu seç (skor tablosu sırası)"],
    ["V", "2B / 3B / bölünmüş görünüm"],
    ["C", "3B kamera: birinci şahıs, takip, serbest, üstten"],
    ["W A S D Q E", "Serbest kamerada uçuş (Shift: hızlı)"],
    ["F", "2B haritada seçili oyuncuyu takip et"],
    ["M", "Ana sesi aç / kapat"],
    ["I / O", "Aralık başlangıç / bitiş noktası"],
    ["Home", "Rauntun başına git"],
    ["?", "Bu pencere"],
  ];
  return (
    <div className="modal-back" onClick={() => set({ helpOpen: false })}>
      <div className="modal help" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Icon n="help" size={18} />
          <b>Klavye kısayolları</b>
          <span className="grow" />
          <button className="ibtn" onClick={() => set({ helpOpen: false })}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <dl className="keys">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const m = st.match;
      if (!m || st.phase !== "ready") return;
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === "INPUT" && (el as HTMLInputElement).type !== "checkbox" && (el as HTMLInputElement).type !== "range") return;
      if (tag === "TEXTAREA") return;
      if (e.altKey || e.metaKey) return;
      if (st.exportOpen && e.key !== "Escape") return;
      const tr = m.tickRate;
      const k = e.key;
      const speeds = [0.25, 0.5, 1, 2, 4, 8];
      let handled = true;
      if (k === " ") {
        if (tag === "SELECT") return;
        clock.toggle();
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        if (tag === "SELECT" || tag === "INPUT") return;
        const d = e.shiftKey ? 1 : e.ctrlKey ? 15 : 5;
        clock.seekBy(k === "ArrowLeft" ? -d : d);
      } else if (k === "ArrowUp" || k === "ArrowDown") {
        if (tag === "SELECT" || tag === "INPUT") return;
        const i = speeds.indexOf(clock.speed);
        clock.setSpeed(speeds[Math.max(0, Math.min(speeds.length - 1, (i < 0 ? 2 : i) + (k === "ArrowUp" ? 1 : -1)))]);
      } else if (k === "[" || k === "]") {
        const cur = m.roundIndexAt(clock.tick);
        st.jumpToRound(Math.max(0, Math.min(m.rounds.length - 1, cur + (k === "]" ? 1 : -1))));
      } else if (k === "Home") {
        st.jumpToRound(m.roundIndexAt(clock.tick));
      } else if (k.toLowerCase() === "k" || k.toLowerCase() === "j") {
        const kills = (m.demo.kills ?? []).filter((x) => x.attacker === st.selected);
        const src = kills.length ? kills : (m.demo.kills ?? []);
        if (k.toLowerCase() === "k") {
          const n = src.find((q) => q.tick - 2 * tr > clock.tick + 8);
          if (n) clock.seek(n.tick - 2 * tr);
        } else {
          const p = [...src].reverse().find((q) => q.tick - 2 * tr < clock.tick - tr);
          if (p) clock.seek(p.tick - 2 * tr);
        }
      } else if (/^[0-9]$/.test(k)) {
        const slot = k === "0" ? 9 : parseInt(k) - 1;
        if (slot < m.pc) st.select(slot);
      } else if (k.toLowerCase() === "v") {
        const o: ViewMode[] = ["2d", "3d", "split"];
        st.set({ viewMode: o[(o.indexOf(st.viewMode) + 1) % 3] });
      } else if (k.toLowerCase() === "c") {
        const o: CamMode[] = ["pov", "chase", "free", "top"];
        st.set({ cam: o[(o.indexOf(st.cam) + 1) % 4] });
      } else if (k.toLowerCase() === "f") {
        st.set({ follow: !st.follow });
      } else if (k.toLowerCase() === "m") {
        st.setVoice({ master: !st.voice.master });
      } else if (k.toLowerCase() === "i") {
        st.set({ range: { a: clock.tick, b: Math.max(clock.tick + 2 * tr, st.range?.b ?? clock.tick + 10 * tr) } });
      } else if (k.toLowerCase() === "o") {
        st.set({ range: { a: Math.min(st.range?.a ?? clock.tick - 10 * tr, clock.tick - 2 * tr), b: clock.tick } });
      } else if (k === "?") {
        st.set({ helpOpen: !st.helpOpen });
      } else if (k === "Escape") {
        st.set({ helpOpen: false, exportOpen: false });
      } else handled = false;
      if (handled) {
        e.preventDefault();
        if (k === " " && tag === "BUTTON") (el as HTMLElement).blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const phase = useStore((s) => s.phase);
  const tab = useStore((s) => s.tab);
  const exportOpen = useStore((s) => s.exportOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  useShortcuts();
  if (phase !== "ready") return <StartScreen />;
  return (
    <div className="app">
      <TopBar />
      <div className={"workspace ws-" + tab}>
        {tab === "watch" && (
          <>
            <RoundList />
            <Viewport />
            <SidePanel />
          </>
        )}
        {tab === "analysis" && (
          <>
            <AnalysisPage />
            <Viewport stack />
          </>
        )}
        {tab === "player" && <PlayerPage />}
      </div>
      <div className="bottom">
        <Transport />
        <Timeline />
      </div>
      {exportOpen && <ExportDialog />}
      {helpOpen && <Help />}
    </div>
  );
}
