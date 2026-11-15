//! Heuristic analysis engine (deterministic, offline).

use crate::demo::Extra;
use crate::frames::FrameStore;
use crate::lineups::{Lineup, LineupLibrary};
use crate::model::*;

pub const SUB_SCORE_KEYS: [&str; 8] = ["aim", "entry", "trade", "utility", "clutch", "survival", "economy", "positioning"];

pub fn analyze(mut data: DemoData, _fs: &FrameStore, extra: &Extra, _lib: &LineupLibrary) -> (DemoData, Vec<Lineup>) {
    data.analysis.players = (0..data.players.len())
        .map(|slot| {
            let mut s = PlayerStats { slot, score: 50.0, rating: 1.0, ..Default::default() };
            for k in SUB_SCORE_KEYS {
                s.sub_scores.insert(k.into(), 50.0);
            }
            for g in GrenadeType::ALL {
                s.grenades_thrown.insert(g.as_str().into(), 0);
            }
            s
        })
        .collect();
    data.analysis.rounds = data
        .rounds
        .iter()
        .enumerate()
        .map(|(ri, r)| RoundAnalysis {
            round: r.number,
            players: (0..data.players.len())
                .filter_map(|slot| {
                    extra.round_sides[ri][slot].map(|side| RoundPlayerLine {
                        slot,
                        side,
                        score: 0.0,
                        kills: 0,
                        died: false,
                        damage: 0,
                        survived: true,
                        equip_value: 0,
                        verdict: "neutral".into(),
                    })
                })
                .collect(),
            mvp: None,
            summary: String::new(),
        })
        .collect();
    (data, vec![])
}
