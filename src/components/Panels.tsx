import { useMemo } from "react";
import { clock, useTick } from "../lib/clock";
import { useStore } from "../lib/store";
import { Icon } from "./icons";
import { BUY_LABELS, END_REASON, SIDE_COLOR, catLabel, fmtClock, has, isAlive, newPState, weaponLabel, type Match } from "../lib/model";
import { FrameFlag, type Insight, type Side } from "../lib/contract";

export function sideDot(side: Side) {
  return <span className="sidedot" style={{ background: SIDE_COLOR[side] }} />;
}

export function RoundList() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const tick = useTick(3);
  const cur = match.roundIndexAt(tick);
  const jump = useStore((s) => s.jumpToRound);
  const an = match.demo.analysis?.rounds ?? [];
  const reasonIcon = (r: string) => (r === "bomb_exploded" ? "bomb" : r === "bomb_defused" ? "defuse" : r === "time_expired" ? "clock" : "skull");
  return (
    <div className="roundlist">
      <div className="panel-title">Rauntlar</div>
      <div className="rl-scroll">
        {match.rounds.map((r, i) => {
          const w = r.winner ? r.teamSides.indexOf(r.winner) : -1;
          const s0 = r.scoreBefore[0] + (w === 0 ? 1 : 0);
          const s1 = r.scoreBefore[1] + (w === 1 ? 1 : 0);
          const line = an[i]?.players?.[sel];
          return (
            <button key={r.number} className={"rl-row" + (i === cur ? " cur" : "")} onClick={() => jump(i)} title={`${END_REASON[r.endReason] ?? r.endReason} · ${BUY_LABELS[r.buyTypes[0]] ?? r.buyTypes[0]} / ${BUY_LABELS[r.buyTypes[1]] ?? r.buyTypes[1]}`}>
              <span className="rl-num">{r.number}</span>
              <span className="rl-score">
                <b style={{ color: SIDE_COLOR[r.teamSides[0]] }}>{s0}</b>
                <i>:</i>
                <b style={{ color: SIDE_COLOR[r.teamSides[1]] }}>{s1}</b>
              </span>
              <span className="rl-win" style={{ color: r.winner ? SIDE_COLOR[r.winner] : "#777" }}>
                <Icon n={reasonIcon(r.endReason)} size={14} />
              </span>
              <span className="rl-buy" title="Alım">
                <em className={"buy-" + r.buyTypes[0]}>{(BUY_LABELS[r.buyTypes[0]] ?? "?").slice(0, 1)}</em>
                <em className={"buy-" + r.buyTypes[1]}>{(BUY_LABELS[r.buyTypes[1]] ?? "?").slice(0, 1)}</em>
              </span>
              {line && <span className={"rl-dot " + line.verdict} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function kdaUpTo(m: Match, slot: number, tick: number) {
  let k = 0,
    d = 0,
    a = 0;
  for (const e of m.demo.kills ?? []) {
    if (e.tick > tick) break;
    if (e.attacker === slot) k++;
    if (e.victim === slot) d++;
    if (e.assister === slot) a++;
  }
  return [k, d, a];
}

export function LiveScoreboard() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const voiceSt = useStore((s) => s.voice);
  const setVoice = useStore((s) => s.setVoice);
  const tick = useTick(8);
  const speaking = match.speakingSlots(tick);
  const rows = useMemo(() => [] as number[], []);
  void rows;
  const ps = newPState();
  const byTeam: Record<Side, { slot: number; ps: ReturnType<typeof newPState> }[]> = { CT: [], T: [] };
  for (let s = 0; s < match.pc; s++) {
    const p = match.sample(tick, s, newPState());
    const side: Side = p.flags & FrameFlag.Connected ? (has(p.flags, FrameFlag.SideCT) ? "CT" : "T") : match.sideInRound(s, Math.max(1, match.roundIndexAt(tick) + 1));
    byTeam[side].push({ slot: s, ps: p });
  }
  void ps;
  const hasVoice = match.demo.voice?.available;
  const voiceSlots = new Set(match.demo.voice?.players.map((p) => p.slot));
  return (
    <div className="livesb">
      {(["CT", "T"] as Side[]).map((side) => (
        <div key={side} className="sb-team">
          <div className="sb-head" style={{ borderColor: SIDE_COLOR[side] }}>
            <span style={{ color: SIDE_COLOR[side] }}>{side === "CT" ? "Counter-Terrorist" : "Terrorist"}</span>
            <span className="muted">{byTeam[side].filter((r) => isAlive(r.ps)).length} hayatta</span>
          </div>
          <div className="sb-cols">
            <span />
            <span>Oyuncu</span>
            <span>HP</span>
            <span>Silah</span>
            <span className="r">$</span>
            <span className="r">K/D/A</span>
          </div>
          {byTeam[side]
            .sort((a, b) => a.slot - b.slot)
            .map(({ slot, ps }) => {
              const alive = isAlive(ps);
              const [k, d, a] = kdaUpTo(match, slot, tick);
              const num = slot + 1 === 10 ? 0 : slot + 1;
              return (
                <div key={slot} className={"sb-row" + (slot === sel ? " sel" : "") + (alive ? "" : " dead")} onClick={() => select(slot)}>
                  <span className="sb-num" title={`Kısayol: ${num}`}>
                    {num}
                  </span>
                  <span className="sb-name">
                    {speaking.has(slot) && <Icon n="vol" size={12} className="speak" />}
                    {match.players[slot].name}
                    {has(ps.flags, FrameFlag.HasBomb) && alive && <em className="tagc" title="Bomba taşıyor">C4</em>}
                    {has(ps.flags, FrameFlag.HasDefuser) && alive && <em className="tagd" title="Defuse kit">DK</em>}
                    {ps.flash > 0.1 && alive && <em className="tagf" title="Kör">KÖR</em>}
                  </span>
                  <span className="sb-hp">
                    <i style={{ width: `${alive ? ps.health : 0}%`, background: ps.health > 50 ? "#3ddc84" : ps.health > 25 ? "#ffcc4d" : "#ff5c6c" }} />
                    <b>{alive ? Math.round(ps.health) : ""}{alive && ps.armor > 0 ? <u>+{Math.round(ps.armor)}</u> : null}</b>
                  </span>
                  <span className="sb-wp">{alive ? weaponLabel(match.weaponName(ps.weapon)) : "—"}</span>
                  <span className="r sb-money">{ps.money ? `$${Math.round(ps.money)}` : ""}</span>
                  <span className="r sb-kda">
                    {k}/{d}/{a}
                  </span>
                  {hasVoice && voiceSlots.has(slot) && (
                    <button
                      className={"mic" + (voiceSt.mutes[slot] ? " off" : "")}
                      title={voiceSt.mutes[slot] ? "Sesi aç" : "Sustur"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setVoice({ mutes: { ...voiceSt.mutes, [slot]: !voiceSt.mutes[slot] } });
                      }}
                    >
                      <Icon n={voiceSt.mutes[slot] ? "micoff" : "mic"} size={13} />
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

export function VoicePanel() {
  const match = useStore((s) => s.match)!;
  const v = useStore((s) => s.voice);
  const setVoice = useStore((s) => s.setVoice);
  const sel = useStore((s) => s.selected);
  const tick = useTick(8);
  const speaking = match.speakingSlots(tick);
  const info = match.demo.voice;
  if (!info?.available)
    return (
      <div className="empty">
        <Icon n="micoff" size={28} />
        <b>Bu demoda ses kaydı yok</b>
        <p>Oyun içi ses sohbeti demo dosyasına kaydedilmemiş olabilir (sunucu ses kaydını kapatmış olabilir) ya da kayıtlar çözülemedi. Ses kontrolleri bu yüzden devre dışı.</p>
      </div>
    );
  const ptxt = clock.speed < 0.5 || clock.speed > 2 ? "Bu hızda ses sessize alınır (0,5×–2× arası çalar)." : clock.speed !== 1 ? "Ses, hıza göre perdesi değişerek çalınıyor." : "";
  return (
    <div className="voicepanel">
      <div className="vp-row">
        <button className={"chip" + (v.master ? " on" : "")} onClick={() => setVoice({ master: !v.master })}>
          <Icon n={v.master ? "vol" : "mute"} size={13} /> Ana ses {v.master ? "açık" : "kapalı"}
        </button>
        <label className="check">
          <input type="checkbox" checked={v.onlyTeam} onChange={(e) => setVoice({ onlyTeam: e.target.checked })} />
          Yalnızca {match.players[sel]?.name} takımı
        </label>
      </div>
      <div className="vp-row">
        <span className="muted">Ana seviye</span>
        <input type="range" min={0} max={1.5} step={0.05} value={v.masterVol} onChange={(e) => setVoice({ masterVol: parseFloat(e.target.value) })} />
      </div>
      {ptxt && <div className="note">{ptxt}</div>}
      <div className="vp-list">
        {match.players.map((p) => {
          const has = info.players.find((x) => x.slot === p.slot);
          const side = match.sideInRound(p.slot, Math.max(1, (match.roundIndexAt(tick) ?? 0) + 1));
          return (
            <div key={p.slot} className={"vp-p" + (has ? "" : " none")}>
              {sideDot(side)}
              <span className="nm">{p.name}</span>
              <span className={speaking.has(p.slot) ? "speakdot" : "speakdot ph"} />
              {has ? (
                <>
                  <button className={"mic" + (v.mutes[p.slot] ? " off" : "")} onClick={() => setVoice({ mutes: { ...v.mutes, [p.slot]: !v.mutes[p.slot] } })} title={v.mutes[p.slot] ? "Sesi aç" : "Sustur"}>
                    <Icon n={v.mutes[p.slot] ? "micoff" : "mic"} size={13} />
                  </button>
                  <input type="range" min={0} max={2} step={0.05} value={v.vols[p.slot] ?? 1} onChange={(e) => setVoice({ vols: { ...v.vols, [p.slot]: parseFloat(e.target.value) } })} />
                </>
              ) : (
                <span className="muted">kayıt yok</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InsightCard({ ins, compact, active }: { ins: Insight; compact?: boolean; active?: boolean }) {
  const match = useStore((s) => s.match)!;
  const focusInsight = useStore((s) => s.focusInsight);
  const set = useStore((s) => s.set);
  const r = match.rounds[ins.round - 1];
  const t = r ? fmtClock((ins.tick - r.freezeEndTick) / match.tickRate) : "";
  const p = match.players[ins.player];
  return (
    <div className={"insight " + ins.severity + (active ? " active" : "")} onClick={() => focusInsight(ins.id)} data-kind={ins.kind}>
      <div className="ins-top">
        <span className="ins-title">{ins.title}</span>
        <span className={"delta " + (ins.scoreDelta > 0 ? "pos" : ins.scoreDelta < 0 ? "neg" : "")}>{ins.scoreDelta > 0 ? "+" : ""}{ins.scoreDelta}</span>
      </div>
      {!compact && <div className="ins-detail">{ins.detail}</div>}
      <div className="ins-meta">
        <span>R{ins.round}</span>
        <span>{t}</span>
        {p && <span>{p.name}</span>}
        <span className="cat">{catLabel(ins.category)}</span>
        {ins.suggestion && (
          <button
            className="chip accent small"
            onClick={(e) => {
              e.stopPropagation();
              focusInsight(ins.id);
              set({ coachInsight: ins.id, tab: "analysis", analysisTab: "coach" });
            }}
          >
            <Icon n="target" size={12} /> Nasıl atılmalıydı
          </button>
        )}
      </div>
    </div>
  );
}

export function SideInsights() {
  const match = useStore((s) => s.match)!;
  const sel = useStore((s) => s.selected);
  const tick = useTick(2);
  const ri = match.roundIndexAt(tick);
  const all = (match.demo.analysis?.insights ?? []).filter((i) => i.player === sel);
  const cur = all.filter((i) => i.round === ri + 1);
  const list = cur.length ? cur : all.slice(0, 12);
  return (
    <div className="sideinsights">
      <div className="si-head">
        {match.players[sel]?.name} · {cur.length ? `Raunt ${ri + 1} içgörüleri` : "Tüm içgörüler"} <span className="muted">({all.length})</span>
      </div>
      {list.length === 0 && <div className="empty small">Bu oyuncu için içgörü yok.</div>}
      {list.map((i) => (
        <InsightCard key={i.id} ins={i} compact />
      ))}
    </div>
  );
}
