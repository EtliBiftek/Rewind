//! Heuristic analysis engine (deterministic, offline, no AI).
//!
//! Pipeline: kill flags (opening / trade) -> per-round context (alive sets, clutches) ->
//! per-player stats + HLTV-2.0-style rating -> insights (Turkish) -> utility evaluation with
//! lineup suggestions -> per-round lines, MVP and summary -> 0..100 scores.

mod insights;
pub mod text;
mod utility;

use crate::demo::{Extra, TICK_RATE};
use crate::frames::{is_firearm, FrameStore};
use crate::lineups::{Lineup, LineupLibrary};
use crate::model::*;
use std::collections::BTreeMap;

pub const SUB_SCORE_KEYS: [&str; 8] = ["aim", "entry", "trade", "utility", "clutch", "survival", "economy", "positioning"];
/// Trade window: 5 seconds.
pub const TRADE_TICKS: i32 = (5.0 * TICK_RATE) as i32;

/// One player's involvement in one round (internal).
#[derive(Debug, Clone, Default)]
pub struct RoundPlayer {
    pub side: Option<Side>,
    pub alive_at_start: bool,
    pub death_tick: Option<i32>,
    pub kills: u32,
    pub assists: u32,
    pub flash_assists: u32,
    pub damage: i32,
    pub traded: bool,
    pub equip: i32,
    /// accumulated round score contributions
    pub score: f32,
}

/// A clutch situation: last alive player of a team vs `vs` enemies.
#[derive(Debug, Clone)]
pub struct Clutch {
    pub round: u32,
    pub slot: usize,
    pub vs: u32,
    pub tick: i32,
    pub won: bool,
    pub kills_after: u32,
}

pub struct Ctx<'a> {
    pub data: &'a DemoData,
    pub fs: &'a FrameStore,
    pub extra: &'a Extra,
    /// [round index][slot]
    pub rp: Vec<Vec<RoundPlayer>>,
    pub clutches: Vec<Clutch>,
}

impl<'a> Ctx<'a> {
    pub fn round_idx(&self, round: u32) -> usize {
        round as usize - 1
    }
    pub fn side(&self, round: u32, slot: usize) -> Option<Side> {
        self.extra.round_sides.get(round as usize - 1).and_then(|v| v.get(slot).copied().flatten())
    }
    pub fn same_team(&self, round: u32, a: usize, b: usize) -> bool {
        match (self.side(round, a), self.side(round, b)) {
            (Some(x), Some(y)) => x == y,
            _ => self.data.players[a].team == self.data.players[b].team,
        }
    }
    /// Is `slot` alive at `tick` in `round` (event based: alive at round start and not yet dead)?
    pub fn alive_at(&self, round: u32, slot: usize, tick: i32) -> bool {
        let p = &self.rp[round as usize - 1][slot];
        p.alive_at_start && p.death_tick.map(|d| d > tick).unwrap_or(true)
    }
    /// Alive players of a side at tick.
    pub fn alive_of_side(&self, round: u32, side: Side, tick: i32) -> Vec<usize> {
        (0..self.data.players.len())
            .filter(|&s| self.side(round, s) == Some(side) && self.alive_at(round, s, tick))
            .collect()
    }
    pub fn pos_at(&self, slot: usize, tick: i32) -> Option<Vec3> {
        self.fs.sample(slot, tick).filter(|s| s.present).map(|s| s.pos)
    }
    pub fn name(&self, slot: usize) -> &str {
        &self.data.players[slot].name
    }
    pub fn round(&self, round: u32) -> &RoundInfo {
        &self.data.rounds[round as usize - 1]
    }
    pub fn team_won(&self, round: u32, slot: usize) -> Option<bool> {
        let r = self.round(round);
        Some(r.winner? == self.side(round, slot)?)
    }
    pub fn place_at(&self, slot: usize, tick: i32) -> Option<String> {
        self.fs.sample(slot, tick).and_then(|s| self.fs.place_name(s.place)).map(|s| s.to_string())
    }
}

pub fn dist3(a: Vec3, b: Vec3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}
pub fn dist2(a: Vec3, b: Vec3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn derive_kill_flags(data: &mut DemoData, sides: &[Vec<Option<Side>>]) {
    let side = |round: u32, slot: usize| sides.get(round as usize - 1).and_then(|v| v.get(slot).copied().flatten());
    let enemy_kill = |k: &KillEvent| match k.attacker {
        Some(a) => side(k.round, a).is_some() && side(k.round, a) != side(k.round, k.victim),
        None => false,
    };
    let n = data.kills.len();
    let mut first_seen: BTreeMap<u32, bool> = BTreeMap::new();
    let freeze: Vec<i32> = data.rounds.iter().map(|r| r.freeze_end_tick).collect();
    for i in 0..n {
        let k = &data.kills[i];
        let r = k.round;
        if enemy_kill(k) && k.tick >= freeze[r as usize - 1] && !first_seen.contains_key(&r) {
            first_seen.insert(r, true);
            data.kills[i].is_opening = true;
        }
    }
    for i in 0..n {
        let (tick, round, attacker, victim) = (data.kills[i].tick, data.kills[i].round, data.kills[i].attacker, data.kills[i].victim);
        if !enemy_kill(&data.kills[i]) {
            continue;
        }
        let a = attacker.unwrap();
        // is_trade: the victim had killed a teammate of the attacker within the window
        let mut is_trade = false;
        for j in (0..i).rev() {
            let k0 = &data.kills[j];
            if k0.round != round || tick - k0.tick > TRADE_TICKS {
                break;
            }
            if k0.attacker == Some(victim) && enemy_kill(k0) && side(round, k0.victim) == side(round, a) && k0.victim != a {
                is_trade = true;
                data.kills[j].victim_traded = true;
            }
        }
        data.kills[i].is_trade = is_trade;
    }
}

fn build_round_players(data: &DemoData, fs: &FrameStore, extra: &Extra) -> Vec<Vec<RoundPlayer>> {
    let np = data.players.len();
    let mut out = vec![];
    for (ri, r) in data.rounds.iter().enumerate() {
        let mut v = vec![RoundPlayer::default(); np];
        for (slot, rp) in v.iter_mut().enumerate() {
            rp.side = extra.round_sides[ri][slot];
            if rp.side.is_some() {
                // alive at round start = alive shortly after freeze end
                let alive = [r.freeze_end_tick + 8, r.freeze_end_tick + 64]
                    .iter()
                    .any(|t| fs.sample(slot, *t).map(|s| s.alive()).unwrap_or(false));
                rp.alive_at_start = alive;
                rp.equip = fs.sample(slot, r.freeze_end_tick + 8).map(|s| s.equip).unwrap_or(0);
            }
        }
        out.push(v);
    }
    for k in &data.kills {
        let ri = k.round as usize - 1;
        let v = &mut out[ri][k.victim];
        if v.death_tick.is_none() {
            v.death_tick = Some(k.tick);
            // someone that died must have been alive (late spawn etc.)
            v.alive_at_start = true;
        }
    }
    out
}

fn detect_clutches(ctx: &Ctx<'_>) -> Vec<Clutch> {
    let mut res = vec![];
    for r in &ctx.data.rounds {
        let ri = r.number as usize - 1;
        let mut deaths: Vec<(i32, usize)> = ctx.rp[ri].iter().enumerate().filter_map(|(s, p)| p.death_tick.map(|t| (t, s))).collect();
        deaths.sort();
        let mut done = [false, false];
        for (tick, _) in &deaths {
            if *tick > r.end_tick {
                break;
            }
            for (si, side) in [Side::T, Side::CT].into_iter().enumerate() {
                if done[si] {
                    continue;
                }
                let mine = ctx.alive_of_side(r.number, side, *tick);
                let theirs = ctx.alive_of_side(r.number, side.other(), *tick);
                if mine.len() == 1 && !theirs.is_empty() {
                    done[si] = true;
                    let slot = mine[0];
                    let won = r.winner == Some(side);
                    let kills_after = ctx
                        .data
                        .kills
                        .iter()
                        .filter(|k| k.round == r.number && k.attacker == Some(slot) && k.tick >= *tick && ctx.side(r.number, k.victim) != Some(side))
                        .count() as u32;
                    res.push(Clutch { round: r.number, slot, vs: theirs.len() as u32, tick: *tick, won, kills_after });
                }
            }
        }
    }
    res
}

fn norm(x: f32, lo: f32, hi: f32) -> f32 {
    ((x - lo) / (hi - lo)).clamp(0.0, 1.0) * 100.0
}

/// Runs the full analysis. Returns the data with `analysis` filled and kill flags derived,
/// plus the successful grenades of this demo (for the persistent lineup library).
pub fn analyze(mut data: DemoData, fs: &FrameStore, extra: &Extra, lib: &LineupLibrary) -> (DemoData, Vec<Lineup>) {
    derive_kill_flags(&mut data, &extra.round_sides);
    let np = data.players.len();
    let rp = build_round_players(&data, fs, extra);
    let mut ctx = Ctx { data: &data, fs, extra, rp, clutches: vec![] };
    ctx.clutches = detect_clutches(&ctx);

    // ---------------- per-round accumulations ----------------
    for k in &data.kills {
        let ri = k.round as usize - 1;
        if let Some(a) = k.attacker {
            if !ctx.same_team(k.round, a, k.victim) {
                ctx.rp[ri][a].kills += 1;
            }
        }
        if let Some(s) = k.assister {
            if !ctx.same_team(k.round, s, k.victim) {
                if k.flash_assist {
                    ctx.rp[ri][s].flash_assists += 1;
                } else {
                    ctx.rp[ri][s].assists += 1;
                }
            }
        }
        if k.victim_traded {
            ctx.rp[ri][k.victim].traded = true;
        }
    }
    for d in &data.damages {
        if let Some(a) = d.attacker {
            if !ctx.same_team(d.round, a, d.victim) {
                ctx.rp[d.round as usize - 1][a].damage += d.hp_damage;
            }
        }
    }

    // ---------------- insights + utility ----------------
    let mut ins = insights::Builder::new();
    insights::kill_insights(&ctx, &mut ins);
    let learned = utility::analyze_utility(&ctx, lib, &mut ins);
    insights::round_insights(&ctx, &mut ins);

    // ---------------- per-round score & lines ----------------
    let mut round_scores: Vec<Vec<f32>> = vec![vec![0.0; np]; data.rounds.len()];
    for r in &data.rounds {
        let ri = r.number as usize - 1;
        for slot in 0..np {
            let p = &ctx.rp[ri][slot];
            if p.side.is_none() {
                continue;
            }
            let mut s = 0.0f32;
            s += p.kills as f32 * 18.0;
            s += p.assists as f32 * 6.0 + p.flash_assists as f32 * 5.0;
            s += p.damage as f32 * 0.1;
            if p.death_tick.map(|t| t <= r.end_tick).unwrap_or(false) {
                s -= 14.0;
                if p.traded {
                    s += 6.0;
                }
            } else if p.alive_at_start && ctx.team_won(r.number, slot) == Some(true) {
                s += 4.0;
            }
            round_scores[ri][slot] = s;
        }
    }
    // insight contributions (only the parts not already represented by kills/deaths/damage)
    for i in &ins.items {
        let ri = i.round as usize - 1;
        if ri < round_scores.len() && insights::adds_to_round_score(&i.kind) {
            round_scores[ri][i.player] += i.score_delta;
        }
    }
    let mut rounds_an: Vec<RoundAnalysis> = vec![];
    let mut mvp_count = vec![0u32; np];
    for r in &data.rounds {
        let ri = r.number as usize - 1;
        let mut lines = vec![];
        for slot in 0..np {
            let p = &ctx.rp[ri][slot];
            let Some(side) = p.side else { continue };
            let score = round_scores[ri][slot].clamp(-100.0, 100.0);
            let died = p.death_tick.is_some();
            lines.push(RoundPlayerLine {
                slot,
                side,
                score: (score * 10.0).round() / 10.0,
                kills: p.kills,
                died,
                damage: p.damage,
                survived: !died && p.alive_at_start,
                equip_value: p.equip,
                verdict: if score >= 15.0 {
                    "good".into()
                } else if score <= -10.0 {
                    "bad".into()
                } else {
                    "neutral".into()
                },
            });
        }
        let mvp = lines
            .iter()
            .filter(|l| r.winner.map(|w| w == l.side).unwrap_or(true))
            .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal).then(b.slot.cmp(&a.slot)))
            .filter(|l| l.score > 0.0)
            .map(|l| l.slot);
        if let Some(m) = mvp {
            mvp_count[m] += 1;
        }
        let summary = insights::round_summary(&ctx, r, mvp, &lines);
        rounds_an.push(RoundAnalysis { round: r.number, players: lines, mvp, summary });
    }

    // ---------------- per-player stats ----------------
    let mut stats: Vec<PlayerStats> = vec![];
    for slot in 0..np {
        let mut s = PlayerStats { slot, ..Default::default() };
        for g in GrenadeType::ALL {
            s.grenades_thrown.insert(g.as_str().into(), 0);
        }
        let mut kast_rounds = 0u32;
        let mut alive_time = 0.0f32;
        let mut played = 0u32;
        let mut multi = [0u32; 6];
        for r in &data.rounds {
            let ri = r.number as usize - 1;
            let p = &ctx.rp[ri][slot];
            if p.side.is_none() {
                continue;
            }
            played += 1;
            s.kills += p.kills;
            s.assists += p.assists;
            s.flash_assists += p.flash_assists;
            s.damage += p.damage;
            let died = p.death_tick.is_some();
            if p.kills > 0 || p.assists > 0 || p.flash_assists > 0 || !died || p.traded {
                kast_rounds += 1;
            }
            multi[(p.kills as usize).min(5)] += 1;
            let end = p.death_tick.unwrap_or(r.end_tick).min(r.end_tick);
            alive_time += ((end - r.freeze_end_tick).max(0)) as f32 / TICK_RATE;
        }
        s.rounds_played = played;
        let rp_f = played.max(1) as f32;
        s.deaths = data.kills.iter().filter(|k| k.victim == slot && ctx.rp[k.round as usize - 1][slot].side.is_some()).count() as u32;
        let hs = data.kills.iter().filter(|k| k.attacker == Some(slot) && k.headshot && !ctx.same_team(k.round, slot, k.victim)).count() as f32;
        s.hs_percent = if s.kills > 0 { hs / s.kills as f32 * 100.0 } else { 0.0 };
        s.adr = s.damage as f32 / rp_f;
        s.kast = kast_rounds as f32 / rp_f * 100.0;
        s.kpr = s.kills as f32 / rp_f;
        s.dpr = s.deaths as f32 / rp_f;
        s.opening_kills = data.kills.iter().filter(|k| k.is_opening && k.attacker == Some(slot)).count() as u32;
        s.opening_deaths = data.kills.iter().filter(|k| k.is_opening && k.victim == slot).count() as u32;
        s.trade_kills = data.kills.iter().filter(|k| k.is_trade && k.attacker == Some(slot)).count() as u32;
        let enemy_deaths: Vec<&KillEvent> = data.kills.iter().filter(|k| k.victim == slot && k.attacker.map(|a| !ctx.same_team(k.round, a, slot)).unwrap_or(false)).collect();
        s.traded_deaths = enemy_deaths.iter().filter(|k| k.victim_traded).count() as u32;
        s.untraded_deaths = enemy_deaths.len() as u32 - s.traded_deaths;
        s.multi_kills = MultiKills { k2: multi[2], k3: multi[3], k4: multi[4], k5: multi[5] };
        for c in ctx.clutches.iter().filter(|c| c.slot == slot) {
            if c.won {
                match c.vs {
                    1 => s.clutches_won.v1 += 1,
                    2 => s.clutches_won.v2 += 1,
                    3 => s.clutches_won.v3 += 1,
                    4 => s.clutches_won.v4 += 1,
                    _ => s.clutches_won.v5 += 1,
                }
            } else {
                s.clutches_lost += 1;
            }
        }
        for b in data.blinds.iter().filter(|b| b.attacker == slot) {
            if b.team_flash {
                if b.victim != slot && b.duration >= 0.75 {
                    s.teammates_flashed += 1;
                }
            } else if b.duration >= 0.75 {
                s.enemies_flashed += 1;
                s.enemy_blind_seconds += b.duration;
            }
        }
        s.enemy_blind_seconds = (s.enemy_blind_seconds * 10.0).round() / 10.0;
        s.utility_damage = data
            .damages
            .iter()
            .filter(|d| d.attacker == Some(slot) && matches!(d.weapon.as_str(), "hegrenade" | "inferno" | "molotov" | "incgrenade") && !ctx.same_team(d.round, slot, d.victim))
            .map(|d| d.hp_damage)
            .sum();
        for g in data.grenades.iter().filter(|g| g.thrower == slot) {
            *s.grenades_thrown.entry(g.kind.as_str().into()).or_default() += 1;
        }
        // accuracy: firearm shots that dealt damage (damage attributed to the latest shot <= 2 ticks before)
        let my_shots: Vec<&ShotEvent> = data.shots.iter().filter(|x| x.player == slot && is_firearm(&x.weapon)).collect();
        let mut hit = vec![false; my_shots.len()];
        for d in data.damages.iter().filter(|d| d.attacker == Some(slot) && is_firearm(&d.weapon)) {
            let idx = my_shots.partition_point(|x| x.tick <= d.tick);
            if idx > 0 && d.tick - my_shots[idx - 1].tick <= 2 {
                hit[idx - 1] = true;
            }
        }
        s.accuracy = if my_shots.is_empty() { 0.0 } else { hit.iter().filter(|h| **h).count() as f32 / my_shots.len() as f32 * 100.0 };
        s.avg_time_alive = alive_time / rp_f;
        s.mvp_rounds = mvp_count[slot];
        // HLTV 2.0 approximation
        let apr = (s.assists + s.flash_assists) as f32 / rp_f;
        s.impact = 2.13 * s.kpr + 0.42 * apr - 0.41;
        s.rating = 0.0073 * s.kast + 0.3591 * s.kpr - 0.5329 * s.dpr + 0.2372 * s.impact + 0.0032 * s.adr + 0.1587;
        s.rating = s.rating.max(0.0);
        if played == 0 {
            s.rating = 0.0;
            s.impact = 0.0;
        }
        stats.push(s);
    }

    // ---------------- sub-scores & overall score ----------------
    let ins_count = |slot: usize, kinds: &[&str]| ins.items.iter().filter(|i| i.player == slot && kinds.contains(&i.kind.as_str())).count() as f32;
    for s in stats.iter_mut() {
        let slot = s.slot;
        let rp_f = s.rounds_played.max(1) as f32;
        let mut sub: BTreeMap<String, f32> = BTreeMap::new();
        let aim = 0.40 * norm(s.adr, 40.0, 110.0) + 0.25 * norm(s.hs_percent, 15.0, 65.0) + 0.20 * norm(s.accuracy, 10.0, 35.0) + 0.15 * norm(s.kpr, 0.35, 1.0);
        let duels = (s.opening_kills + s.opening_deaths) as f32;
        let entry_success = (s.opening_kills as f32 + 1.0) / (duels + 2.0);
        let entry = 0.75 * norm(entry_success, 0.25, 0.75) + 0.25 * norm(duels / rp_f, 0.0, 0.3);
        let deaths_vs_enemy = (s.traded_deaths + s.untraded_deaths).max(1) as f32;
        let trade = 0.5 * norm(s.trade_kills as f32 / rp_f, 0.0, 0.2) + 0.5 * norm(s.traded_deaths as f32 / deaths_vs_enemy, 0.0, 0.45);
        let bad_util = ins_count(slot, &["team_flash", "wasted_flash", "wasted_he", "wasted_molotov", "bad_smoke", "died_with_utility"]);
        let thrown: u32 = s.grenades_thrown.values().sum();
        let utility = (0.35 * norm(s.enemies_flashed as f32 / rp_f, 0.0, 1.2)
            + 0.25 * norm(s.utility_damage as f32 / rp_f, 0.0, 12.0)
            + 0.2 * norm(s.flash_assists as f32 / rp_f, 0.0, 0.12)
            + 0.2 * norm(1.0 - bad_util / (thrown.max(1) as f32 + 2.0), 0.4, 1.0))
            .clamp(0.0, 100.0);
        let attempts = ctx.clutches.iter().filter(|c| c.slot == slot).collect::<Vec<_>>();
        let clutch = if attempts.is_empty() {
            50.0
        } else {
            let expect: f32 = attempts.iter().map(|c| [0.0, 0.5, 0.2, 0.08, 0.03, 0.01][(c.vs as usize).min(5)]).sum();
            let won = attempts.iter().filter(|c| c.won).count() as f32;
            let kills: f32 = attempts.iter().map(|c| c.kills_after as f32).sum();
            (50.0 + (won - expect) * 30.0 + kills * 3.0).clamp(0.0, 100.0)
        };
        let survival = 0.6 * norm(1.0 - s.dpr, 0.15, 0.6) + 0.4 * norm(s.avg_time_alive, 35.0, 80.0);
        let spent: i32 = ctx.rp.iter().map(|r| r[slot].equip).sum();
        let dmg_per_k = s.damage as f32 / ((spent as f32 / 1000.0).max(1.0));
        let econ_bad = ins_count(slot, &["died_expensive"]);
        let econ_good = ins_count(slot, &["eco_frag", "saved_weapon"]);
        let economy = (0.7 * norm(dmg_per_k, 10.0, 35.0) + 0.3 * norm((econ_good - econ_bad) / rp_f, -0.15, 0.15)).clamp(0.0, 100.0);
        let pos_bad = ins_count(slot, &["died_isolated", "killed_from_behind", "multiple_enemies", "untraded_death"]);
        let positioning = (0.6 * norm(1.0 - pos_bad / rp_f, 0.55, 1.0) + 0.4 * norm(s.kast, 55.0, 85.0)).clamp(0.0, 100.0);
        for (k, v) in [("aim", aim), ("entry", entry), ("trade", trade), ("utility", utility), ("clutch", clutch), ("survival", survival), ("economy", economy), ("positioning", positioning)] {
            sub.insert(k.into(), (v * 10.0).round() / 10.0);
        }
        let weights = [("aim", 0.24), ("entry", 0.12), ("trade", 0.12), ("utility", 0.14), ("clutch", 0.06), ("survival", 0.1), ("economy", 0.08), ("positioning", 0.14)];
        let subs: f32 = weights.iter().map(|(k, w)| sub[*k] * w).sum();
        let rating_score = norm(s.rating, 0.45, 1.55);
        s.score = if s.rounds_played == 0 { 0.0 } else { (0.5 * rating_score + 0.5 * subs).clamp(0.0, 100.0).round() };
        s.sub_scores = sub;
        // round floats for compact JSON
        for v in [&mut s.adr, &mut s.kast, &mut s.hs_percent, &mut s.accuracy, &mut s.avg_time_alive] {
            *v = (*v * 10.0).round() / 10.0;
        }
        for v in [&mut s.kpr, &mut s.dpr, &mut s.impact, &mut s.rating] {
            *v = (*v * 100.0).round() / 100.0;
        }
    }

    let insights = ins.finish();
    data.analysis = Analysis { players: stats, rounds: rounds_an, insights };
    (data, learned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::demo::Extra;
    use crate::frames::{FrameStore, Rules, Sample};
    use crate::model::frame_flag as fl;

    /// 2v2 synthetic round: slots 0,1 = team 0 (CT), slots 2,3 = team 1 (T).
    fn fixture(kills: Vec<(i32, usize, usize)>, winner: Side) -> (DemoData, FrameStore, Extra) {
        let players: Vec<PlayerInfo> = (0..4)
            .map(|i| PlayerInfo { slot: i, steam_id: format!("{}", 100 + i), name: format!("p{i}"), team: (i / 2) as u8, team_name: String::new(), is_bot: false })
            .collect();
        let round = RoundInfo {
            number: 1,
            start_tick: 0,
            freeze_end_tick: 64,
            end_tick: 6400,
            official_end_tick: 6600,
            winner: Some(winner),
            end_reason: "t_eliminated".into(),
            team_sides: [Side::CT, Side::T],
            score_before: [0, 0],
            buy_types: ["full".into(), "full".into()],
            equip_values: [9000, 9000],
            bomb_planted_tick: None,
            bomb_site: None,
        };
        let kills: Vec<KillEvent> = kills
            .into_iter()
            .map(|(tick, a, v)| KillEvent {
                tick,
                round: 1,
                attacker: Some(a),
                victim: v,
                assister: None,
                flash_assist: false,
                weapon: "ak47".into(),
                headshot: false,
                wallbang: false,
                through_smoke: false,
                no_scope: false,
                attacker_blind: false,
                attacker_pos: Some([0.0, 0.0, 0.0]),
                victim_pos: [100.0, 0.0, 0.0],
                distance: 100.0,
                is_opening: false,
                is_trade: false,
                victim_traded: false,
            })
            .collect();
        let frame_count = 1700;
        let alive = Sample { present: true, flags: fl::ALIVE | fl::CONNECTED, health: 100, equip: 4500, team: 3, ..Default::default() };
        let samples: Vec<Vec<Sample>> = (0..4)
            .map(|p| {
                (0..frame_count)
                    .map(|f| {
                        let tick = f as i32 * 4;
                        let dead = kills.iter().any(|k| k.victim == p && k.tick <= tick);
                        let mut s = alive;
                        s.team = if p < 2 { 3 } else { 2 };
                        s.pos = [p as f32 * 50.0, 0.0, 0.0];
                        if dead {
                            s.flags = fl::CONNECTED;
                            s.health = 0;
                        }
                        s
                    })
                    .collect()
            })
            .collect();
        let fs = FrameStore { start_tick: 0, interval: 4, frame_count, samples, rules: vec![Rules::default(); frame_count], places: vec![String::new()], weapons: vec![] };
        let deaths = kills.iter().map(|_| crate::demo::DeathCtx::default()).collect();
        let extra = Extra {
            deaths,
            reloads: vec![],
            purchases: vec![],
            final_score_from_game: None,
            round_sides: vec![vec![Some(Side::CT), Some(Side::CT), Some(Side::T), Some(Side::T)]],
        };
        let data = DemoData {
            header: DemoHeader { file_name: "t".into(), map_name: "de_mirage".into(), server_name: String::new(), source: "unknown".into(), tick_rate: 64.0, total_ticks: 6600, duration_seconds: 103.0 },
            map: crate::maps::map_info("de_mirage", [0.0; 3], [1.0; 3]),
            players,
            rounds: vec![round],
            kills,
            damages: vec![],
            shots: vec![],
            blinds: vec![],
            grenades: vec![],
            bomb_events: vec![],
            chat: vec![],
            frames: FramesMeta { start_tick: 0, sample_interval: 4, frame_count, player_count: 4, stride: 12, weapons: vec![] },
            voice: VoiceInfo { available: false, sample_rate: 24000, players: vec![] },
            analysis: Analysis::default(),
        };
        (data, fs, extra)
    }

    #[test]
    fn opening_trade_and_clutch() {
        // T p2 kills CT p0 (opening), CT p1 trades p2 within 2 s, then p1 kills p3: CT win.
        // After p0 dies p1 is last alive CT vs 2 Ts -> 1v2 clutch, won.
        let (data, fs, extra) = fixture(vec![(1000, 2, 0), (1100, 1, 2), (3000, 1, 3)], Side::CT);
        let (d, _) = analyze(data, &fs, &extra, &LineupLibrary::default());
        let k = &d.kills;
        assert!(k[0].is_opening && !k[1].is_opening);
        assert!(k[1].is_trade, "p1 avenged p0 within 5 s");
        assert!(k[0].victim_traded, "p0 was traded");
        assert!(!k[2].is_trade);
        let p1 = &d.analysis.players[1];
        assert_eq!(p1.kills, 2);
        assert_eq!(p1.trade_kills, 1);
        assert_eq!(p1.clutches_won.v2, 1, "1v2 clutch won");
        assert_eq!(p1.multi_kills.k2, 1);
        let p0 = &d.analysis.players[0];
        assert_eq!((p0.deaths, p0.opening_deaths, p0.traded_deaths, p0.untraded_deaths), (1, 1, 1, 0));
        assert_eq!(p0.kast, 100.0, "traded death counts for KAST");
        assert_eq!(d.analysis.players[2].opening_kills, 1);
        assert_eq!(d.analysis.rounds[0].mvp, Some(1));
        assert!(d.analysis.insights.iter().any(|i| i.kind == "clutch_won" && i.player == 1));
        assert!(d.analysis.insights.iter().any(|i| i.kind == "trade_kill" && i.player == 1));
        assert!(d.analysis.rounds[0].summary.contains("1v2"));
    }

    #[test]
    fn late_revenge_is_not_a_trade() {
        // p1 kills p2 7 s after p2 killed p0: outside the 5 s window
        let (data, fs, extra) = fixture(vec![(1000, 2, 0), (1000 + 7 * 64, 1, 2), (3000, 1, 3)], Side::CT);
        let (d, _) = analyze(data, &fs, &extra, &LineupLibrary::default());
        assert!(!d.kills[1].is_trade);
        assert!(!d.kills[0].victim_traded);
        assert_eq!(d.analysis.players[0].untraded_deaths, 1);
    }

    #[test]
    fn rating_is_sane() {
        let (data, fs, extra) = fixture(vec![(1000, 2, 0), (1100, 1, 2), (3000, 1, 3)], Side::CT);
        let (d, _) = analyze(data, &fs, &extra, &LineupLibrary::default());
        let best = &d.analysis.players[1];
        let worst = &d.analysis.players[3];
        assert!(best.rating > worst.rating);
        assert!(best.score > worst.score);
        assert!(d.analysis.players.iter().all(|p| p.rating >= 0.0));
    }
}
