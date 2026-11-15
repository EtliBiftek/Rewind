//! Rewind desktop app (Tauri v2). Commands follow `src/lib/contract.ts`.

use rewind_core::lineups::LineupLibrary;
use rewind_core::model::{DemoData, LibraryStats};
use rewind_core::{LoadOptions, LoadedDemo};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct Inner {
    demo: Option<Arc<LoadedDemo>>,
    /// decoded voice PCM (bytes) per steam id for the current demo
    voice_cache: HashMap<String, Arc<Vec<u8>>>,
}

#[derive(Default)]
struct AppState {
    inner: Mutex<Inner>,
    library: Mutex<Option<LineupLibrary>>,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    stage: String,
    pct: f32,
}

fn library_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("lineups.json"))
}

fn with_library<R>(app: &AppHandle, state: &AppState, f: impl FnOnce(&mut LineupLibrary) -> R) -> R {
    let mut guard = state.library.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(match library_path(app) {
            Some(p) => LineupLibrary::load(&p),
            None => LineupLibrary::seed(),
        });
    }
    f(guard.as_mut().expect("library initialised above"))
}

/// Cheap identity of a demo file so the same demo is not learned twice.
fn demo_id(path: &Path, data: &DemoData) -> String {
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let first_kill = data.kills.first().map(|k| k.tick).unwrap_or(0);
    format!("{}:{}:{}:{}", data.header.map_name, data.header.total_ticks, len, first_kill)
}

#[tauri::command]
async fn load_demo(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<DemoData, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_file() {
        return Err(format!("Dosya bulunamadı: {path}"));
    }
    // Release the previous demo before parsing the next one (memory).
    {
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.demo = None;
        inner.voice_cache.clear();
    }
    let library = with_library(&app, &state, |lib| lib.clone());
    let app2 = app.clone();
    let p2 = path_buf.clone();
    let loaded = tauri::async_runtime::spawn_blocking(move || {
        let last_emit = Mutex::new((Instant::now() - Duration::from_secs(1), -1.0f32));
        let progress = |stage: &str, pct: f32| {
            let mut le = last_emit.lock().unwrap_or_else(|e| e.into_inner());
            if pct >= 1.0 || pct - le.1 >= 0.01 || le.0.elapsed() > Duration::from_millis(150) {
                *le = (Instant::now(), pct);
                let _ = app2.emit(
                    "demo-progress",
                    ProgressPayload { stage: rewind_core::stage_label(stage).to_string(), pct: pct.clamp(0.0, 1.0) },
                );
            }
        };
        rewind_core::load_file(&p2, &LoadOptions { library: Some(&library) }, &progress)
    })
    .await
    .map_err(|e| format!("Yükleme iş parçacığı hatası: {e}"))?
    .map_err(|e| format!("Demo yüklenemedi: {e}"))?;

    // Learn successful grenades into the persistent library.
    let id = demo_id(&path_buf, &loaded.data);
    let learned = loaded.learned_lineups.clone();
    let app3 = app.clone();
    with_library(&app, &state, |lib| {
        if lib.merge_demo(&id, &learned) {
            if let Some(p) = library_path(&app3) {
                let _ = lib.save(&p);
            }
        }
    });

    let data = loaded.data.clone();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.demo = Some(Arc::new(loaded));
    inner.voice_cache.clear();
    Ok(data)
}

fn current_demo(state: &AppState) -> Result<Arc<LoadedDemo>, String> {
    state
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .demo
        .clone()
        .ok_or_else(|| "Yüklü demo yok".to_string())
}

#[tauri::command]
async fn get_frames(state: State<'_, AppState>) -> Result<Response, String> {
    let demo = current_demo(&state)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || demo.frames_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn get_voice_pcm(state: State<'_, AppState>, steam_id: String) -> Result<Response, String> {
    if let Some(c) = state.inner.lock().unwrap_or_else(|e| e.into_inner()).voice_cache.get(&steam_id) {
        return Ok(Response::new(c.as_ref().clone()));
    }
    let demo = current_demo(&state)?;
    let id = steam_id.clone();
    let pcm = tauri::async_runtime::spawn_blocking(move || demo.voice_pcm_bytes(&id))
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let pcm = Arc::new(pcm);
    state.inner.lock().unwrap_or_else(|e| e.into_inner()).voice_cache.insert(steam_id, pcm.clone());
    Ok(Response::new(pcm.as_ref().clone()))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = std::str::from_utf8(&b[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The frontend sends non-ASCII paths percent-encoded (headers must be ASCII).
fn header_path(raw: &str) -> String {
    if raw.contains('%') {
        if let Some(d) = percent_decode(raw) {
            if !d.is_ascii() {
                return d;
            }
        }
    }
    raw.to_string()
}

#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let headers = request.headers();
    let path = headers
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(header_path)
        .ok_or("x-path başlığı eksik")?;
    let append = headers.get("x-append").and_then(|v| v.to_str().ok()).map(|v| v == "1").unwrap_or(false);
    let body: &[u8] = match request.body() {
        InvokeBody::Raw(b) => b,
        InvokeBody::Json(serde_json::Value::Null) => &[],
        InvokeBody::Json(_) => return Err("Ham (binary) gövde bekleniyordu".into()),
    };
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&path)
        .map_err(|e| format!("{path}: {e}"))?;
    f.write_all(body).map_err(|e| format!("{path}: {e}"))?;
    Ok(())
}

#[tauri::command]
fn library_stats(app: AppHandle, state: State<'_, AppState>) -> LibraryStats {
    with_library(&app, &state, |lib| lib.stats())
}

/// A `.dem` path passed on the command line (file association / "open with"), if any.
#[tauri::command]
fn initial_demo() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("dem")) && p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// End-to-end self test through the real IPC layer (used by CI / developers):
/// `REWIND_SELFTEST=/path/demo.dem rewind` loads the demo from the webview with the same
/// `invoke` calls the frontend uses, prints a JSON report to stdout and exits.
fn install_selftest(app: &tauri::App) {
    use tauri::Listener;
    let Ok(demo) = std::env::var("REWIND_SELFTEST") else { return };
    let progress = Arc::new(Mutex::new(0u32));
    let p2 = progress.clone();
    app.listen("demo-progress", move |_| *p2.lock().unwrap_or_else(|e| e.into_inner()) += 1);
    let handle = app.handle().clone();
    app.listen("rewind-selftest", move |ev| {
        let n = *progress.lock().unwrap_or_else(|e| e.into_inner());
        println!("SELFTEST {} progressEvents={n}", ev.payload());
        handle.exit(0);
    });
    let tmp = std::env::temp_dir().join("rewind-selftest.bin");
    let js = format!(
        r#"(async () => {{
  const inv = window.__TAURI_INTERNALS__.invoke;
  const len = (b) => (b && (b.byteLength ?? b.length)) || 0;
  const out = {{}};
  try {{
    const t0 = performance.now();
    const d = await inv('load_demo', {{ path: {demo} }});
    out.loadMs = Math.round(performance.now() - t0);
    out.rounds = d.rounds.length; out.players = d.players.length; out.insights = d.analysis.insights.length;
    const fr = await inv('get_frames');
    out.framesBytes = len(fr); out.expectFrames = d.frames.frameCount * d.frames.playerCount * d.frames.stride * 4;
    if (d.voice.players.length) {{
      const vp = d.voice.players[0];
      const v = await inv('get_voice_pcm', {{ steamId: vp.steamId }});
      out.voiceBytes = len(v); out.expectVoice = vp.totalSamples * 2;
    }}
    await inv('write_file', new Uint8Array([1, 2, 3]), {{ headers: {{ 'x-path': {tmp}, 'x-append': '0' }} }});
    await inv('write_file', new Uint8Array([4, 5]), {{ headers: {{ 'x-path': {tmp}, 'x-append': '1' }} }});
    out.lib = await inv('library_stats');
  }} catch (e) {{ out.error = String(e); }}
  await inv('plugin:event|emit', {{ event: 'rewind-selftest', payload: out }});
}})();"#,
        demo = serde_json::to_string(&demo).unwrap_or_default(),
        tmp = serde_json::to_string(&tmp.to_string_lossy()).unwrap_or_default()
    );
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.eval(&js);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            install_selftest(app);
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![load_demo, get_frames, get_voice_pcm, write_file, library_stats, initial_demo])
        .run(tauri::generate_context!())
        .expect("error while running Rewind");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn header_paths() {
        assert_eq!(header_path("C:\\Users\\a\\video.mp4"), "C:\\Users\\a\\video.mp4");
        assert_eq!(header_path("/tmp/%C3%B6rnek.mp4"), "/tmp/örnek.mp4");
        // ASCII path that merely contains a percent sign stays untouched
        assert_eq!(header_path("/tmp/100%25.mp4"), "/tmp/100%25.mp4");
    }
}
