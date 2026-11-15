import { useRef, useState } from "react";
import { useStore, type CamMode } from "../lib/store";
import { createSaver, saveBuffer } from "../lib/backend";
import { runExport, webCodecsAvailable, type ExportOpts, type ExportProgress } from "../lib/exporter";
import { clock } from "../lib/clock";
import { fmtClock } from "../lib/model";
import { Icon } from "./icons";
import { CAM_LABELS } from "./View3D";

export function ExportDialog() {
  const match = useStore((s) => s.match)!;
  const st = useStore();
  const [scope, setScope] = useState<"round" | "range">(st.range ? "range" : "round");
  const [roundIdx, setRoundIdx] = useState(Math.max(0, match.roundIndexAt(clock.tick)));
  const [view, setView] = useState<"2d" | "3d">(st.viewMode === "2d" ? "2d" : "3d");
  const [cam, setCam] = useState<CamMode>(st.cam);
  const [res, setRes] = useState<720 | 1080>(720);
  const [fps, setFps] = useState<30 | 60>(30);
  const [fmt, setFmt] = useState<"auto" | "mp4" | "webm">("auto");
  const [audio, setAudio] = useState(!!match.demo.voice?.available);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<{ text: string; warnings: string[]; ok: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const t0 = useRef(0);

  const r = match.rounds[roundIdx];
  const a = scope === "range" && st.range ? st.range.a : r.freezeEndTick;
  const b = scope === "range" && st.range ? st.range.b : r.endTick + 2 * match.tickRate;
  const dur = (b - a) / match.tickRate;
  const frames = Math.round(dur * fps);
  const wc = webCodecsAvailable();

  const start = async () => {
    setResult(null);
    const W = res === 1080 ? 1920 : 1280,
      H = res === 1080 ? 1080 : 720;
    const ext0 = fmt === "webm" ? "webm" : "mp4";
    void ext0;
    setBusy(true);
    st.set({ exporting: true });
    t0.current = performance.now();
    abort.current = new AbortController();
    const opts: ExportOpts = { match, a, b, view, cam, selected: st.selected, width: W, height: H, fps, format: fmt, audio };
    try {
      const out = await runExport(opts, setProg, abort.current.signal);
      // the container may differ from what was requested (e.g. WebM fallback), so ask for the target now
      setProg({ stage: "Kaydediliyor", frac: 0.97 });
      const saver = await createSaver(`rewind_${match.demo.header.mapName}_${scope === "round" ? "raunt" + r.number : "aralik"}.${out.ext}`, out.ext);
      if (!saver) {
        setResult({ ok: false, warnings: [], text: "Kaydetme iptal edildi; video bellekte oluşturuldu ancak dosyaya yazılmadı." });
        return;
      }
      await saveBuffer(saver, out.data, (f) => setProg({ stage: "Kaydediliyor", frac: 0.97 + f * 0.03 }));
      const mb = (out.data.byteLength / 1048576).toFixed(1);
      (window as any).__lastExport = { ext: out.ext, bytes: out.data.byteLength, frames: out.frames, method: out.method, hasAudio: out.hasAudio };
      setResult({ ok: true, warnings: out.warnings.concat(fmt !== "auto" && out.ext !== ext0 ? [`Dosya biçimi ${out.ext.toUpperCase()} olarak kaydedildi.`] : []), text: `${saver.target} · ${mb} MB · ${out.frames} kare · ${out.method === "webcodecs" ? "WebCodecs" : "MediaRecorder"}${out.hasAudio ? " · sesli" : ""}` });
    } catch (e) {
      const aborted = (e as any)?.name === "AbortError";
      setResult({ ok: false, warnings: [], text: aborted ? "Dışa aktarma iptal edildi." : "Hata: " + String((e as any)?.message ?? e) });
    } finally {
      setBusy(false);
      useStore.setState({ exporting: false });
    }
  };

  const eta = prog && prog.total && prog.frame ? ((performance.now() - t0.current) / prog.frame) * (prog.total - prog.frame) / 1000 : null;

  return (
    <div className="modal-back" onClick={() => !busy && st.set({ exportOpen: false })}>
      <div className="modal export" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Video dışa aktar">
        <div className="modal-head">
          <Icon n="film" size={18} />
          <b>Video dışa aktar</b>
          <span className="grow" />
          <button className="ibtn" disabled={busy} onClick={() => st.set({ exportOpen: false })}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="fgrid">
            <label>Kapsam</label>
            <div className="seg">
              <button className={"chip" + (scope === "round" ? " on" : "")} onClick={() => setScope("round")}>
                Raunt
              </button>
              <button className={"chip" + (scope === "range" ? " on" : "")} disabled={!st.range} title={st.range ? "" : "Zaman çizelgesinde alt şeritten aralık seçin"} onClick={() => setScope("range")}>
                Seçili aralık
              </button>
              {scope === "round" && (
                <select value={roundIdx} onChange={(e) => setRoundIdx(parseInt(e.target.value))}>
                  {match.rounds.map((x, i) => (
                    <option key={x.number} value={i}>
                      Raunt {x.number}
                    </option>
                  ))}
                </select>
              )}
              <span className="muted">
                {fmtClock(dur)} · ~{frames} kare
              </span>
            </div>
            <label>Görünüm</label>
            <div className="seg">
              <button className={"chip" + (view === "2d" ? " on" : "")} onClick={() => setView("2d")}>
                2B harita
              </button>
              <button className={"chip" + (view === "3d" ? " on" : "")} onClick={() => setView("3d")}>
                3B
              </button>
              {view === "3d" &&
                (Object.keys(CAM_LABELS) as CamMode[]).map((c) => (
                  <button key={c} className={"chip" + (cam === c ? " on" : "")} onClick={() => setCam(c)}>
                    {CAM_LABELS[c]}
                  </button>
                ))}
            </div>
            <label>İzlenen oyuncu</label>
            <div>{match.players[st.selected]?.name}</div>
            <label>Çözünürlük</label>
            <div className="seg">
              {([720, 1080] as const).map((x) => (
                <button key={x} className={"chip" + (res === x ? " on" : "")} onClick={() => setRes(x)}>
                  {x}p
                </button>
              ))}
              <span className="muted">{res === 1080 ? "1920×1080" : "1280×720"}</span>
            </div>
            <label>Kare hızı</label>
            <div className="seg">
              {([30, 60] as const).map((x) => (
                <button key={x} className={"chip" + (fps === x ? " on" : "")} onClick={() => setFps(x)}>
                  {x} fps
                </button>
              ))}
            </div>
            <label>Biçim</label>
            <div className="seg">
              {(["auto", "mp4", "webm"] as const).map((x) => (
                <button key={x} className={"chip" + (fmt === x ? " on" : "")} onClick={() => setFmt(x)}>
                  {x === "auto" ? "Otomatik" : x.toUpperCase()}
                </button>
              ))}
            </div>
            <label>Ses</label>
            <label className="check">
              <input type="checkbox" checked={audio} disabled={!match.demo.voice?.available} onChange={(e) => setAudio(e.target.checked)} />
              {match.demo.voice?.available ? "Sesi açık oyuncuların konuşmalarını karıştır" : "Bu demoda ses yok"}
            </label>
          </div>
          <div className="note">
            {wc ? "Kareler gerçek zamanlı değil, tek tek (belirlenimci) üretilir ve WebCodecs ile kodlanır." : "Bu sistemde WebCodecs yok: gerçek zamanlı kayıt (MediaRecorder) kullanılacak; süre kadar bekleyin."}
          </div>
          {prog && busy && (
            <div className="progress">
              <div className="pbar">
                <i style={{ width: `${Math.round(prog.frac * 100)}%` }} />
              </div>
              <span>
                {prog.stage} · %{Math.round(prog.frac * 100)}
                {prog.total ? ` · ${prog.frame}/${prog.total} kare` : ""}
                {eta != null && isFinite(eta) ? ` · ~${Math.ceil(eta)} sn kaldı` : ""}
              </span>
            </div>
          )}
          {result && (
            <div className={"result " + (result.ok ? "ok" : "err")} data-testid="export-result">
              {result.ok ? "Kaydedildi: " : ""}
              {result.text}
              {result.warnings.map((w) => (
                <div key={w} className="warn">
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          {busy ? (
            <button className="btn danger" onClick={() => abort.current?.abort()}>
              İptal
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => st.set({ exportOpen: false })}>
                Kapat
              </button>
              <button className="btn primary" data-testid="export-start" onClick={start}>
                Dışa aktarmayı başlat
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
