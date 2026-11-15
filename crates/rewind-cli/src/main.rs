//! rewind-cli: export the Tauri command payloads of a demo to disk, or print a summary.
//!
//!   rewind-cli export <demo.dem> --out <dir> [--library <lineups.json>]
//!   rewind-cli summary <demo.dem> [--insights N] [--round R]
//!   rewind-cli learn <out_seed.json> <demo.dem>...      (builds the bundled seed lineup library)

use rewind_core::lineups::{LibraryFile, LineupLibrary};
use rewind_core::{load_file, LoadOptions};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  rewind-cli export <demo.dem> --out <dir> [--library <lineups.json>]\n  rewind-cli summary <demo.dem> [--insights N] [--round R]\n  rewind-cli learn <out_seed.json> <demo.dem>..."
    );
    ExitCode::from(2)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else { return usage() };
    let res = match cmd.as_str() {
        "export" => export(&args[1..]),
        "summary" => summary(&args[1..]),
        "learn" => learn(&args[1..]),
        _ => return usage(),
    };
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn progress(stage: &str, pct: f32) {
    if std::env::var("REWIND_PROGRESS").is_ok() {
        static T0: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        let t0 = T0.get_or_init(Instant::now);
        eprintln!("[{:>3.0}%] {stage} +{:.2}s", pct * 100.0, t0.elapsed().as_secs_f64());
    }
}

fn export(args: &[String]) -> Result<(), String> {
    let demo = args.first().filter(|a| !a.starts_with("--")).ok_or("missing demo path")?;
    let out = PathBuf::from(arg_value(args, "--out").ok_or("missing --out <dir>")?);
    let library = arg_value(args, "--library").map(|p| LineupLibrary::load(Path::new(&p)));
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let t0 = Instant::now();
    let opts = LoadOptions { library: library.as_ref() };
    let loaded = load_file(Path::new(demo), &opts, &progress).map_err(|e| e.to_string())?;
    let t_load = t0.elapsed();
    let json = serde_json::to_vec(&loaded.data).map_err(|e| e.to_string())?;
    std::fs::write(out.join("demo.json"), &json).map_err(|e| e.to_string())?;
    let frames = loaded.frames_bytes();
    std::fs::write(out.join("frames.bin"), &frames).map_err(|e| e.to_string())?;
    let t1 = Instant::now();
    let ids: Vec<String> = loaded.data.voice.players.iter().map(|p| p.steam_id.clone()).collect();
    let results: Vec<Result<bool, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = ids
            .iter()
            .map(|id| {
                let loaded = &loaded;
                let out = &out;
                s.spawn(move || match loaded.voice_pcm_bytes(id) {
                    Some(pcm) => std::fs::write(out.join(format!("voice_{id}.bin")), pcm).map(|_| true).map_err(|e| e.to_string()),
                    None => Ok(false),
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or(Ok(false))).collect()
    });
    let mut voice_files = 0;
    for r in results {
        if r? {
            voice_files += 1;
        }
    }
    eprintln!(
        "exported {} ({} rounds, {} players, {} frames) to {}: demo.json {:.1} MB, frames.bin {:.1} MB, {} voice files; load {:.2}s, voice decode {:.2}s",
        demo,
        loaded.data.rounds.len(),
        loaded.data.players.len(),
        loaded.data.frames.frame_count,
        out.display(),
        json.len() as f64 / 1e6,
        frames.len() as f64 / 1e6,
        voice_files,
        t_load.as_secs_f64(),
        t1.elapsed().as_secs_f64()
    );
    Ok(())
}

fn summary(args: &[String]) -> Result<(), String> {
    let demo = args.first().filter(|a| !a.starts_with("--")).ok_or("missing demo path")?;
    let n_ins: usize = arg_value(args, "--insights").and_then(|s| s.parse().ok()).unwrap_or(40);
    let only_round: Option<u32> = arg_value(args, "--round").and_then(|s| s.parse().ok());
    let t0 = Instant::now();
    let loaded = load_file(Path::new(demo), &LoadOptions::default(), &progress).map_err(|e| e.to_string())?;
    let d = &loaded.data;
    println!("{} | {} | source={} | {} ticks ({:.1} min) | parsed in {:.2}s", d.header.file_name, d.header.map_name, d.header.source, d.header.total_ticks, d.header.duration_seconds / 60.0, t0.elapsed().as_secs_f64());
    println!("server: {}", d.header.server_name);
    let mut score = [0u32; 2];
    for r in &d.rounds {
        if let Some(w) = r.winner {
            score[if r.team_sides[0] == w { 0 } else { 1 }] += 1;
        }
    }
    let tn = |t: usize| d.players.iter().find(|p| p.team as usize == t).map(|p| p.team_name.clone()).unwrap_or_default();
    println!("score: {} {} - {} {}  ({} rounds)", tn(0), score[0], score[1], tn(1), d.rounds.len());
    println!("rounds: {}", d.rounds.iter().map(|r| format!("{}{}", r.number, match r.winner { Some(w) if r.team_sides[0] == w => "a", Some(_) => "b", None => "?" })).collect::<Vec<_>>().join(" "));
    println!();
    println!("{:<22} {:>4} {:>3} {:>3} {:>3} {:>6} {:>5} {:>5} {:>4} {:>4} {:>5} {:>5} {:>5}  sub-scores", "player", "team", "K", "D", "A", "ADR", "KAST", "HS%", "OK", "OD", "rat", "score", "acc");
    for t in 0..2u8 {
        let mut ps: Vec<_> = d.players.iter().filter(|p| p.team == t).collect();
        ps.sort_by(|a, b| d.analysis.players[b.slot].rating.partial_cmp(&d.analysis.players[a.slot].rating).unwrap_or(std::cmp::Ordering::Equal));
        for p in ps {
            let s = &d.analysis.players[p.slot];
            let subs: Vec<String> = s.sub_scores.iter().map(|(k, v)| format!("{}={:.0}", &k[..3], v)).collect();
            println!(
                "{:<22} {:>4} {:>3} {:>3} {:>3} {:>6.1} {:>5.1} {:>5.1} {:>4} {:>4} {:>5.2} {:>5.0} {:>5.1}  {}",
                p.name.chars().take(22).collect::<String>(), t, s.kills, s.deaths, s.assists, s.adr, s.kast, s.hs_percent, s.opening_kills, s.opening_deaths, s.rating, s.score, s.accuracy, subs.join(" ")
            );
        }
    }
    println!();
    println!("voice: available={} players={} (sampleRate {})", d.voice.available, d.voice.players.len(), d.voice.sample_rate);
    println!("grenades={} kills={} damages={} shots={} blinds={} chat={} insights={}", d.grenades.len(), d.kills.len(), d.damages.len(), d.shots.len(), d.blinds.len(), d.chat.len(), d.analysis.insights.len());
    let mut kinds = std::collections::BTreeMap::new();
    for i in &d.analysis.insights {
        *kinds.entry(i.kind.clone()).or_insert(0) += 1;
    }
    println!("insight kinds: {:?}", kinds);
    println!();
    for ra in &d.analysis.rounds {
        if only_round.map(|r| r != ra.round).unwrap_or(false) {
            continue;
        }
        let mvp = ra.mvp.map(|s| d.players[s].name.clone()).unwrap_or_default();
        println!("R{:>2} mvp={:<16} {}", ra.round, mvp, ra.summary);
    }
    println!();
    let mut shown = 0;
    for i in &d.analysis.insights {
        if only_round.map(|r| r != i.round).unwrap_or(false) {
            continue;
        }
        if shown >= n_ins {
            break;
        }
        shown += 1;
        let sug = i.suggestion.as_ref().map(|s| format!("\n        -> öneri: {} [{} x{}] {}", s.label, s.source, s.support, s.reason)).unwrap_or_default();
        println!("R{:>2} {:<14} {:<5} {:+5.1} {:<18} {} — {}{}", i.round, d.players[i.player].name.chars().take(14).collect::<String>(), i.severity, i.score_delta, i.kind, i.title, i.detail, sug);
    }
    Ok(())
}

fn learn(args: &[String]) -> Result<(), String> {
    let out = args.first().ok_or("missing output path")?;
    let mut lib = LibraryFile { version: 1, ..Default::default() };
    for demo in &args[1..] {
        let t0 = Instant::now();
        let empty = LineupLibrary::default();
        let loaded = match load_file(Path::new(demo), &LoadOptions { library: Some(&empty) }, &progress) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("skip {demo}: {e}");
                continue;
            }
        };
        lib.demos += 1;
        let n = loaded.learned_lineups.len();
        for l in loaded.learned_lineups {
            rewind_core::lineups::merge_into(&mut lib.lineups, l);
        }
        eprintln!("{demo}: {n} successful throws ({:.1}s), library now {}", t0.elapsed().as_secs_f64(), lib.lineups.len());
    }
    let json = serde_json::to_string(&lib).map_err(|e| e.to_string())?;
    std::fs::write(out, json).map_err(|e| e.to_string())?;
    Ok(())
}
