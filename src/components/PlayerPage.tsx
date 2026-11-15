import { fx } from "../lib/model";
import { useMemo, useState } from "react";
import { useStore } from "../lib/store";
import { Map2D } from "./Map2D";
import { RadarChart, scoreColor, subLabel } from "./Analysis";
import { sideDot } from "./Panels";
import { catLabel, GRENADE_NAMES } from "../lib/model";
import type { HeatLayer } from "../render/draw2d";

const TIPS: Record<string, string> = {
  aim: "Nişan çalışması: ısınma rutinleri ve crosshair yerleşimi üzerinde durun.",
  entry: "Giriş düellolarında önce takım arkadaşından flaş/destek isteyin; tek başına açmayın.",
  trade: "Takım arkadaşlarınıza daha yakın durun; ölümleriniz 5 saniye içinde takas edilebilsin.",
  utility: "Yardımcı malzemelerinizi planlı kullanın: kör ettiğiniz rakip sayısı ve smoke yerleşimlerini gözden geçirin.",
  clutch: "Clutch anlarında sakin kalın; bilgi toplayıp tek tek düello yaratın.",
  survival: "Gereksiz ölümlerden kaçının: açılışta fazla ileri çıkmayın ve geri çekilmeyi bilin.",
  economy: "Ekonomi disiplinine dikkat edin: eko raundlarında takımla aynı alım türünü seçin.",
  positioning: "Pozisyon seçimi: açık alanda uzun süre durmayın, köşeleri kullanın.",
};

export function PlayerPage() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const jump = useStore((s) => s.jumpToRound);
  const setS = useStore((s) => s.set);
  const [showK, setShowK] = useState(true);
  const [showD, setShowD] = useState(true);
  const [roundSel, setRoundSel] = useState<number | "all">("all");
  const st = match.demo.analysis?.players?.[sel];
  const p = match.players[sel];
  const ins = (match.demo.analysis?.insights ?? []).filter((i) => i.player === sel);

  const heat: HeatLayer[] = useMemo(() => {
    const out: HeatLayer[] = [];
    const inR = (r: number) => roundSel === "all" || roundSel === r;
    if (showD)
      out.push({ color: [255, 70, 90], radius: 30, points: match.playerDeaths(sel).filter((k) => inR(k.round)).map((k) => ({ x: k.victimPos[0], y: k.victimPos[1] })) });
    if (showK)
      out.push({ color: [60, 230, 140], radius: 30, points: match.playerKills(sel).filter((k) => inR(k.round) && k.attackerPos).map((k) => ({ x: k.attackerPos![0], y: k.attackerPos![1] })) });
    return out;
  }, [match, sel, showK, showD, roundSel]);

  const subs = st ? Object.entries(st.subScores).sort((a, b) => b[1] - a[1]) : [];
  const strengths = subs.filter(([, v]) => v >= 60).slice(0, 3);
  const weaknesses = [...subs].reverse().filter(([, v]) => v < 55).slice(0, 3);
  const counts = new Map<string, { n: number; title: string; sev: string }>();
  for (const i of ins) {
    const e = counts.get(i.kind) ?? { n: 0, title: i.title, sev: i.severity };
    e.n++;
    counts.set(i.kind, e);
  }
  const topBad = [...counts.values()].filter((c) => c.sev === "bad").sort((a, b) => b.n - a.n).slice(0, 4);
  const topGood = [...counts.values()].filter((c) => c.sev === "good").sort((a, b) => b.n - a.n).slice(0, 4);
  const gr = st?.grenadesThrown;

  return (
    <div className="playerpage">
      <div className="pp-list">
        <div className="panel-title">Oyuncular</div>
        {match.players.map((q) => {
          const s = match.demo.analysis?.players?.[q.slot];
          return (
            <button key={q.slot} className={"pp-item" + (q.slot === sel ? " on" : "")} onClick={() => select(q.slot)}>
              {sideDot(q.team === 0 ? "CT" : "T")}
              <span className="nm">{q.name}</span>
              {s && (
                <b style={{ color: scoreColor(s.score) }}>
                  {Math.round(s.score)}
                </b>
              )}
            </button>
          );
        })}
      </div>
      <div className="pp-main">
        <div className="pp-head">
          <div>
            <h2>{p?.name}</h2>
            <span className="muted">{p?.teamName}</span>
          </div>
          {st && (
            <div className="pp-big">
              <div className="big" style={{ color: scoreColor(st.score) }}>
                {Math.round(st.score)}
                <small>/100</small>
              </div>
              <div className="muted">Genel puan</div>
              <div className="rating">Rating {fx(st.rating, 2)}</div>
            </div>
          )}
        </div>
        {st && (
          <>
            <div className="pp-grid">
              <div className="card">
                <div className="dc-title">Performans profili</div>
                <RadarChart values={st.subScores} size={250} />
              </div>
              <div className="card">
                <div className="dc-title">Güçlü yönler</div>
                {strengths.length === 0 && <div className="muted">Belirgin bir güçlü yön yok.</div>}
                {strengths.map(([k, v]) => (
                  <div key={k} className="sw good">
                    <b>{subLabel(k)}</b> <span>{Math.round(v)}/100</span>
                  </div>
                ))}
                {topGood.map((c) => (
                  <div key={c.title} className="sw-line good">
                    ✔ {c.title} × {c.n}
                  </div>
                ))}
                <div className="dc-title" style={{ marginTop: 12 }}>
                  Geliştirilecek yönler
                </div>
                {weaknesses.length === 0 && <div className="muted">Belirgin bir zayıf yön yok.</div>}
                {weaknesses.map(([k, v]) => (
                  <div key={k} className="sw bad">
                    <b>{subLabel(k)}</b> <span>{Math.round(v)}/100</span>
                    <p>{TIPS[k] ?? ""}</p>
                  </div>
                ))}
                {topBad.map((c) => (
                  <div key={c.title} className="sw-line bad">
                    ✖ {c.title} × {c.n}
                  </div>
                ))}
              </div>
              <div className="card stats">
                <div className="dc-title">İstatistikler</div>
                <dl>
                  <dt>Ö / L / A</dt>
                  <dd>
                    {st.kills} / {st.deaths} / {st.assists}
                  </dd>
                  <dt>ADR</dt>
                  <dd>{fx(st.adr, 1)}</dd>
                  <dt>KAST</dt>
                  <dd>{fx(st.kast, 0)}%</dd>
                  <dt>Kafa vuruşu</dt>
                  <dd>{fx(st.hsPercent, 0)}%</dd>
                  <dt>Açılış Ö / L</dt>
                  <dd>
                    {st.openingKills} / {st.openingDeaths}
                  </dd>
                  <dt>Takas Ö / takassız L</dt>
                  <dd>
                    {st.tradeKills} / {st.untradedDeaths}
                  </dd>
                  <dt>İsabet</dt>
                  <dd>{fx(st.accuracy, 0)}%</dd>
                  <dt>Kör edilen rakip</dt>
                  <dd>
                    {st.enemiesFlashed} ({fx(st.enemyBlindSeconds, 1)} sn)
                  </dd>
                  <dt>Takım arkadaşı flaşı</dt>
                  <dd>{st.teammatesFlashed}</dd>
                  <dt>Yardımcı hasarı</dt>
                  <dd>{Math.round(st.utilityDamage)}</dd>
                  <dt>MVP raunt</dt>
                  <dd>{st.mvpRounds}</dd>
                </dl>
                {gr && (
                  <div className="gr-line">
                    {Object.entries(gr)
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => (
                        <span key={k} className="chip small">
                          {GRENADE_NAMES[k] ?? k} {n}
                        </span>
                      ))}
                  </div>
                )}
                <div className="cats">
                  {[...new Set(ins.map((i) => i.category))].map((c) => (
                    <span key={c} className="chip small">
                      {catLabel(c)} {ins.filter((i) => i.category === c).length}
                    </span>
                  ))}
                </div>
                <button
                  className="chip accent"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    setS({ tab: "analysis", analysisTab: "insights", insightFilter: { player: sel, round: "all", category: "all", severity: "all" } });
                  }}
                >
                  Tüm içgörüleri gör ({ins.length})
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="pp-map">
        <div className="pp-maphead">
          <div className="dc-title">Konum ısı haritası</div>
          <label className="check">
            <input type="checkbox" checked={showD} onChange={(e) => setShowD(e.target.checked)} />
            <span style={{ color: "#ff5c6c" }}>Ölümler</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={showK} onChange={(e) => setShowK(e.target.checked)} />
            <span style={{ color: "#3ddc84" }}>Öldürmeler</span>
          </label>
          <select value={String(roundSel)} onChange={(e) => setRoundSel(e.target.value === "all" ? "all" : parseInt(e.target.value))}>
            <option value="all">Tüm rauntlar</option>
            {match.rounds.map((r) => (
              <option key={r.number} value={r.number}>
                Raunt {r.number}
              </option>
            ))}
          </select>
          {roundSel !== "all" && (
            <button className="chip" onClick={() => { jump(roundSel - 1); setS({ tab: "watch" }); }}>
              Rauntu izle
            </button>
          )}
        </div>
        <div className="pp-mapbody">
          <Map2D mode="static" heat={heat} toolbar={false} />
        </div>
      </div>
    </div>
  );
}
