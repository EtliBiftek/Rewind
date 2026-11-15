import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { initialDemo, isTauri, onFileDrop, pickDemoFile } from "../lib/backend";
import { Icon } from "./icons";

let initialDemoChecked = false;

export function StartScreen() {
  const phase = useStore((s) => s.phase);
  const progress = useStore((s) => s.progress);
  const error = useStore((s) => s.error);
  const openPath = useStore((s) => s.openPath);
  const openFixtures = useStore((s) => s.openFixtures);
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tauri = isTauri();

  useEffect(() => {
    let un: (() => void) | undefined;
    onFileDrop(
      (paths) => {
        const p = paths.find((x) => x.toLowerCase().endsWith(".dem"));
        if (p) void openPath(p);
        else setMsg("Lütfen bir .dem dosyası bırakın.");
      },
      setOver,
    ).then((u) => (un = u));
    return () => un?.();
  }, [openPath]);

  // opened via file association / command line
  useEffect(() => {
    if (initialDemoChecked) return;
    initialDemoChecked = true;
    void initialDemo().then((p) => {
      if (p) void openPath(p);
    });
  }, [openPath]);

  // browser mode: auto-load fixtures
  useEffect(() => {
    if (!tauri && phase === "start" && !new URLSearchParams(location.search).has("manual")) void openFixtures();
  }, [tauri, phase, openFixtures]);

  const pick = async () => {
    const p = await pickDemoFile();
    if (p) void openPath(p);
  };
  const loading = phase === "loading";
  return (
    <div className="start">
      <div className="start-card">
        <div className="logo">
          <svg width="44" height="44" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="8" fill="#13202e" stroke="#2a3d55" />
            <path d="M17 8l-9 8 9 8v-6c5 0 8 2 10 5-1-6-4-11-10-12z" fill="#35d0ba" />
          </svg>
          <div>
            <h1>Rewind</h1>
            <p>Counter-Strike 2 demo izleyici ve analiz aracı</p>
          </div>
        </div>
        <div
          className={"drop" + (over ? " over" : "") + (loading ? " busy" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (!tauri) setMsg("Tarayıcı modunda dosya okunamaz; örnek veri otomatik yüklenir. Masaüstü uygulamasında .dem dosyasını buraya bırakın.");
          }}
        >
          {loading ? (
            <div className="loading">
              <div className="spinner" />
              <b>{progress.stage || "Yükleniyor"}</b>
              <div className="pbar">
                <i style={{ width: `${Math.round(progress.pct * 100)}%` }} />
              </div>
              <span className="muted">%{Math.round(progress.pct * 100)}</span>
            </div>
          ) : (
            <>
              <Icon n="folder" size={34} />
              <b>.dem dosyasını buraya sürükleyip bırakın</b>
              <span className="muted">ya da</span>
              <button className="btn primary" onClick={pick} disabled={!tauri} title={tauri ? "" : "Dosya seçici yalnızca masaüstü uygulamasında çalışır"}>
                Dosya aç…
              </button>
              {!tauri && (
                <button className="btn" onClick={() => void openFixtures()}>
                  Örnek veriyi yükle
                </button>
              )}
            </>
          )}
        </div>
        {error && (
          <div className="error" role="alert">
            <b>Demo yüklenemedi</b>
            <pre>{error}</pre>
            <button className="btn" onClick={() => useStore.setState({ phase: "start", error: null })}>
              Tekrar dene
            </button>
          </div>
        )}
        {msg && <div className="note">{msg}</div>}
        <ul className="feats">
          <li>2B harita ve oyun benzeri 3B görünüm</li>
          <li>Oyuncu bazlı zaman çizelgesi, içgörüler ve yardımcı malzeme koçu</li>
          <li>Ses sohbeti, video dışa aktarma</li>
          <li>Her şey cihazınızda çalışır; ağ bağlantısı gerekmez</li>
        </ul>
      </div>
    </div>
  );
}
