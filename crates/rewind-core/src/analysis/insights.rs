//! Insight generation (Turkish texts). Precision over quantity: every rule has guards
//! against the common false positives.

use super::text;
use super::{dist2, dist3, Ctx, RoundPlayerLine, TRADE_TICKS};
use crate::demo::TICK_RATE;
use crate::frames::is_firearm;
use crate::model::*;

pub struct Builder {
    pub items: Vec<Insight>,
}

pub struct New<'a> {
    pub round: u32,
    pub tick: i32,
    pub player: usize,
    pub kind: &'a str,
    pub category: &'a str,
    pub severity: &'a str,
    pub title: String,
    pub detail: String,
    pub delta: f32,
    pub pos: Option<Vec3>,
    pub grenade: Option<u32>,
    pub suggestion: Option<UtilitySuggestion>,
}

impl Builder {
    pub fn new() -> Builder {
        Builder { items: vec![] }
    }
    pub fn push(&mut self, n: New<'_>) {
        self.items.push(Insight {
            id: 0,
            round: n.round,
            tick: n.tick,
            player: n.player,
            kind: n.kind.to_string(),
            category: n.category.to_string(),
            severity: n.severity.to_string(),
            title: n.title,
            detail: n.detail,
            score_delta: (n.delta * 10.0).round() / 10.0,
            pos: n.pos,
            grenade_id: n.grenade,
            suggestion: n.suggestion,
        });
    }
    pub fn finish(mut self) -> Vec<Insight> {
        self.items.sort_by(|a, b| a.tick.cmp(&b.tick).then(a.player.cmp(&b.player)).then(a.kind.cmp(&b.kind)));
        for (i, it) in self.items.iter_mut().enumerate() {
            it.id = i as u32;
        }
        self.items
    }
}

/// Kinds whose scoreDelta is *extra* on top of the base kill/death/damage round score.
pub fn adds_to_round_score(kind: &str) -> bool {
    !matches!(kind, "multi_kill")
}

fn place_of_kill_victim(ctx: &Ctx<'_>, k: &KillEvent, di: usize) -> Option<String> {
    let raw = ctx.extra.deaths.get(di).and_then(|d| d.victim_place.clone()).or_else(|| ctx.place_at(k.victim, k.tick));
    text::place(raw.as_deref())
}

fn yaw_to(from: Vec3, to: Vec3) -> f32 {
    (to[1] - from[1]).atan2(to[0] - from[0]).to_degrees()
}

fn ang_diff(a: f32, b: f32) -> f32 {
    let mut d = (a - b).rem_euclid(360.0);
    if d > 180.0 {
        d = 360.0 - d;
    }
    d
}

const GRENADE_ITEMS: [&str; 6] = ["smokegrenade", "flashbang", "hegrenade", "molotov", "incgrenade", "decoy"];

fn primary_value(w: &str) -> i32 {
    match w {
        "awp" => 4750,
        "ak47" => 2700,
        "m4a1" => 2900,
        "m4a1_silencer" => 2900,
        "aug" => 3300,
        "sg556" => 3000,
        "famas" => 2050,
        "galilar" => 1800,
        "ssg08" => 1700,
        "g3sg1" | "scar20" => 5000,
        "m249" => 5200,
        "negev" => 1700,
        _ => 0,
    }
}

pub fn kill_insights(ctx: &Ctx<'_>, b: &mut Builder) {
    let data = ctx.data;
    for (di, k) in data.kills.iter().enumerate() {
        let r = ctx.round(k.round);
        let after_end = k.tick > r.end_tick;
        let victim_place = place_of_kill_victim(ctx, k, di);
        let vname = ctx.name(k.victim).to_string();
        let wname = text::weapon(&k.weapon);
        let death = ctx.extra.deaths.get(di).cloned().unwrap_or_default();

        // ---- team kill
        if let Some(a) = k.attacker {
            if ctx.same_team(k.round, a, k.victim) {
                b.push(New {
                    round: k.round,
                    tick: k.tick,
                    player: a,
                    kind: "team_kill",
                    category: "aim",
                    severity: "bad",
                    title: "Takım arkadaşını öldürdün".into(),
                    detail: format!("Takım arkadaşın {vname} senin {wname} atışınla öldü."),
                    delta: -15.0,
                    pos: k.attacker_pos,
                    grenade: None,
                    suggestion: None,
                });
                continue;
            }
        }
        let Some(att) = k.attacker else { continue };
        let aname = ctx.name(att).to_string();
        let att_side = ctx.side(k.round, att);
        let vic_side = ctx.side(k.round, k.victim);

        // ---- opening duel
        if k.is_opening {
            b.push(New {
                round: k.round,
                tick: k.tick,
                player: att,
                kind: "opening_kill",
                category: "entry",
                severity: "good",
                title: "Açılış öldürmesi".into(),
                detail: format!(
                    "Raundun ilk öldürmesini yaptın: rakip {vname}, {} {wname} ile indirildi ve takımına sayı üstünlüğü kazandırdın.",
                    victim_place.as_deref().map(|p| format!("{p} civarında")).unwrap_or_else(|| "".into())
                )
                .replace(",  ", ", "),
                delta: 6.0,
                pos: k.attacker_pos,
                grenade: None,
                suggestion: None,
            });
            let traded = k.victim_traded;
            b.push(New {
                round: k.round,
                tick: k.tick,
                player: k.victim,
                kind: "opening_death",
                category: "entry",
                severity: if traded { "info" } else { "bad" },
                title: if traded { "İlk ölen sendin (takas edildin)".into() } else { "Raundun ilk ölümü".into() },
                detail: format!(
                    "Rakip {aname} seni {}{wname} ile öldürdü; takımın raunda bir kişi eksik devam etti.{}",
                    victim_place.as_deref().map(|p| format!("{p} civarında ")).unwrap_or_default(),
                    if traded { " Takım arkadaşın seni hemen takas etti, bu yüzden zarar sınırlı kaldı." } else { " Takas da edilmedin." }
                ),
                delta: if traded { -2.0 } else { -6.0 },
                pos: Some(k.victim_pos),
                grenade: None,
                suggestion: None,
            });
        }

        // ---- trade kill
        if k.is_trade {
            // find the teammate that died
            let mate = data
                .kills
                .iter()
                .rev()
                .filter(|k0| k0.round == k.round && k0.tick <= k.tick && k.tick - k0.tick <= TRADE_TICKS && k0.attacker == Some(k.victim) && ctx.side(k.round, k0.victim) == att_side)
                .next();
            if let Some(m) = mate {
                let secs = (k.tick - m.tick) as f32 / TICK_RATE;
                b.push(New {
                    round: k.round,
                    tick: k.tick,
                    player: att,
                    kind: "trade_kill",
                    category: "trade",
                    severity: "good",
                    title: "Takas öldürmesi".into(),
                    detail: format!(
                        "Takım arkadaşın {} öldükten {} sn sonra katili {vname} oyuncusunu indirdin.",
                        ctx.name(m.victim),
                        text::secs(secs)
                    ),
                    delta: 4.0,
                    pos: k.attacker_pos,
                    grenade: None,
                    suggestion: None,
                });
            }
        }

        // ---- flash assist
        if k.flash_assist {
            if let Some(s) = k.assister {
                if !ctx.same_team(k.round, s, k.victim) {
                    b.push(New {
                        round: k.round,
                        tick: k.tick,
                        player: s,
                        kind: "flash_assist",
                        category: "utility",
                        severity: "good",
                        title: "Flaş asisti".into(),
                        detail: format!("Attığın flaş {vname} oyuncusunu kör etti ve {aname} onu öldürdü."),
                        delta: 4.0,
                        pos: ctx.pos_at(s, k.tick),
                        grenade: None,
                        suggestion: None,
                    });
                }
            }
        }

        // ---- eco frag: low equipment killer vs well equipped victim
        let ri = k.round as usize - 1;
        let a_equip = ctx.rp[ri][att].equip;
        let v_equip = ctx.rp[ri][k.victim].equip;
        if a_equip > 0 && a_equip <= 1500 && v_equip >= 3700 && !after_end {
            b.push(New {
                round: k.round,
                tick: k.tick,
                player: att,
                kind: "eco_frag",
                category: "economy",
                severity: "good",
                title: "Ekonomik dezavantajla öldürme".into(),
                detail: format!("Sadece ${a_equip} değerinde ekipmanla ${v_equip} ekipmanlı {vname} oyuncusunu {wname} ile indirdin."),
                delta: 5.0,
                pos: k.attacker_pos,
                grenade: None,
                suggestion: None,
            });
        }

        // ================= death-side insights (victim) =================
        if after_end {
            continue;
        }
        let victim = k.victim;
        let vside = match vic_side {
            Some(s) => s,
            None => continue,
        };
        let mates_alive: Vec<usize> = ctx.alive_of_side(k.round, vside, k.tick).into_iter().filter(|s| *s != victim).collect();
        let enemies_alive = ctx.alive_of_side(k.round, vside.other(), k.tick);
        let is_grenade_kill = !is_firearm(&k.weapon) && k.weapon != "knife";

        // multiple enemies: damaged by >=2 different enemies within 2 s before death
        let recent_attackers: std::collections::BTreeSet<usize> = data
            .damages
            .iter()
            .filter(|d| d.victim == victim && d.round == k.round && d.tick <= k.tick && k.tick - d.tick <= 128)
            .filter_map(|d| d.attacker)
            .filter(|a| !ctx.same_team(k.round, *a, victim))
            .collect();
        let mut death_reported = false;
        if recent_attackers.len() >= 2 && !is_grenade_kill {
            let names: Vec<String> = recent_attackers.iter().map(|s| ctx.name(*s).to_string()).collect();
            b.push(New {
                round: k.round,
                tick: k.tick,
                player: victim,
                kind: "multiple_enemies",
                category: "positioning",
                severity: "bad",
                title: "Aynı anda birden fazla rakibe göründün".into(),
                detail: format!(
                    "Ölmeden önceki 2 sn içinde {} rakipten hasar aldın ({}). Tek seferde birden fazla açıya çıkmak düelloyu kaybettirir; açıları tek tek almaya çalış.",
                    recent_attackers.len(),
                    names.join(", ")
                ),
                delta: -3.0,
                pos: Some(k.victim_pos),
                grenade: None,
                suggestion: None,
            });
            death_reported = true;
        }

        // killed from behind
        {
            if let (Some(ap), Some(vyaw)) = (k.attacker_pos, death.victim_yaw.or_else(|| ctx.fs.sample(victim, k.tick - 4).map(|s| s.yaw))) {
                let to_att = yaw_to(k.victim_pos, ap);
                let diff = ang_diff(vyaw, to_att);
                if diff > 120.0 && dist2(ap, k.victim_pos) > 120.0 && !is_grenade_kill && !death_reported {
                    b.push(New {
                        round: k.round,
                        tick: k.tick,
                        player: victim,
                        kind: "killed_from_behind",
                        category: "positioning",
                        severity: "bad",
                        title: "Arkandan vuruldun".into(),
                        detail: format!(
                            "Rakip {aname} seni arkandan ({:.0}° açıyla) öldürdü{}. Arkanı kontrol eden bir takım arkadaşın yoktu ya da rakibin rotasyonunu kaçırdın.",
                            diff,
                            victim_place.as_deref().map(|p| format!(", konum: {p}")).unwrap_or_default()
                        ),
                        delta: -3.0,
                        pos: Some(k.victim_pos),
                        grenade: None,
                        suggestion: None,
                    });
                    death_reported = true;
                }
            }
        }

        // died reloading: weapon_reload within 2.5 s and no shot since
        let reload = ctx.extra.reloads.iter().rev().find(|(t, s)| *s == victim && *t <= k.tick && k.tick - *t <= 160);
        if let Some((rt, _)) = reload {
            let shot_since = data.shots.iter().any(|s| s.player == victim && s.tick > *rt && s.tick <= k.tick);
            if !shot_since && !is_grenade_kill {
                b.push(New {
                    round: k.round,
                    tick: k.tick,
                    player: victim,
                    kind: "died_reloading",
                    category: "aim",
                    severity: "bad",
                    title: "Şarjör değiştirirken öldün".into(),
                    detail: format!(
                        "Ölmeden {} sn önce şarjör değiştirmeye başlamıştın. Şarjörü güvenli bir yerde ya da takım arkadaşının arkasında değiştir.",
                        text::secs((k.tick - rt) as f32 / TICK_RATE)
                    ),
                    delta: -3.0,
                    pos: Some(k.victim_pos),
                    grenade: None,
                    suggestion: None,
                });
                death_reported = true;
            }
        }

        // died blind (enemy flash)
        let blind = data
            .blinds
            .iter()
            .filter(|bl| bl.victim == victim && bl.tick <= k.tick && (bl.tick as f32 + bl.duration * TICK_RATE) > k.tick as f32 + 0.4 * TICK_RATE)
            .max_by_key(|bl| bl.tick);
        if let Some(bl) = blind {
            let rem = bl.duration - (k.tick - bl.tick) as f32 / TICK_RATE;
            if bl.team_flash && bl.attacker != victim {
                b.push(New {
                    round: k.round,
                    tick: k.tick,
                    player: bl.attacker,
                    kind: "team_flash_death",
                    category: "utility",
                    severity: "bad",
                    title: "Flaşın takım arkadaşının ölümüne yol açtı".into(),
                    detail: format!("Attığın flaş {vname} oyuncusunu kör etti ve kör haldeyken öldü."),
                    delta: -5.0,
                    pos: Some(k.victim_pos),
                    grenade: bl.grenade_id,
                    suggestion: None,
                });
            } else if !bl.team_flash && rem > 0.4 {
                b.push(New {
                    round: k.round,
                    tick: k.tick,
                    player: victim,
                    kind: "died_blind",
                    category: "positioning",
                    severity: "bad",
                    title: "Kör haldeyken öldün".into(),
                    detail: format!(
                        "Rakip {} tarafından atılan flaşla kör olmuşken ({} sn körlük kalmıştı) öldürüldün. Flaşın sesini duyduğunda arkanı dön ya da siper al.",
                        ctx.name(bl.attacker),
                        text::secs(rem)
                    ),
                    delta: -2.0,
                    pos: Some(k.victim_pos),
                    grenade: bl.grenade_id,
                    suggestion: None,
                });
                death_reported = true;
            }
        }

        // untraded / isolated death (only when teammates were alive to trade)
        if !k.victim_traded && !mates_alive.is_empty() && !death_reported {
            let nearest = mates_alive
                .iter()
                .filter_map(|m| ctx.pos_at(*m, k.tick).map(|p| (dist3(p, k.victim_pos), *m)))
                .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            match nearest {
                Some((d, m)) if d > 1300.0 => {
                    b.push(New {
                        round: k.round,
                        tick: k.tick,
                        player: victim,
                        kind: "died_isolated",
                        category: "positioning",
                        severity: "bad",
                        title: "Takımından kopuk öldün".into(),
                        detail: format!(
                            "Öldüğünde{} en yakın takım arkadaşın ({}) {:.0} birim uzaktaydı; takas edilmen mümkün değildi. Yalnız bir açı tutuyorsan bilgi verip geri çekil.",
                            victim_place.as_deref().map(|p| format!(" ({p} civarı)")).unwrap_or_default(),
                            ctx.name(m),
                            d
                        ),
                        delta: -4.0,
                        pos: Some(k.victim_pos),
                        grenade: None,
                        suggestion: None,
                    });
                }
                Some(_) => {
                    if !k.is_opening && mates_alive.len() >= 2 {
                        b.push(New {
                            round: k.round,
                            tick: k.tick,
                            player: victim,
                            kind: "untraded_death",
                            category: "trade",
                            severity: "bad",
                            title: "Takas edilmeyen ölüm".into(),
                            detail: format!(
                                "Rakip {aname} seni öldürdükten sonra 5 sn içinde takas edilmedin, oysa {} takım arkadaşın hayattaydı. Takım arkadaşlarınla daha yakın oyna ya da onlara takas imkânı ver.",
                                mates_alive.len()
                            ),
                            delta: -3.0,
                            pos: Some(k.victim_pos),
                            grenade: None,
                            suggestion: None,
                        });
                    }
                }
                None => {}
            }
        }

        // died with unused utility (late in a lost round)
        let nades: Vec<&String> = death.victim_inventory.iter().filter(|w| GRENADE_ITEMS.contains(&w.as_str()) && w.as_str() != "decoy").collect();
        let alive_secs = (k.tick - r.freeze_end_tick) as f32 / TICK_RATE;
        if nades.len() >= 2 && alive_secs > 25.0 && ctx.team_won(k.round, victim) == Some(false) {
            let list: Vec<String> = nades.iter().map(|w| text::weapon(w)).collect();
            b.push(New {
                round: k.round,
                tick: k.tick,
                player: victim,
                kind: "died_with_utility",
                category: "utility",
                severity: "bad",
                title: "Kullanılmamış el bombalarıyla öldün".into(),
                detail: format!(
                    "{} sn hayatta kaldığın kaybedilen bir raundda {} el bombası ({}) kullanılmadan seninle birlikte gitti.",
                    alive_secs.round() as i64,
                    nades.len(),
                    list.join(", ")
                ),
                delta: -2.0,
                pos: Some(k.victim_pos),
                grenade: None,
                suggestion: None,
            });
        }

        // died with an expensive weapon when a save was the better call
        let weapon_value = primary_value(&death.victim_weapon).max(death.victim_inventory.iter().map(|w| primary_value(w)).max().unwrap_or(0));
        let my_alive = mates_alive.len() + 1;
        if weapon_value >= 2700
            && ctx.team_won(k.round, victim) == Some(false)
            && enemies_alive.len() >= my_alive + 2
            && alive_secs > 20.0
        {
            b.push(New {
                round: k.round,
                tick: k.tick,
                player: victim,
                kind: "died_expensive",
                category: "economy",
                severity: "bad",
                title: "Kurtarılabilecek silahla öldün".into(),
                detail: format!(
                    "Sayıca {}'e {} geride olduğunuz ve kaybedilen bir raundda {} ile öldün. Bu durumda silahı kurtarmak (save) bir sonraki raundun ekonomisi için daha değerliydi.",
                    my_alive,
                    enemies_alive.len(),
                    if primary_value(&death.victim_weapon) > 0 { text::weapon(&death.victim_weapon) } else { "pahalı bir silah".to_string() }
                ),
                delta: -3.0,
                pos: Some(k.victim_pos),
                grenade: None,
                suggestion: None,
            });
        }
    }
}

pub fn round_insights(ctx: &Ctx<'_>, b: &mut Builder) {
    let data = ctx.data;
    for r in &data.rounds {
        let ri = r.number as usize - 1;
        // multi kills (3+)
        for (slot, p) in ctx.rp[ri].iter().enumerate() {
            if p.kills >= 3 {
                let last = data.kills.iter().filter(|k| k.round == r.number && k.attacker == Some(slot)).last();
                b.push(New {
                    round: r.number,
                    tick: last.map(|k| k.tick).unwrap_or(r.end_tick),
                    player: slot,
                    kind: "multi_kill",
                    category: "aim",
                    severity: "good",
                    title: match p.kills {
                        3 => "Üçlü öldürme (3K)".into(),
                        4 => "Dörtlü öldürme (4K)".into(),
                        _ => "ACE! (5K)".into(),
                    },
                    detail: format!("Bu raundda {} rakip indirdin ve {} hasar verdin.", p.kills, p.damage),
                    delta: p.kills as f32 * 4.0,
                    pos: last.and_then(|k| k.attacker_pos),
                    grenade: None,
                    suggestion: None,
                });
            }
        }
        // clutches
        for c in ctx.clutches.iter().filter(|c| c.round == r.number) {
            if c.won {
                b.push(New {
                    round: r.number,
                    tick: c.tick,
                    player: c.slot,
                    kind: "clutch_won",
                    category: "clutch",
                    severity: "good",
                    title: format!("1v{} clutch kazanıldı", c.vs),
                    detail: format!(
                        "Takımından tek başına kaldığında {} rakip hayattaydı; raundu kazandın{}.",
                        c.vs,
                        if c.kills_after > 0 { format!(" ({} öldürme)", c.kills_after) } else { String::new() }
                    ),
                    delta: 10.0 + 8.0 * c.vs as f32,
                    pos: ctx.pos_at(c.slot, c.tick),
                    grenade: None,
                    suggestion: None,
                });
            } else if c.vs <= 2 {
                b.push(New {
                    round: r.number,
                    tick: c.tick,
                    player: c.slot,
                    kind: "clutch_lost",
                    category: "clutch",
                    severity: if c.vs == 1 { "bad" } else { "info" },
                    title: format!("1v{} clutch kaybedildi", c.vs),
                    detail: format!(
                        "Takımından tek başına kaldın ve {} rakibe karşı raundu kaybettin{}.",
                        c.vs,
                        if c.kills_after > 0 { format!(" ({} öldürme aldın)", c.kills_after) } else { String::new() }
                    ),
                    delta: if c.vs == 1 { -4.0 } else { 0.0 },
                    pos: ctx.pos_at(c.slot, c.tick),
                    grenade: None,
                    suggestion: None,
                });
            }
        }
        // bomb plant / defuse
        for be in data.bomb_events.iter().filter(|e| e.round == r.number) {
            let Some(p) = be.player else { continue };
            match be.kind.as_str() {
                "planted" => b.push(New {
                    round: r.number,
                    tick: be.tick,
                    player: p,
                    kind: "bomb_plant",
                    category: "objective",
                    severity: "good",
                    title: format!("Bombayı kurdun{}", be.site.as_deref().map(|s| format!(" ({s})")).unwrap_or_default()),
                    detail: format!(
                        "Bomba {} kuruldu; {} T oyuncusu hayattaydı.",
                        be.site.as_deref().map(|s| format!("{s} bölgesine")).unwrap_or_else(|| "bölgeye".into()),
                        ctx.alive_of_side(r.number, Side::T, be.tick).len()
                    ),
                    delta: 5.0,
                    pos: be.pos,
                    grenade: None,
                    suggestion: None,
                }),
                "defused" => b.push(New {
                    round: r.number,
                    tick: be.tick,
                    player: p,
                    kind: "bomb_defuse",
                    category: "objective",
                    severity: "good",
                    title: "Bombayı imha ettin".into(),
                    detail: format!(
                        "Bombayı {}imha ederek raundu kazandırdın.",
                        be.site.as_deref().map(|s| format!("{s} bölgesinde ")).unwrap_or_default()
                    ),
                    delta: 10.0,
                    pos: be.pos,
                    grenade: None,
                    suggestion: None,
                }),
                _ => {}
            }
        }
        // saved weapon in a lost round
        if let Some(w) = r.winner {
            for (slot, p) in ctx.rp[ri].iter().enumerate() {
                let Some(side) = p.side else { continue };
                if side == w || p.death_tick.is_some() || !p.alive_at_start {
                    continue;
                }
                let weapon = ctx
                    .fs
                    .sample(slot, r.end_tick)
                    .and_then(|s| if s.weapon >= 0 { ctx.fs.weapons.get(s.weapon as usize).cloned() } else { None })
                    .unwrap_or_default();
                if p.equip >= 3500 {
                    b.push(New {
                        round: r.number,
                        tick: r.end_tick,
                        player: slot,
                        kind: "saved_weapon",
                        category: "economy",
                        severity: "info",
                        title: "Kaybedilen raundda silahını kurtardın".into(),
                        detail: format!(
                            "Raund kaybedildiğinde hayattaydın ve ${} değerindeki ekipmanını{} bir sonraki rauna taşıdın.",
                            p.equip,
                            if weapon.is_empty() { String::new() } else { format!(" ({})", text::weapon(&weapon)) }
                        ),
                        delta: 2.0,
                        pos: ctx.pos_at(slot, r.end_tick),
                        grenade: None,
                        suggestion: None,
                    });
                }
            }
        }
    }
}

pub fn round_summary(ctx: &Ctx<'_>, r: &RoundInfo, mvp: Option<usize>, lines: &[RoundPlayerLine]) -> String {
    let data = ctx.data;
    let team_name = |t: usize| data.players.iter().find(|p| p.team as usize == t).map(|p| p.team_name.clone()).unwrap_or_else(|| format!("Takım {}", t + 1));
    let mut parts: Vec<String> = vec![];
    match r.winner {
        Some(w) => {
            let wt = if r.team_sides[0] == w { 0 } else { 1 };
            parts.push(format!("{} ({}) kazandı: {}.", team_name(wt), text::side(w), text::round_reason(&r.end_reason)));
        }
        None => parts.push("Raundun sonucu belirsiz.".into()),
    }
    let buy = |t: usize| match r.buy_types[t].as_str() {
        "pistol" => "tabanca raundu",
        "eco" => "eko",
        "force" => "zorunlu alım",
        _ => "tam alım",
    };
    if r.buy_types[0] == "pistol" && r.buy_types[1] == "pistol" {
        parts.push("Tabanca raundu.".into());
    } else {
        parts.push(format!("Ekonomi: {} {} – {} {}.", team_name(0), buy(0), team_name(1), buy(1)));
    }
    if let Some(open) = data.kills.iter().find(|k| k.round == r.number && k.is_opening) {
        if let Some(a) = open.attacker {
            parts.push(format!("Açılış: {} → {} ({}).", ctx.name(a), ctx.name(open.victim), text::weapon(&open.weapon)));
        }
    }
    if let Some(site) = &r.bomb_site {
        if r.bomb_planted_tick.is_some() {
            parts.push(format!("Bomba {site} bölgesine kuruldu."));
        }
    }
    for c in ctx.clutches.iter().filter(|c| c.round == r.number && c.won) {
        parts.push(format!("{} 1v{} clutch kazandı.", ctx.name(c.slot), c.vs));
    }
    if let Some(m) = mvp {
        if let Some(l) = lines.iter().find(|l| l.slot == m) {
            parts.push(format!("MVP: {} ({} öldürme, {} hasar).", ctx.name(m), l.kills, l.damage));
        }
    }
    parts.join(" ")
}
