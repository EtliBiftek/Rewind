//! Grenade evaluation, utility insights and lineup suggestions.

use super::insights::{Builder, New};
use super::{dist2, dist3, text, Ctx};
use crate::demo::TICK_RATE;
use crate::lineups::{same_lineup, Lineup, LineupLibrary};
use crate::model::*;

/// Map name without workshop prefix / variant suffix, e.g. "de_inferno_s2" -> "de_inferno".
pub fn base_map(name: &str) -> String {
    crate::maps::find_radar(name).map(|r| r.name.to_string()).unwrap_or_else(|| name.rsplit(['/', '\\']).next().unwrap_or(name).to_ascii_lowercase())
}

fn downsample_xyz(traj: &[f32], max_pts: usize) -> Vec<f32> {
    // input: [tick, x, y, z]...
    let pts: Vec<[f32; 3]> = traj.chunks_exact(4).map(|c| [c[1], c[2], c[3]]).collect();
    if pts.is_empty() {
        return vec![];
    }
    let step = (pts.len() as f32 / max_pts as f32).max(1.0);
    let mut out = vec![];
    let mut i = 0.0f32;
    while (i as usize) < pts.len() {
        let p = pts[i as usize];
        out.extend_from_slice(&[(p[0] * 10.0).round() / 10.0, (p[1] * 10.0).round() / 10.0, (p[2] * 10.0).round() / 10.0]);
        i += step;
    }
    let last = pts[pts.len() - 1];
    if out.len() >= 3 && out[out.len() - 3..] != [last[0], last[1], last[2]] {
        out.extend_from_slice(&[(last[0] * 10.0).round() / 10.0, (last[1] * 10.0).round() / 10.0, (last[2] * 10.0).round() / 10.0]);
    }
    out
}

fn ang_diff(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

fn r1(v: Vec3) -> Vec3 {
    [(v[0] * 10.0).round() / 10.0, (v[1] * 10.0).round() / 10.0, (v[2] * 10.0).round() / 10.0]
}

fn to_lineup(ctx: &Ctx<'_>, g: &Grenade, side: Side) -> Option<Lineup> {
    let land = g.detonate_pos?;
    Some(Lineup {
        map: base_map(&ctx.data.header.map_name),
        kind: g.kind,
        side,
        from: r1(g.throw_pos),
        from_place: g.throw_place.clone(),
        yaw: (g.throw_yaw * 100.0).round() / 100.0,
        pitch: (g.throw_pitch * 100.0).round() / 100.0,
        style: g.throw_style.clone(),
        land: r1(land),
        land_place: g.land_place.clone(),
        trajectory: downsample_xyz(&g.trajectory, 24),
        support: 1,
    })
}

/// Enemies (alive) of `side` within `radius` of `pos` at `tick`.
fn enemies_near(ctx: &Ctx<'_>, round: u32, side: Side, pos: Vec3, tick: i32, radius: f32) -> usize {
    ctx.alive_of_side(round, side.other(), tick)
        .into_iter()
        .filter(|s| ctx.pos_at(*s, tick).map(|p| dist3(p, pos) <= radius).unwrap_or(false))
        .count()
}

struct Outcome {
    success: bool,
}

fn evaluate(ctx: &Ctx<'_>, g: &Grenade, side: Side) -> Outcome {
    let success = match g.kind {
        GrenadeType::Flash => g.enemies_flashed >= 1 && g.enemy_blind_seconds >= 1.5 && g.teammates_flashed == 0,
        GrenadeType::He => g.damage >= 30,
        GrenadeType::Molotov => g.damage >= 15,
        GrenadeType::Smoke => {
            // a smoke is a "lineup candidate" if it was thrown from range (not dropped at feet), during the round
            match (g.detonate_pos, g.detonate_tick) {
                (Some(p), Some(_)) => dist2(p, g.throw_pos) > 500.0 && g.throw_tick >= ctx.round(g.round).freeze_end_tick,
                _ => false,
            }
        }
        GrenadeType::Decoy => false,
    };
    let _ = side;
    Outcome { success }
}

struct Candidate {
    l: Lineup,
    source: &'static str,
}

fn land_radius(k: GrenadeType) -> f32 {
    match k {
        GrenadeType::Smoke => 380.0,
        GrenadeType::Flash => 320.0,
        GrenadeType::He => 350.0,
        GrenadeType::Molotov => 420.0,
        GrenadeType::Decoy => 0.0,
    }
}

fn min_support(c: &Candidate) -> u32 {
    match (c.source, c.l.kind) {
        // smokes are not outcome-verified: require that several players used the same lineup
        (_, GrenadeType::Smoke) => 2,
        ("this_demo", _) => 1,
        _ => 2,
    }
}

fn suggest(g: &Grenade, side: Side, map: &str, cands: &[Candidate], why: &str) -> Option<UtilitySuggestion> {
    let land = g.detonate_pos?;
    let r = land_radius(g.kind);
    let mut best: Option<(f32, &Candidate, f32, f32)> = None;
    for c in cands {
        if c.l.map != map || c.l.kind != g.kind || c.l.side != side || c.l.support < min_support(c) {
            continue;
        }
        let dl = dist2(c.l.land, land) + (c.l.land[2] - land[2]).abs() * 0.5;
        let df = dist2(c.l.from, g.throw_pos);
        if dl > r {
            continue;
        }
        // the very same throw adds nothing
        if dl < 120.0 && df < 150.0 {
            continue;
        }
        // must be reachable: thrown from within a reasonable walk of where the player stood
        if df > 1800.0 {
            continue;
        }
        let score = (1.0 + c.l.support as f32).ln() - 0.8 * dl / r - 0.6 * df / 1800.0;
        if best.as_ref().map(|b| score > b.0).unwrap_or(true) {
            best = Some((score, c, dl, df));
        }
    }
    let (_, c, dl, df) = best?;
    Some(make_suggestion(c, dl, df, why))
}

fn make_suggestion(c: &Candidate, dl: f32, df: f32, why: &str) -> UtilitySuggestion {
    let l = &c.l;
    let land_name = text::place(l.land_place.as_deref()).unwrap_or_else(|| "hedef nokta".into());
    let from_name = text::place(l.from_place.as_deref()).unwrap_or_else(|| "yakın bir nokta".into());
    let label = format!("{} {} — atış yeri: {}, {}", land_name, text::grenade(l.kind), from_name, text::style(&l.style));
    let src = match c.source {
        "seed" => "Hazır lineup kütüphanesindeki",
        "library" => "Daha önce yüklediğin demolardaki",
        _ => "Bu maçtaki",
    };
    let aim = format!(
        "Nişan: yaw {:.1}°, pitch {:.1}° ({}), {} at.",
        l.yaw,
        l.pitch,
        if l.pitch < 0.0 { "yukarı" } else { "aşağı" },
        text::style(&l.style)
    );
    let move_hint = if df > 120.0 { format!(" Bunun için {:.0} birim uzaktaki atış noktasına geç.", df) } else { " Durduğun yere çok yakın bir noktadan atılıyor.".into() };
    let reason = format!(
        "{why} {src} başarılı {} örneklerinden {} tanesi bu şekilde atılmış; senin {}in düştüğü yerin {:.0} birim yakınına iniyor.{move_hint} {aim}",
        text::grenade(l.kind),
        l.support,
        match l.kind {
            GrenadeType::Smoke => "smoke'u",
            GrenadeType::Flash => "flaşı",
            GrenadeType::He => "HE bombası",
            GrenadeType::Molotov => "molotofu",
            GrenadeType::Decoy => "decoy'u",
        },
        dl
    );
    UtilitySuggestion {
        kind: l.kind,
        label,
        from: l.from,
        from_place: l.from_place.clone(),
        aim_yaw: l.yaw,
        aim_pitch: l.pitch,
        throw_style: l.style.clone(),
        land: l.land,
        land_place: l.land_place.clone(),
        trajectory: l.trajectory.clone(),
        source: c.source.to_string(),
        support: l.support,
        reason,
    }
}

pub fn analyze_utility(ctx: &Ctx<'_>, lib: &LineupLibrary, b: &mut Builder) -> Vec<Lineup> {
    let data = ctx.data;
    let map = base_map(&data.header.map_name);
    // successful throws of this demo
    let mut learned: Vec<(u32, Lineup)> = vec![];
    for g in &data.grenades {
        let Some(side) = ctx.side(g.round, g.thrower) else { continue };
        if g.kind == GrenadeType::Flash && data.blinds.is_empty() {
            continue;
        }
        if evaluate(ctx, g, side).success {
            if let Some(l) = to_lineup(ctx, g, side) {
                learned.push((g.id, l));
            }
        }
    }
    // candidate pool: seed + library + this demo (grouped)
    let mut cands: Vec<Candidate> = vec![];
    for l in lib.seed.iter().filter(|l| l.map == map) {
        cands.push(Candidate { l: l.clone(), source: "seed" });
    }
    for l in lib.user.lineups.iter().filter(|l| l.map == map) {
        cands.push(Candidate { l: l.clone(), source: "library" });
    }
    let this_demo_groups = |exclude: u32| -> Vec<Candidate> {
        let mut groups: Vec<Lineup> = vec![];
        for (id, l) in &learned {
            if *id == exclude {
                continue;
            }
            if let Some(gr) = groups.iter_mut().find(|x| same_lineup(x, l)) {
                gr.support += 1;
            } else {
                groups.push(l.clone());
            }
        }
        groups.into_iter().map(|l| Candidate { l, source: "this_demo" }).collect()
    };

    // Some demos carry no player_blind events at all; then flash outcomes are unknown.
    let flashes = data.grenades.iter().filter(|g| g.kind == GrenadeType::Flash).count();
    let flash_data = !(data.blinds.is_empty() && flashes > 3);
    for g in &data.grenades {
        let Some(side) = ctx.side(g.round, g.thrower) else { continue };
        if g.kind == GrenadeType::Flash && !flash_data {
            continue;
        }
        let r = ctx.round(g.round);
        if g.throw_tick > r.end_tick {
            continue;
        }
        let pos = g.detonate_pos.or(Some(g.throw_pos));
        let land_name = text::place(g.land_place.as_deref());
        let at = |s: &Option<String>| s.as_deref().map(|p| format!(" ({p} civarı)")).unwrap_or_default();
        let mut pool: Option<Vec<Candidate>> = None;
        let pool_get = |pool: &mut Option<Vec<Candidate>>| -> Vec<Candidate> {
            if pool.is_none() {
                let mut v: Vec<Candidate> = cands.iter().map(|c| Candidate { l: c.l.clone(), source: c.source }).collect();
                v.extend(this_demo_groups(g.id));
                *pool = Some(v);
            }
            pool.as_ref().unwrap().iter().map(|c| Candidate { l: c.l.clone(), source: c.source }).collect()
        };
        match g.kind {
            GrenadeType::Flash => {
                let Some(dt) = g.detonate_tick else { continue };
                // only "real" blinds count (turned-away players get short durations)
                let mine: Vec<&BlindEvent> = data.blinds.iter().filter(|bl| bl.grenade_id == Some(g.id)).collect();
                let eff_enemy: Vec<&&BlindEvent> = mine.iter().filter(|bl| !bl.team_flash && bl.duration >= 1.1).collect();
                let eff_team: Vec<&&BlindEvent> = mine.iter().filter(|bl| bl.team_flash && bl.victim != g.thrower && bl.duration >= 1.1).collect();
                let enemy_secs: f32 = mine.iter().filter(|bl| !bl.team_flash).map(|bl| bl.duration).sum();
                let team_secs: f32 = eff_team.iter().map(|bl| bl.duration).sum();
                let led_to_assist = data.kills.iter().any(|k| k.flash_assist && k.assister == Some(g.thrower) && k.tick >= dt && k.tick - dt < 5 * 64);
                if !eff_team.is_empty() && team_secs >= 1.5 && enemy_secs < team_secs {
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "team_flash",
                        category: "utility",
                        severity: "bad",
                        title: "Takım arkadaşlarını kör ettin".into(),
                        detail: format!(
                            "Attığın flaş{} {} takım arkadaşını toplam {} sn kör etti{}.",
                            at(&land_name),
                            eff_team.len(),
                            text::secs(team_secs),
                            if enemy_secs > 0.0 { format!(", rakiplerden ise yalnızca {} sn", text::secs(enemy_secs)) } else { ", hiçbir rakibi etkilemedi".into() }
                        ),
                        delta: -3.0,
                        pos,
                        grenade: Some(g.id),
                        suggestion: None,
                    });
                } else if enemy_secs < 0.8 && eff_team.is_empty() {
                    let det = g.detonate_pos.unwrap_or(g.throw_pos);
                    let near = enemies_near(ctx, g.round, side, det, dt, 800.0);
                    if near > 0 {
                        let sug = suggest(g, side, &map, &pool_get(&mut pool), "Bu flaş kimseyi kör etmedi.");
                        b.push(New {
                            round: g.round,
                            tick: dt,
                            player: g.thrower,
                            kind: "wasted_flash",
                            category: "utility",
                            severity: "bad",
                            title: "Flaş kimseyi kör etmedi".into(),
                            detail: format!(
                                "Attığın flaş{} patladığında {} rakip yakındaydı ama hiçbiri (etkili biçimde) kör olmadı. Flaşı rakibin göremeyeceği şekilde, duvarın arkasından ya da tepeden patlayacak biçimde at.",
                                at(&land_name),
                                near
                            ),
                            delta: -2.0,
                            pos,
                            grenade: Some(g.id),
                            suggestion: sug,
                        });
                    }
                } else if (eff_enemy.len() >= 2 || enemy_secs >= 3.0) && !eff_enemy.is_empty() && !led_to_assist && eff_team.is_empty() {
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "good_flash",
                        category: "utility",
                        severity: "good",
                        title: "Etkili flaş".into(),
                        detail: format!("Flaşın {} rakibi toplam {} sn kör etti.", eff_enemy.len(), text::secs(enemy_secs)),
                        delta: 3.0,
                        pos,
                        grenade: Some(g.id),
                        suggestion: None,
                    });
                }
            }
            GrenadeType::He => {
                let Some(dt) = g.detonate_tick else { continue };
                let det = g.detonate_pos.unwrap_or(g.throw_pos);
                let near = enemies_near(ctx, g.round, side, det, dt, 500.0);
                if g.damage == 0 && g.team_damage == 0 && near > 0 {
                    let sug = suggest(g, side, &map, &pool_get(&mut pool), "HE bombası hiç hasar vermedi.");
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "wasted_he",
                        category: "utility",
                        severity: "bad",
                        title: "HE bombası hasar vermedi".into(),
                        detail: format!(
                            "Attığın HE bombası{} kimseye hasar vermedi{}.",
                            at(&land_name),
                            format!(" (patladığında {near} rakip 500 birim içindeydi; zamanlama ya da isabet kaçtı)")
                        ),
                        delta: -2.0,
                        pos,
                        grenade: Some(g.id),
                        suggestion: sug,
                    });
                } else if g.damage >= 40 {
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "good_utility",
                        category: "utility",
                        severity: "good",
                        title: "Etkili HE bombası".into(),
                        detail: format!("HE bomban rakiplere toplam {} hasar verdi.", g.damage),
                        delta: (g.damage as f32 / 20.0).min(6.0),
                        pos,
                        grenade: Some(g.id),
                        suggestion: None,
                    });
                }
                if g.team_damage >= 20 {
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "team_damage",
                        category: "utility",
                        severity: "bad",
                        title: "HE bomban takımına hasar verdi".into(),
                        detail: format!("HE bomban takım arkadaşlarına {} hasar verdi.", g.team_damage),
                        delta: -2.0,
                        pos,
                        grenade: Some(g.id),
                        suggestion: None,
                    });
                }
            }
            GrenadeType::Molotov => {
                let (Some(dt), Some(det)) = (g.detonate_tick, g.detonate_pos) else { continue };
                let end = g.expire_tick.unwrap_or(dt + 7 * 64);
                if g.damage == 0 {
                    let mut denial = 0usize;
                    let mut t = dt;
                    while t <= end {
                        denial = denial.max(enemies_near(ctx, g.round, side, det, t, 600.0));
                        t += 16;
                    }
                    if denial == 0 {
                        let sug = suggest(g, side, &map, &pool_get(&mut pool), "Molotof ne hasar verdi ne de bir rakibi bölgeden çıkardı.");
                        b.push(New {
                            round: g.round,
                            tick: dt,
                            player: g.thrower,
                            kind: "wasted_molotov",
                            category: "utility",
                            severity: "bad",
                            title: "Molotof boşa gitti".into(),
                            detail: format!(
                                "Attığın molotof{} yanarken ({} sn) hiçbir rakip 600 birim yakınına gelmedi ve hasar vermedi. Molotofu rakibin gerçekten durduğu ya da geçeceği yere at.",
                                at(&land_name),
                                text::secs((end - dt) as f32 / TICK_RATE)
                            ),
                            delta: -2.0,
                            pos,
                            grenade: Some(g.id),
                            suggestion: sug,
                        });
                    }
                } else if g.damage >= 40 {
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "good_utility",
                        category: "utility",
                        severity: "good",
                        title: "Etkili molotof".into(),
                        detail: format!("Molotofun rakiplere toplam {} hasar verdi.", g.damage),
                        delta: (g.damage as f32 / 20.0).min(5.0),
                        pos,
                        grenade: Some(g.id),
                        suggestion: None,
                    });
                }
            }
            GrenadeType::Smoke => {
                let (Some(dt), Some(det)) = (g.detonate_tick, g.detonate_pos) else { continue };
                if dist2(det, g.throw_pos) < 300.0 {
                    continue; // dropped at feet on purpose (e.g. self-cover)
                }
                // compare with commonly used smoke spots for this map/side
                let pool_v = pool_get(&mut pool);
                let clusters: Vec<&Candidate> = pool_v
                    .iter()
                    .filter(|c| c.l.map == map && c.l.kind == GrenadeType::Smoke && c.l.side == side && c.l.support >= 2)
                    .collect();
                let on_target = clusters.iter().any(|c| dist2(c.l.land, det) <= 110.0 && (c.l.land[2] - det[2]).abs() < 120.0);
                if on_target {
                    continue;
                }
                let nearest = clusters
                    .iter()
                    .map(|c| (dist2(c.l.land, det), c))
                    .filter(|(d, c)| {
                        // the player evidently tried this lineup: same spot, (almost) the same aim
                        *d > 130.0
                            && *d <= 320.0
                            && (c.l.land[2] - det[2]).abs() < 150.0
                            && dist2(c.l.from, g.throw_pos) < 150.0
                            && ang_diff(c.l.yaw, g.throw_yaw) < 8.0
                            && (c.l.pitch - g.throw_pitch).abs() < 8.0
                    })
                    .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                if let Some((d, c)) = nearest {
                    let target = text::place(c.l.land_place.as_deref()).unwrap_or_else(|| "bilinen smoke noktası".into());
                    let df = dist2(c.l.from, g.throw_pos);
                    let sug = Some(make_suggestion(c, d, df, "Smoke'un aynı lineup'ın normalde düştüğü yere inmedi (nişan, atış tipi ya da hareket farkı)."));
                    b.push(New {
                        round: g.round,
                        tick: dt,
                        player: g.thrower,
                        kind: "bad_smoke",
                        category: "utility",
                        severity: "bad",
                        title: "Smoke hedefe oturmadı".into(),
                        detail: format!(
                            "Smoke'un {}açıldı; aynı yerden aynı nişanla atılan lineup normalde {target} noktasına düşüyor, seninki yaklaşık {:.0} birim saptı. Yanlış yere açılan smoke görüş hattını kapatmayabilir.",
                            land_name.as_deref().map(|p| format!("{p} civarında ")).unwrap_or_default(),
                            d
                        ),
                        delta: -2.0,
                        pos,
                        grenade: Some(g.id),
                        suggestion: sug,
                    });
                }
            }
            GrenadeType::Decoy => {}
        }
    }
    learned.into_iter().map(|(_, l)| l).collect()
}
