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
    /// One map export at a time (a second request for the same map then hits the cache).
    /// (held only inside `spawn_blocking`)
    map_export: Mutex<()>,
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

// ------------------------------------------------------------------ real map (CS2 install)

#[derive(Serialize, serde::Deserialize, Default)]
struct Cs2Config {
    /// User-chosen CS2 folder (anything `resolve_user_path` accepts); None = automatic discovery.
    path: Option<String>,
}

fn cs2_config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("cs2.json"))
}

fn read_cs2_config(app: &AppHandle) -> Cs2Config {
    cs2_config_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The `game/csgo` folder to use and where it came from ("manual" | "auto").
fn cs2_dir(app: &AppHandle) -> Result<(PathBuf, &'static str), String> {
    if let Some(p) = read_cs2_config(app).path {
        return match rewind_assets::steam::resolve_user_path(Path::new(&p)) {
            Some(d) => Ok((d, "manual")),
            None => Err(rewind_assets::Error::NotCs2(PathBuf::from(p)).to_string()),
        };
    }
    rewind_assets::steam::discover().map(|d| (d, "auto")).ok_or_else(|| rewind_assets::Error::NotFound.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cs2Status {
    found: bool,
    path: Option<String>,
    source: Option<&'static str>,
    maps: Vec<String>,
    error: Option<String>,
}

fn cs2_status_of(app: &AppHandle) -> Cs2Status {
    match cs2_dir(app) {
        Ok((d, source)) => Cs2Status {
            found: true,
            maps: rewind_assets::Game::list_maps(&d).into_iter().map(|m| m.name).collect(),
            path: Some(d.to_string_lossy().into_owned()),
            source: Some(source),
            error: None,
        },
        Err(e) => Cs2Status { found: false, path: read_cs2_config(app).path, source: None, maps: Vec::new(), error: Some(e) },
    }
}

#[tauri::command]
async fn cs2_status(app: AppHandle) -> Cs2Status {
    tauri::async_runtime::spawn_blocking(move || cs2_status_of(&app)).await.unwrap_or(Cs2Status {
        found: false,
        path: None,
        source: None,
        maps: Vec::new(),
        error: Some("Durum okunamadı".into()),
    })
}

/// Sets (or with `null` clears) the manual CS2 folder. Rejects folders that are not an install.
#[tauri::command]
async fn set_cs2_path(app: AppHandle, path: Option<String>) -> Result<Cs2Status, String> {
    if let Some(p) = &path {
        if rewind_assets::steam::resolve_user_path(Path::new(p)).is_none() {
            return Err(rewind_assets::Error::NotCs2(PathBuf::from(p)).to_string());
        }
    }
    let cfg = cs2_config_path(&app).ok_or("Ayar klasörü bulunamadı")?;
    if let Some(d) = cfg.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("Ayar kaydedilemedi: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(&Cs2Config { path }).map_err(|e| e.to_string())?;
    std::fs::write(&cfg, body).map_err(|e| format!("Ayar kaydedilemedi: {e}"))?;
    Ok(tauri::async_runtime::spawn_blocking(move || cs2_status_of(&app)).await.map_err(|e| e.to_string())?)
}

#[derive(Clone, Serialize)]
struct MapProgress {
    map: String,
    stage: String,
    pct: f32,
}

/// `de_mirage`, `workshop/123/de_x` -> `de_x`
fn bare_map_name(m: &str) -> String {
    m.rsplit(['/', '\\']).next().unwrap_or(m).trim().to_ascii_lowercase()
}

/// The real map as binary glTF (raw bytes), exported from the CS2 install on first use and
/// cached in the app cache dir afterwards. Emits `map-progress`.
#[tauri::command]
async fn get_map_scene(app: AppHandle, map_name: String, quality: String, textures: Option<String>) -> Result<Response, String> {
    let map = bare_map_name(&map_name);
    let quality = rewind_assets::Quality::parse(&quality).unwrap_or(rewind_assets::Quality::Medium);
    let textures = match textures.as_deref() {
        Some("image") => rewind_assets::TexFormat::Image,
        _ => rewind_assets::TexFormat::Ktx2,
    };
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("maps");
    let app2 = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let st = app2.state::<AppState>();
        let _guard = st.map_export.lock().unwrap_or_else(|e| e.into_inner());
        let (dir, _) = cs2_dir(&app2)?;
        let game = rewind_assets::Game::open(&dir).map_err(|e| e.to_string())?;
        let opts = rewind_assets::ExportOptions { quality, textures, entity_props: true };
        let last = Mutex::new((Instant::now() - Duration::from_secs(1), -1.0f32));
        let map2 = map.clone();
        let progress = |stage: &str, pct: f32| {
            let mut le = last.lock().unwrap_or_else(|e| e.into_inner());
            if pct >= 1.0 || pct - le.1 >= 0.02 || le.0.elapsed() > Duration::from_millis(200) {
                *le = (Instant::now(), pct);
                let _ = app2.emit("map-progress", MapProgress { map: map2.clone(), stage: stage.to_string(), pct: pct.clamp(0.0, 1.0) });
            }
        };
        let t0 = Instant::now();
        let scene = rewind_assets::cache::get_or_export(&game, &cache_dir, &map, &opts, &progress).map_err(|e| e.to_string())?;
        eprintln!(
            "[rewind] map {map} {} {} bytes in {} ms ({})",
            quality.as_str(),
            scene.glb.len(),
            t0.elapsed().as_millis(),
            if scene.from_cache { "cache" } else { "exported" }
        );
        Ok(scene.glb)
    })
    .await
    .map_err(|e| format!("Harita iş parçacığı hatası: {e}"))??;
    Ok(Response::new(res))
}

/// An agent / weapon model (skinned GLB, Source space) or an animation resource (KV3 as JSON) of
/// the CS2 install, for the in-game look of the 3D view. Cached in the app cache dir.
#[tauri::command]
async fn get_actor_asset(app: AppHandle, path: String, textures: Option<String>) -> Result<Response, String> {
    if !rewind_assets::actors::allowed(&path) {
        return Err(format!("İzin verilmeyen dosya: {path}"));
    }
    let tex = match textures.as_deref() {
        Some("image") => rewind_assets::TexFormat::Image,
        _ => rewind_assets::TexFormat::Ktx2,
    };
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("actors");
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let (dir, _) = cs2_dir(&app)?;
        let game = rewind_assets::Game::open(&dir).map_err(|e| e.to_string())?;
        rewind_assets::actors::get_or_export(&game, &cache_dir, &path, tex, 1024).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Model iş parçacığı hatası: {e}"))??;
    Ok(Response::new(res))
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
    out.cs2 = await inv('cs2_status');
    try {{
      const t1 = performance.now();
      const g = await inv('get_map_scene', {{ mapName: d.header.mapName, quality: 'low' }});
      out.mapBytes = len(g); out.mapMs = Math.round(performance.now() - t1);
      const t2 = performance.now();
      const g2 = await inv('get_map_scene', {{ mapName: d.header.mapName, quality: 'low' }});
      out.mapCachedMs = Math.round(performance.now() - t2); out.mapSame = len(g2) === out.mapBytes;
    }} catch (e) {{ out.mapError = String(e); }}
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
        .invoke_handler(tauri::generate_handler![
            load_demo,
            get_frames,
            get_voice_pcm,
            write_file,
            library_stats,
            initial_demo,
            cs2_status,
            set_cs2_path,
            get_map_scene,
            get_actor_asset
        ])
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
    #[test]
    fn map_names() {
        assert_eq!(bare_map_name("de_mirage"), "de_mirage");
        assert_eq!(bare_map_name("workshop/123/De_X"), "de_x");
        assert_eq!(bare_map_name("maps\\de_ancient"), "de_ancient");
    }
}
