import { useMemo, useState } from "react";
import { useStore, type AnalysisTab } from "../lib/store";
import { SIDE_COLOR, catLabel, fmtClock, styleLabel, GRENADE_NAMES, END_REASON, type Match } from "../lib/model";
import { InsightCard, sideDot } from "./Panels";
import { Icon } from "./icons";
import { sourceLabel } from "../render/draw2d";
import type { PlayerStats, Side } from "../lib/contract";
import { libraryStats } from "../lib/backend";
import { useEffect } from "react";

export const SUB_ORDER = ["aim", "entry", "trade", "utility", "clutch", "survival", "economy", "positioning"];
export const SUB_LABELS: Record<string, string> = {
  aim: "Nişan",
  entry: "Giriş",
  trade: "Takas",
  utility: "Yardımcı",
  clutch: "Clutch",
  survival: "Hayatta kalma",
  economy: "Ekonomi",
  positioning: "Pozisyon",
};
export const subLabel = (k: string) => SUB_LABELS[k] ?? catLabel(k);

export const scoreColor = (v: number) => `hsl(${Math.max(0, Math.min(100, v)) * 1.15}, 68%, 52%)`;

export function RadarChart({ values, size = 220 }: { values: Record<string, number>; size?: number }) {
  const keys = SUB_ORDER.filter((k) => k in values).concat(Object.keys(values).filter((k) => !SUB_ORDER.includes(k)));
  const n = keys.length;
  if (n < 3) return null;
  const c = size / 2;
  const R = size / 2 - 34;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [c + Math.cos(a) * R * (v / 100), c + Math.sin(a) * R * (v / 100)];
  };
  const poly = keys.map((k, i) => pt(i, Math.max(2, values[k] ?? 0)).join(",")).join(" ");
  return (
    <svg width={size} height={size} className="radar">
      {[25, 50, 75, 100].map((r) => (
        <polygon key={r} points={keys.map((_, i) => pt(i, r).join(",")).join(" ")} fill="none" stroke="#243247" strokeWidth={1} />
      ))}
      {keys.map((_, i) => (
        <line key={i} x1={c} y1={c} x2={pt(i, 100)[0]} y2={pt(i, 100)[1]} stroke="#243247" />
      ))}
      <polygon points={poly} fill="rgba(53,208,186,0.25)" stroke="#35d0ba" strokeWidth={2} />
      {keys.map((k, i) => {
        const [x, y] = pt(i, 100);
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const lx = c + Math.cos(a) * (R + 16);
        const ly = c + Math.sin(a) * (R + 14);
        void x;
        void y;
        return (
          <text key={k} x={lx} y={ly} fill="#9fb0c8" fontSize={10.5} textAnchor={Math.abs(Math.cos(a)) < 0.2 ? "middle" : Math.cos(a) > 0 ? "start" : "end"} dominantBaseline="middle">
            {subLabel(k)} <tspan fill="#e8eef7" fontWeight={700}>{Math.round(values[k] ?? 0)}</tspan>
          </text>
        );
      })}
      {keys.map((k, i) => {
        const [x, y] = pt(i, Math.max(2, values[k] ?? 0));
        return <circle key={k} cx={x} cy={y} r={3} fill="#35d0ba" />;
      })}
    </svg>
  );
}

function teamScore(m: Match, team: 0 | 1): number {
  const r = m.rounds[m.rounds.length - 1];
  if (!r) return 0;
  const w = r.winner ? r.teamSides.indexOf(r.winner) : -1;
  return r.scoreBefore[team] + (w === team ? 1 : 0);
}

type ColKey = keyof PlayerStats | "name" | "oo" | "clutch" | "multi";
const COLS: { k: ColKey; label: string; title?: string; fmt?: (s: PlayerStats) => string; num?: (s: PlayerStats) => number }[] = [
  { k: "kills", label: "Ö" },
  { k: "deaths", label: "L", title: "Ölüm" },
  { k: "assists", label: "A", title: "Asist" },
  { k: "adr", label: "ADR", fmt: (s) => s.adr.toFixed(0) },
  { k: "kast", label: "KAST", title: "Raunt başına katkı %", fmt: (s) => s.kast.toFixed(0) + "%" },
  { k: "hsPercent", label: "HS%", title: "Kafa vuruşu yüzdesi", fmt: (s) => s.hsPercent.toFixed(0) + "%" },
  { k: "kpr", label: "ÖPR", title: "Raunt başına öldürme", fmt: (s) => s.kpr.toFixed(2) },
  { k: "oo", label: "AÖ/AL", title: "Açılış öldürme / açılış ölümü", fmt: (s) => `${s.openingKills}/${s.openingDeaths}`, num: (s) => s.openingKills - s.openingDeaths },
  { k: "tradeKills", label: "Takas", title: "Takas öldürmesi", fmt: (s) => String(s.tradeKills) },
  { k: "clutch", label: "Clutch", title: "Kazanılan / kaybedilen clutch", fmt: (s) => `${Object.values(s.clutchesWon ?? {}).reduce((a, b) => a + b, 0)}/${s.clutchesLost ?? 0}`, num: (s) => Object.values(s.clutchesWon ?? {}).reduce((a, b) => a + b, 0) },
  { k: "multi", label: "2K+", title: "Çoklu öldürme", fmt: (s) => String((s.multiKills?.k2 ?? 0) + (s.multiKills?.k3 ?? 0) + (s.multiKills?.k4 ?? 0) + (s.multiKills?.k5 ?? 0)), num: (s) => (s.multiKills?.k2 ?? 0) + (s.multiKills?.k3 ?? 0) + (s.multiKills?.k4 ?? 0) + (s.multiKills?.k5 ?? 0) },
  { k: "enemiesFlashed", label: "Flaş", title: "Kör edilen rakip", fmt: (s) => String(s.enemiesFlashed) },
  { k: "utilityDamage", label: "YH", title: "Yardımcı hasarı", fmt: (s) => String(Math.round(s.utilityDamage)) },
  { k: "accuracy", label: "İsabet", fmt: (s) => s.accuracy.toFixed(0) + "%" },
];

export function ScoreboardTab() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const [sort, setSort] = useState<{ k: ColKey | "score" | "rating"; dir: 1 | -1 }>({ k: "score", dir: -1 });
  const stats = match.demo.analysis?.players ?? [];
  const val = (s: PlayerStats): number => {
    if (sort.k === "name") return 0;
    const col = COLS.find((c) => c.k === sort.k);
    if (col?.num) return col.num(s);
    return Number((s as any)[sort.k]) || 0;
  };
  const sorted = (team: 0 | 1) =>
    match.players
      .filter((p) => p.team === team)
      .map((p) => ({ p, s: stats[p.slot] }))
      .filter((x) => x.s)
      .sort((a, b) => (sort.k === "name" ? a.p.name.localeCompare(b.p.name, "tr") * -sort.dir : (val(a.s) - val(b.s)) * sort.dir));
  const head = (k: ColKey | "score" | "rating", label: string, title?: string) => (
    <th key={k} title={title} className={"sortable" + (sort.k === k ? " sorted" : "")} onClick={() => setSort({ k, dir: sort.k === k ? ((-sort.dir) as 1 | -1) : -1 })}>
      {label}
      {sort.k === k ? (sort.dir < 0 ? " ▾" : " ▴") : ""}
    </th>
  );
  const selStats = stats[sel];
  const r0 = match.rounds[match.rounds.length - 1];
  return (
    <div className="scoreboard-tab">
      {[0, 1].map((t) => {
        const tm = t as 0 | 1;
        const rows = sorted(tm);
        const name = match.players.find((p) => p.team === tm)?.teamName ?? `Takım ${t + 1}`;
        const side: Side = r0 ? r0.teamSides[tm] : tm === 0 ? "CT" : "T";
        return (
          <div className="team-card" key={t}>
            <div className="team-head">
              <span className="tn">
                {sideDot(tm === 0 ? "CT" : "T")}
                {name}
              </span>
              <span className="muted">Son raunt tarafı: {side}</span>
              <span className="tscore">{teamScore(match, tm)}</span>
            </div>
            <table className="grid">
              <thead>
                <tr>
                  {head("name", "Oyuncu")}
                  {head("score", "Puan", "0–100 genel performans puanı")}
                  {head("rating", "Rating", "HLTV tarzı rating")}
                  {COLS.map((c) => head(c.k, c.label, c.title))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, s }) => (
                  <tr key={p.slot} className={p.slot === sel ? "sel" : ""} onClick={() => select(p.slot)}>
                    <td className="pn">{p.name}</td>
                    <td>
                      <div className="scorebar" title={`${s.score}/100`}>
                        <i style={{ width: `${s.score}%`, background: scoreColor(s.score) }} />
                        <b>{Math.round(s.score)}</b>
                      </div>
                    </td>
                    <td className={s.rating >= 1.05 ? "good" : s.rating < 0.9 ? "bad" : ""}>{s.rating.toFixed(2)}</td>
                    {COLS.map((c) => (
                      <td key={c.k}>{c.fmt ? c.fmt(s) : String((s as any)[c.k] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {selStats && (
        <div className="detail-card">
          <div className="dc-title">
            {match.players[sel].name} <span className="muted">· alt puanlar</span>
          </div>
          <div className="dc-body">
            <RadarChart values={selStats.subScores} size={250} />
            <div className="bars">
              {Object.entries(selStats.subScores).map(([k, v]) => (
                <div key={k} className="barrow">
                  <span>{subLabel(k)}</span>
                  <div className="bar">
                    <i style={{ width: `${v}%`, background: scoreColor(v) }} />
                  </div>
                  <b>{Math.round(v)}</b>
                </div>
              ))}
              <div className="mini-stats">
                <span>Çoklu: 2K {selStats.multiKills?.k2 ?? 0} · 3K {selStats.multiKills?.k3 ?? 0} · 4K {selStats.multiKills?.k4 ?? 0} · 5K {selStats.multiKills?.k5 ?? 0}</span>
                <span>Takassız ölüm: {selStats.untradedDeaths} · Takas edilen ölüm: {selStats.tradedDeaths}</span>
                <span>Kör ettiği rakip: {selStats.enemiesFlashed} ({selStats.enemyBlindSeconds?.toFixed?.(1)} sn) · takım arkadaşı: {selStats.teammatesFlashed}</span>
                <span>MVP raunt: {selStats.mvpRounds} · Ort. hayatta kalma: {selStats.avgTimeAlive?.toFixed?.(0)} sn</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function MatrixTab() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const jump = useStore((s) => s.jumpToRound);
  const an = match.demo.analysis?.rounds ?? [];
  const [hover, setHover] = useState<string>("");
  const cell = (score: number, verdict: string) => {
    if (verdict === "good" || score > 15) return `hsla(145, 62%, ${28 + Math.min(score, 100) * 0.22}%, ${0.55 + Math.min(1, Math.abs(score) / 80) * 0.45})`;
    if (verdict === "bad" || score < -15) return `hsla(355, 70%, ${28 + Math.min(-score, 100) * 0.22}%, ${0.55 + Math.min(1, Math.abs(score) / 80) * 0.45})`;
    return "rgba(120,135,160,0.22)";
  };
  return (
    <div className="matrix-tab">
      <div className="matrix-note">
        Her hücre oyuncunun o rauntteki puanıdır (yeşil: iyi, kırmızı: kötü). Hücreye tıklayınca o raunta gidilir. <span className="hover">{hover}</span>
      </div>
      <div className="matrix-scroll">
        <table className="matrix">
          <thead>
            <tr>
              <th className="sticky">Oyuncu</th>
              {match.rounds.map((r) => (
                <th key={r.number} className="rh" onClick={() => jump(r.number - 1)} title={`${END_REASON[r.endReason] ?? r.endReason} · ${r.winner ?? "?"} kazandı`}>
                  <div style={{ borderBottom: `3px solid ${r.winner ? SIDE_COLOR[r.winner] : "#556"}` }}>{r.number}</div>
                </th>
              ))}
              <th>Σ</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1].map((t) => {
              const ps = match.players.filter((p) => p.team === t);
              return ps.map((p, idx) => (
                <tr key={p.slot} className={(p.slot === sel ? "sel " : "") + (idx === 0 && t === 1 ? "gap" : "")}>
                  <td className="sticky pn" onClick={() => select(p.slot)}>
                    {sideDot(t === 0 ? "CT" : "T")}
                    {p.name}
                  </td>
                  {match.rounds.map((r, i) => {
                    const l = an[i]?.players?.[p.slot];
                    if (!l) return <td key={r.number} className="c empty" />;
                    return (
                      <td
                        key={r.number}
                        className="c"
                        style={{ background: cell(l.score, l.verdict) }}
                        onMouseEnter={() => setHover(`${p.name} · Raunt ${r.number}: puan ${l.score}, ${l.kills} öldürme, ${l.damage} hasar, ${l.died ? "öldü" : "hayatta"}`)}
                        onClick={() => {
                          select(p.slot);
                          jump(i);
                        }}
                      >
                        <span className="k">{l.kills || ""}</span>
                        {l.died && <span className="x">✕</span>}
                        {an[i].mvp === p.slot && <span className="mvp">★</span>}
                      </td>
                    );
                  })}
                  <td className="sum">{Math.round(an.reduce((a, r) => a + (r.players?.[p.slot]?.score ?? 0), 0))}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      <div className="matrix-rounds">
        {match.rounds.map((r, i) => (
          <div key={r.number} className="mr" onClick={() => jump(i)} title={an[i]?.summary}>
            <b>R{r.number}</b>
            <span>{an[i]?.summary ?? END_REASON[r.endReason]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InsightsTab() {
  const match = useStore((s) => s.match)!;
  const f = useStore((s) => s.insightFilter);
  const setS = useStore((s) => s.set);
  const all = match.demo.analysis?.insights ?? [];
  const cats = useMemo(() => [...new Set(all.map((i) => i.category))], [all]);
  const list = all.filter((i) => (f.player === "all" || i.player === f.player) && (f.round === "all" || i.round === f.round) && (f.category === "all" || i.category === f.category) && (f.severity === "all" || i.severity === f.severity));
  const upd = (p: Partial<typeof f>) => setS({ insightFilter: { ...f, ...p } });
  const sum = list.reduce((a, i) => a + i.scoreDelta, 0);
  return (
    <div className="insights-tab">
      <div className="filters">
        <label>
          Oyuncu
          <select value={String(f.player)} onChange={(e) => upd({ player: e.target.value === "all" ? "all" : parseInt(e.target.value) })}>
            <option value="all">Hepsi</option>
            {match.players.map((p) => (
              <option key={p.slot} value={p.slot}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Raunt
          <select value={String(f.round)} onChange={(e) => upd({ round: e.target.value === "all" ? "all" : parseInt(e.target.value) })}>
            <option value="all">Hepsi</option>
            {match.rounds.map((r) => (
              <option key={r.number} value={r.number}>
                {r.number}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kategori
          <select value={f.category} onChange={(e) => upd({ category: e.target.value })}>
            <option value="all">Hepsi</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {catLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <div className="seg">
          {(["all", "good", "bad", "info"] as const).map((s) => (
            <button key={s} className={"chip" + (f.severity === s ? " on" : "")} onClick={() => upd({ severity: s })}>
              {{ all: "Hepsi", good: "İyi", bad: "Kötü", info: "Bilgi" }[s]}
            </button>
          ))}
        </div>
        <span className="muted count">
          {list.length} içgörü · net {sum > 0 ? "+" : ""}
          {sum}
        </span>
      </div>
      <div className="ins-list">
        {list.length === 0 && <div className="empty">Filtrelere uyan içgörü yok.</div>}
        {list.map((i) => (
          <InsightCard key={i.id} ins={i} />
        ))}
      </div>
    </div>
  );
}

export function CoachTab() {
  const match = useStore((s) => s.match)!;
  const coachId = useStore((s) => s.coachInsight);
  const setS = useStore((s) => s.set);
  const focusInsight = useStore((s) => s.focusInsight);
  const sel = useStore((s) => s.selected);
  const [onlySel, setOnlySel] = useState(false);
  const [lib, setLib] = useState<string>("");
  useEffect(() => {
    libraryStats().then((l) => l && setLib(`Kütüphane: ${l.demos} demo, bu haritada ${l.lineupsByMap?.[match.demo.map.name] ?? 0} atış noktası`));
  }, [match]);
  const all = (match.demo.analysis?.insights ?? []).filter((i) => i.suggestion);
  const list = all.filter((i) => !onlySel || i.player === sel);
  const cur = coachId != null ? match.insightById.get(coachId) : undefined;
  const s = cur?.suggestion;
  const g = cur?.grenadeId != null ? match.grenadeById.get(cur.grenadeId) : undefined;
  const choose = (id: number) => {
    setS({ coachInsight: id });
    focusInsight(id);
  };
  useEffect(() => {
    if (coachId == null && list.length) setS({ coachInsight: list[0].id });
  }, [coachId, list.length]); // eslint-disable-line
  return (
    <div className="coach-tab">
      <div className="coach-list">
        <div className="filters">
          <label className="check">
            <input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> Yalnızca {match.players[sel]?.name}
          </label>
          <span className="muted count">{list.length} öneri</span>
        </div>
        {lib && <div className="note">{lib}</div>}
        <div className="ins-scroll">
          {list.length === 0 && <div className="empty">Bu demoda yardımcı malzeme önerisi yok.</div>}
          {list.map((i) => (
            <div key={i.id} className={"insight " + i.severity + (i.id === coachId ? " active" : "")} onClick={() => choose(i.id)}>
              <div className="ins-top">
                <span className="ins-title">{i.title}</span>
                <span className="chip small">{GRENADE_NAMES[i.suggestion!.type] ?? i.suggestion!.type}</span>
              </div>
              <div className="ins-meta">
                <span>R{i.round}</span>
                <span>{match.players[i.player]?.name}</span>
                <span>{i.suggestion!.label}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="coach-detail">
        {!cur || !s ? (
          <div className="empty">
            <Icon n="target" size={26} />
            <b>Bir öneri seçin</b>
            <p>Seçtiğiniz atış, haritada ve 3B görünümde gerçek atışınızla önerilen atış noktası karşılaştırılarak çizilir.</p>
          </div>
        ) : (
          <>
            <div className="cd-head">
              <b>{cur.title}</b>
              <span className="muted">
                {match.players[cur.player]?.name} · Raunt {cur.round} · {fmtClock((cur.tick - (match.rounds[cur.round - 1]?.freezeEndTick ?? 0)) / match.tickRate)}
              </span>
            </div>
            <p className="cd-detail">{cur.detail}</p>
            <div className="cd-legend">
              <span>
                <i className="lg red" /> Gerçek atış
              </span>
              <span>
                <i className="lg green" /> Önerilen atış
              </span>
            </div>
            <table className="cmp">
              <thead>
                <tr>
                  <th />
                  <th className="red">Gerçek</th>
                  <th className="green">Önerilen</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Tür</td>
                  <td>{g ? GRENADE_NAMES[g.type] : "—"}</td>
                  <td>{GRENADE_NAMES[s.type] ?? s.type}</td>
                </tr>
                <tr>
                  <td>Atış yeri</td>
                  <td>{g?.throwPlace ?? "—"}</td>
                  <td>{s.fromPlace ?? "—"}</td>
                </tr>
                <tr>
                  <td>Atış biçimi</td>
                  <td>{g ? styleLabel(g.throwStyle) : "—"}</td>
                  <td>{styleLabel(s.throwStyle)}</td>
                </tr>
                <tr>
                  <td>Bakış (yaw / pitch)</td>
                  <td>{g ? `${g.throwYaw.toFixed(1)}° / ${g.throwPitch.toFixed(1)}°` : "—"}</td>
                  <td>{`${s.aimYaw.toFixed(1)}° / ${s.aimPitch.toFixed(1)}°`}</td>
                </tr>
                <tr>
                  <td>Düşüş yeri</td>
                  <td>{g?.landPlace ?? "—"}</td>
                  <td>{s.landPlace ?? "—"}</td>
                </tr>
                {g && (
                  <tr>
                    <td>Sonuç</td>
                    <td colSpan={2}>
                      {g.type === "flash" ? `${g.enemiesFlashed} rakip / ${g.teammatesFlashed} takım arkadaşı kör` : g.type === "he" || g.type === "molotov" ? `${g.damage} rakip hasarı · ${g.teamDamage} takım hasarı` : "—"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="cd-label">
              <Icon n="target" size={14} /> {s.label}
            </div>
            <div className="cd-source">
              Kaynak: <b>{sourceLabel(s.source)}</b> · {s.support} başarılı atış bu noktayı destekliyor
            </div>
            <div className="cd-reason">{s.reason}</div>
          </>
        )}
      </div>
    </div>
  );
}

export function AnalysisPage() {
  const tab = useStore((s) => s.analysisTab);
  const setS = useStore((s) => s.set);
  const tabs: { k: AnalysisTab; l: string; i: string }[] = [
    { k: "scoreboard", l: "Skor tablosu", i: "chart" },
    { k: "matrix", l: "Raunt matrisi", i: "map" },
    { k: "insights", l: "İçgörüler", i: "bulb" },
    { k: "coach", l: "Yardımcı koçu", i: "target" },
  ];
  return (
    <div className="analysis">
      <div className="subtabs">
        {tabs.map((t) => (
          <button key={t.k} className={tab === t.k ? "on" : ""} onClick={() => setS({ analysisTab: t.k })}>
            <Icon n={t.i} size={14} /> {t.l}
          </button>
        ))}
      </div>
      <div className="subbody">
        {tab === "scoreboard" && <ScoreboardTab />}
        {tab === "matrix" && <MatrixTab />}
        {tab === "insights" && <InsightsTab />}
        {tab === "coach" && <CoachTab />}
      </div>
    </div>
  );
}
