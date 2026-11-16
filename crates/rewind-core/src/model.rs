//! Serde model mirroring `src/lib/contract.ts` exactly (camelCase).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Vec3 = [f32; 3];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side {
    T,
    CT,
}

impl Side {
    pub fn from_team_num(n: i64) -> Option<Side> {
        match n {
            2 => Some(Side::T),
            3 => Some(Side::CT),
            _ => None,
        }
    }
    pub fn other(self) -> Side {
        match self {
            Side::T => Side::CT,
            Side::CT => Side::T,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Side::T => "T",
            Side::CT => "CT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoData {
    pub header: DemoHeader,
    pub map: MapInfo,
    pub players: Vec<PlayerInfo>,
    pub rounds: Vec<RoundInfo>,
    pub kills: Vec<KillEvent>,
    pub damages: Vec<DamageEvent>,
    pub shots: Vec<ShotEvent>,
    pub blinds: Vec<BlindEvent>,
    pub grenades: Vec<Grenade>,
    pub bomb_events: Vec<BombEvent>,
    pub chat: Vec<ChatMessage>,
    pub frames: FramesMeta,
    pub voice: VoiceInfo,
    pub analysis: Analysis,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoHeader {
    pub file_name: String,
    pub map_name: String,
    pub server_name: String,
    /// "faceit" | "valve" | "esea" | "hltv" | "unknown"
    pub source: String,
    pub tick_rate: f32,
    pub total_ticks: i32,
    pub duration_seconds: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    pub name: String,
    pub pos_x: f32,
    pub pos_y: f32,
    pub scale: f32,
    pub lower_level_max_z: Option<f32>,
    pub known: bool,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerInfo {
    pub slot: usize,
    pub steam_id: String,
    pub name: String,
    pub team: u8,
    pub team_name: String,
    pub is_bot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundInfo {
    pub number: u32,
    pub start_tick: i32,
    pub freeze_end_tick: i32,
    pub end_tick: i32,
    pub official_end_tick: i32,
    pub winner: Option<Side>,
    pub end_reason: String,
    pub team_sides: [Side; 2],
    pub score_before: [u32; 2],
    pub buy_types: [String; 2],
    pub equip_values: [i32; 2],
    pub bomb_planted_tick: Option<i32>,
    pub bomb_site: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillEvent {
    pub tick: i32,
    pub round: u32,
    pub attacker: Option<usize>,
    pub victim: usize,
    pub assister: Option<usize>,
    pub flash_assist: bool,
    pub weapon: String,
    pub headshot: bool,
    pub wallbang: bool,
    pub through_smoke: bool,
    pub no_scope: bool,
    pub attacker_blind: bool,
    pub attacker_pos: Option<Vec3>,
    pub victim_pos: Vec3,
    pub distance: f32,
    pub is_opening: bool,
    pub is_trade: bool,
    pub victim_traded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageEvent {
    pub tick: i32,
    pub round: u32,
    pub attacker: Option<usize>,
    pub victim: usize,
    pub weapon: String,
    pub hp_damage: i32,
    pub armor_damage: i32,
    pub hitgroup: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotEvent {
    pub tick: i32,
    pub player: usize,
    pub weapon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindEvent {
    pub tick: i32,
    pub round: u32,
    pub attacker: usize,
    pub victim: usize,
    pub duration: f32,
    pub team_flash: bool,
    pub grenade_id: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrenadeType {
    Smoke,
    Flash,
    He,
    Molotov,
    Decoy,
}

impl GrenadeType {
    pub const ALL: [GrenadeType; 5] = [
        GrenadeType::Smoke,
        GrenadeType::Flash,
        GrenadeType::He,
        GrenadeType::Molotov,
        GrenadeType::Decoy,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            GrenadeType::Smoke => "smoke",
            GrenadeType::Flash => "flash",
            GrenadeType::He => "he",
            GrenadeType::Molotov => "molotov",
            GrenadeType::Decoy => "decoy",
        }
    }
    /// Turkish display name.
    pub fn tr(self) -> &'static str {
        match self {
            GrenadeType::Smoke => "smoke",
            GrenadeType::Flash => "flaş",
            GrenadeType::He => "HE bombası",
            GrenadeType::Molotov => "molotof",
            GrenadeType::Decoy => "decoy",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grenade {
    pub id: u32,
    #[serde(rename = "type")]
    pub kind: GrenadeType,
    pub thrower: usize,
    pub round: u32,
    pub throw_tick: i32,
    pub throw_pos: Vec3,
    pub throw_yaw: f32,
    pub throw_pitch: f32,
    pub throw_style: String,
    pub detonate_tick: Option<i32>,
    pub detonate_pos: Option<Vec3>,
    pub expire_tick: Option<i32>,
    pub trajectory: Vec<f32>,
    pub land_place: Option<String>,
    pub throw_place: Option<String>,
    pub enemies_flashed: u32,
    pub teammates_flashed: u32,
    pub enemy_blind_seconds: f32,
    pub team_blind_seconds: f32,
    pub damage: i32,
    pub team_damage: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BombEvent {
    pub tick: i32,
    pub round: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub player: Option<usize>,
    pub site: Option<String>,
    pub pos: Option<Vec3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub tick: i32,
    pub player: Option<usize>,
    pub text: String,
    pub team_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesMeta {
    pub start_tick: i32,
    pub sample_interval: i32,
    pub frame_count: usize,
    pub player_count: usize,
    pub stride: usize,
    pub weapons: Vec<String>,
}

pub const FRAME_STRIDE: usize = 12;

pub mod frame_field {
    pub const X: usize = 0;
    pub const Y: usize = 1;
    pub const Z: usize = 2;
    pub const YAW: usize = 3;
    pub const PITCH: usize = 4;
    pub const HEALTH: usize = 5;
    pub const ARMOR: usize = 6;
    pub const FLAGS: usize = 7;
    pub const FLASH_REMAINING: usize = 8;
    pub const WEAPON: usize = 9;
    pub const MONEY: usize = 10;
    pub const EQUIP_VALUE: usize = 11;
}

pub mod frame_flag {
    pub const CONNECTED: u32 = 1;
    pub const ALIVE: u32 = 2;
    pub const SIDE_CT: u32 = 4;
    pub const DUCKING: u32 = 8;
    pub const SCOPED: u32 = 16;
    pub const DEFUSING: u32 = 32;
    pub const HAS_BOMB: u32 = 64;
    pub const HAS_DEFUSER: u32 = 128;
    pub const HAS_HELMET: u32 = 256;
    pub const AIRBORNE: u32 = 512;
    pub const WALKING: u32 = 1024;
    pub const PLANTING: u32 = 2048;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub available: bool,
    pub sample_rate: u32,
    pub players: Vec<VoicePlayer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePlayer {
    pub slot: usize,
    pub steam_id: String,
    pub total_samples: u64,
    pub segments: Vec<VoiceSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSegment {
    pub start_tick: i32,
    pub sample_offset: u64,
    pub sample_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub players: Vec<PlayerStats>,
    pub rounds: Vec<RoundAnalysis>,
    pub insights: Vec<Insight>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiKills {
    pub k2: u32,
    pub k3: u32,
    pub k4: u32,
    pub k5: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClutchesWon {
    pub v1: u32,
    pub v2: u32,
    pub v3: u32,
    pub v4: u32,
    pub v5: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStats {
    pub slot: usize,
    pub score: f32,
    pub rating: f32,
    pub sub_scores: BTreeMap<String, f32>,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub adr: f32,
    pub kast: f32,
    pub hs_percent: f32,
    pub kpr: f32,
    pub dpr: f32,
    pub impact: f32,
    pub opening_kills: u32,
    pub opening_deaths: u32,
    pub trade_kills: u32,
    pub traded_deaths: u32,
    pub untraded_deaths: u32,
    pub multi_kills: MultiKills,
    pub clutches_won: ClutchesWon,
    pub clutches_lost: u32,
    pub flash_assists: u32,
    pub enemies_flashed: u32,
    pub enemy_blind_seconds: f32,
    pub teammates_flashed: u32,
    pub utility_damage: i32,
    pub grenades_thrown: BTreeMap<String, u32>,
    pub accuracy: f32,
    pub avg_time_alive: f32,
    pub mvp_rounds: u32,
    /// Additive (not in contract v1): rounds this player actually played.
    pub rounds_played: u32,
    /// Additive: total HP damage dealt to enemies.
    pub damage: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundAnalysis {
    pub round: u32,
    pub players: Vec<RoundPlayerLine>,
    pub mvp: Option<usize>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundPlayerLine {
    pub slot: usize,
    pub side: Side,
    pub score: f32,
    pub kills: u32,
    pub died: bool,
    pub damage: i32,
    pub survived: bool,
    pub equip_value: i32,
    /// "good" | "bad" | "neutral"
    pub verdict: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub id: u32,
    pub round: u32,
    pub tick: i32,
    pub player: usize,
    pub kind: String,
    pub category: String,
    /// "good" | "bad" | "info"
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub score_delta: f32,
    pub pos: Option<Vec3>,
    pub grenade_id: Option<u32>,
    pub suggestion: Option<UtilitySuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtilitySuggestion {
    #[serde(rename = "type")]
    pub kind: GrenadeType,
    pub label: String,
    pub from: Vec3,
    pub from_place: Option<String>,
    pub aim_yaw: f32,
    pub aim_pitch: f32,
    pub throw_style: String,
    pub land: Vec3,
    pub land_place: Option<String>,
    pub trajectory: Vec<f32>,
    /// "seed" | "library" | "this_demo"
    pub source: String,
    pub support: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub demos: u32,
    pub lineups_by_map: BTreeMap<String, u32>,
}
