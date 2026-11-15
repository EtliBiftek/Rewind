/**
 * Rewind — backend <-> frontend data contract (single source of truth).
 *
 * Rust (serde, `rename_all = "camelCase"`) must serialize exactly these shapes.
 * World coordinates are raw Source 2 units. Angles are degrees (yaw: 0 = +X, CCW; pitch: negative = up).
 * Steam ids are decimal strings (u64 does not fit a JS number).
 *
 * Tauri commands
 *   load_demo(path: string)            -> DemoData          (emits `demo-progress` events: {stage: string, pct: number 0..1})
 *   get_frames()                       -> ArrayBuffer       (raw tauri::ipc::Response; layout below; for the last loaded demo)
 *   get_voice_pcm(steamId: string)     -> ArrayBuffer       (Int16 LE mono PCM at voice.sampleRate, all segments concatenated)
 *   write_file(path: string, append: boolean) + raw body    -> void   (body = bytes; path sent in the `x-path` header, append in `x-append`: "1"/"0")
 *   library_stats()                    -> LibraryStats      (persistent lineup library learned from every demo ever loaded + bundled seed)
 *
 * Browser/dev mode (no Tauri): the frontend fetches the same payloads from
 *   /fixtures/demo.json, /fixtures/frames.bin, /fixtures/voice_<steamId>.bin
 * which `cargo run -p rewind-cli -- export <demo.dem> --out public/fixtures` produces.
 */

export type Vec3 = [number, number, number];
export type Side = "T" | "CT";

export interface DemoData {
  header: DemoHeader;
  map: MapInfo;
  players: PlayerInfo[]; // index in this array == player slot in frames.bin
  rounds: RoundInfo[];
  kills: KillEvent[];
  damages: DamageEvent[];
  shots: ShotEvent[];
  blinds: BlindEvent[];
  grenades: Grenade[];
  bombEvents: BombEvent[];
  chat: ChatMessage[];
  frames: FramesMeta;
  voice: VoiceInfo;
  analysis: Analysis;
}

export interface DemoHeader {
  fileName: string;
  mapName: string; // e.g. "de_mirage"
  serverName: string;
  source: "faceit" | "valve" | "esea" | "hltv" | "unknown";
  tickRate: number; // usually 64
  totalTicks: number;
  durationSeconds: number;
}

export interface MapInfo {
  name: string;
  /** Radar transform (CS2 overview convention): pixelX = (worldX - posX) / scale, pixelY = (posY - worldY) / scale on a 1024x1024 image. */
  posX: number;
  posY: number;
  scale: number;
  /** For two-level maps (nuke, vertigo): z below this is the lower level. null otherwise. */
  lowerLevelMaxZ: number | null;
  /** True when posX/posY/scale are the official values for this map; false = fitted from player positions. */
  known: boolean;
  /** Bounding box of all sampled player positions. */
  boundsMin: Vec3;
  boundsMax: Vec3;
}

export interface PlayerInfo {
  slot: number; // == index
  steamId: string;
  name: string;
  /** Team identity that stays constant across side swaps: 0 or 1 (0 = team that started as CT). */
  team: 0 | 1;
  teamName: string;
  isBot: boolean;
}

export interface RoundInfo {
  number: number; // 1-based
  startTick: number; // round start (freeze time begins)
  freezeEndTick: number;
  endTick: number; // round decided
  officialEndTick: number; // next round is about to begin
  winner: Side | null;
  /** e.g. "bomb_exploded" | "bomb_defused" | "t_eliminated" | "ct_eliminated" | "time_expired" | "unknown" */
  endReason: string;
  /** Which side each constant team (index 0/1) plays this round. */
  teamSides: [Side, Side];
  /** Score BEFORE this round, indexed by constant team. */
  scoreBefore: [number, number];
  /** Per-team buy classification, indexed by constant team: "pistol" | "eco" | "force" | "full". */
  buyTypes: [string, string];
  /** Per-team equipment value at freeze end. */
  equipValues: [number, number];
  bombPlantedTick: number | null;
  bombSite: "A" | "B" | null;
}

export interface KillEvent {
  tick: number;
  round: number;
  attacker: number | null; // player slot; null = world/bomb
  victim: number;
  assister: number | null;
  flashAssist: boolean;
  weapon: string; // normalized, e.g. "ak47", "awp", "hegrenade", "inferno", "knife"
  headshot: boolean;
  wallbang: boolean;
  throughSmoke: boolean;
  noScope: boolean;
  attackerBlind: boolean;
  attackerPos: Vec3 | null;
  victimPos: Vec3;
  distance: number;
  /** Derived by the analyzer. */
  isOpening: boolean;
  /** This kill avenged a teammate who died <= 5 s earlier to the same victim. */
  isTrade: boolean;
  /** The victim got traded (killer died within 5 s to victim's teammate). */
  victimTraded: boolean;
}

export interface DamageEvent {
  tick: number;
  round: number;
  attacker: number | null;
  victim: number;
  weapon: string;
  hpDamage: number; // capped to victim's remaining health
  armorDamage: number;
  hitgroup: string; // "head" | "chest" | "stomach" | "arm" | "leg" | "generic"
}

export interface ShotEvent {
  tick: number;
  player: number;
  weapon: string;
}

export interface BlindEvent {
  tick: number;
  round: number;
  attacker: number; // thrower
  victim: number;
  duration: number; // seconds
  teamFlash: boolean;
  grenadeId: number | null;
}

export type GrenadeType = "smoke" | "flash" | "he" | "molotov" | "decoy"; // molotov covers incendiary too

export interface Grenade {
  id: number;
  type: GrenadeType;
  thrower: number; // player slot
  round: number;
  throwTick: number;
  throwPos: Vec3; // thrower position at throw
  throwYaw: number;
  throwPitch: number;
  /** Heuristic: "stand" | "jump" | "run" | "crouch" | "walk" plus "+jump" style combos are flattened to these. */
  throwStyle: string;
  /** Detonation / pop / ignite tick (null if it never detonated, e.g. round ended). */
  detonateTick: number | null;
  detonatePos: Vec3 | null;
  /** When the effect ends (smoke fades, fire dies). null for flash/he. */
  expireTick: number | null;
  /** Flight path samples: flat array [tick, x, y, z, tick, x, y, z, ...]. */
  trajectory: number[];
  /** Callout name of the landing spot, if known (e.g. "Window"). */
  landPlace: string | null;
  throwPlace: string | null;
  /** Outcome numbers computed by the analyzer. */
  enemiesFlashed: number;
  teammatesFlashed: number;
  enemyBlindSeconds: number;
  teamBlindSeconds: number;
  damage: number; // enemy hp damage (he / fire)
  teamDamage: number;
}

export interface BombEvent {
  tick: number;
  round: number;
  type: "pickup" | "drop" | "plant_begin" | "planted" | "defuse_begin" | "defuse_abort" | "defused" | "exploded";
  player: number | null;
  site: "A" | "B" | null;
  pos: Vec3 | null;
}

export interface ChatMessage {
  tick: number;
  player: number | null;
  text: string;
  teamOnly: boolean;
}

/**
 * frames.bin layout: little-endian Float32, no header.
 *   value(frame f, player slot p, field k) = data[(f * playerCount + p) * stride + k]
 *   tick(f) = startTick + f * sampleInterval
 * Fields (stride = 12), in order — see FRAME_FIELDS.
 */
export interface FramesMeta {
  startTick: number;
  sampleInterval: number; // ticks between frames (4 at 64 tick = 16 Hz)
  frameCount: number;
  playerCount: number;
  stride: number; // 12
  /** Weapon name table; frame field `weapon` is an index into this (e.g. "ak47"). */
  weapons: string[];
}

export const FRAME_FIELDS = [
  "x",
  "y",
  "z",
  "yaw",
  "pitch",
  "health", // 0 when dead
  "armor",
  "flags", // bitfield, see FrameFlag
  "flashRemaining", // seconds of blindness left (0 = not blind)
  "weapon", // index into FramesMeta.weapons, -1 = none
  "money",
  "equipValue",
] as const;

export const FrameFlag = {
  Connected: 1,
  Alive: 2,
  SideCT: 4, // set = CT, clear = T
  Ducking: 8,
  Scoped: 16,
  Defusing: 32,
  HasBomb: 64,
  HasDefuser: 128,
  HasHelmet: 256,
  Airborne: 512,
  Walking: 1024, // moving below ~ walk speed (silent)
  Planting: 2048,
} as const;

export interface VoiceInfo {
  available: boolean;
  sampleRate: number; // e.g. 24000 or 48000
  players: VoicePlayer[];
}

export interface VoicePlayer {
  slot: number;
  steamId: string;
  totalSamples: number;
  /** Speech segments; sampleOffset indexes into the PCM returned by get_voice_pcm. */
  segments: { startTick: number; sampleOffset: number; sampleCount: number }[];
}

/* ------------------------------------------------------------------ */
/* Analysis (pure heuristics, no AI / no network)                      */
/* ------------------------------------------------------------------ */

export interface Analysis {
  players: PlayerStats[]; // index == player slot
  rounds: RoundAnalysis[]; // index == round number - 1
  insights: Insight[];
  /** Position heat / danger summaries etc. may be added later; keep additive. */
}

export interface PlayerStats {
  slot: number;
  /** 0..100 overall performance score (the headline number). */
  score: number;
  /** HLTV-2.0-style rating approximation (~1.00 average). */
  rating: number;
  /** Sub-scores, each 0..100. Keys: "aim" | "entry" | "trade" | "utility" | "clutch" | "survival" | "economy" | "positioning". */
  subScores: Record<string, number>;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  kast: number; // 0..100
  hsPercent: number; // 0..100
  kpr: number;
  dpr: number;
  impact: number;
  openingKills: number;
  openingDeaths: number;
  tradeKills: number;
  tradedDeaths: number;
  untradedDeaths: number;
  multiKills: { k2: number; k3: number; k4: number; k5: number };
  clutchesWon: { v1: number; v2: number; v3: number; v4: number; v5: number };
  clutchesLost: number;
  flashAssists: number;
  enemiesFlashed: number;
  enemyBlindSeconds: number;
  teammatesFlashed: number;
  utilityDamage: number;
  grenadesThrown: Record<GrenadeType, number>;
  /** Accuracy: shots that dealt damage / bullets fired (0..100), firearms only. */
  accuracy: number;
  /** Average time (s) alive per round. */
  avgTimeAlive: number;
  mvpRounds: number;
}

export interface RoundAnalysis {
  round: number;
  /** One line per player slot. */
  players: RoundPlayerLine[];
  /** Slot of the round's most valuable player. */
  mvp: number | null;
  /** Short textual summary of how the round was decided. */
  summary: string;
}

export interface RoundPlayerLine {
  slot: number;
  side: Side;
  /** Round score, roughly -100..+100 around 0 = neutral; used for per-round colouring. */
  score: number;
  kills: number;
  died: boolean;
  damage: number;
  survived: boolean;
  equipValue: number;
  /** Short verdict such as "İyi", "Kötü", "Nötr" plus reasons live in insights. */
  verdict: "good" | "bad" | "neutral";
}

export type InsightSeverity = "good" | "bad" | "info";

export interface Insight {
  id: number;
  round: number;
  tick: number;
  player: number; // slot
  /**
   * Machine kind, e.g. "opening_kill", "opening_death", "untraded_death", "trade_kill", "clutch_won", "multi_kill",
   * "team_flash", "wasted_flash", "bad_smoke", "wasted_he", "wasted_molotov", "good_flash", "good_utility",
   * "died_isolated", "died_with_utility", "died_reloading", "saved_weapon", "eco_frag", "bomb_plant", "bomb_defuse",
   * "no_trade_position", "overpeek", "late_rotation", ... (frontend must render unknown kinds generically).
   */
  kind: string;
  category: "aim" | "entry" | "trade" | "utility" | "clutch" | "survival" | "economy" | "positioning" | "objective";
  severity: InsightSeverity;
  /** Turkish, user-facing. */
  title: string;
  detail: string;
  /** Contribution to the player's round score. */
  scoreDelta: number;
  pos: Vec3 | null;
  /** Related grenade (for utility insights). */
  grenadeId: number | null;
  /** For bad utility: how it should have been thrown instead. */
  suggestion: UtilitySuggestion | null;
}

export interface UtilitySuggestion {
  type: GrenadeType;
  /** Turkish label, e.g. "Window smoke (T Spawn'dan, zıplayarak)". */
  label: string;
  from: Vec3;
  fromPlace: string | null;
  aimYaw: number;
  aimPitch: number;
  throwStyle: string;
  land: Vec3;
  landPlace: string | null;
  /** Reference flight path, flat [x, y, z, x, y, z, ...] (no ticks). */
  trajectory: number[];
  /** Where the reference throw comes from. */
  source: "seed" | "library" | "this_demo";
  /** How many successful throws in the library back this lineup. */
  support: number;
  /** Why this is suggested (Turkish). */
  reason: string;
}

export interface LibraryStats {
  demos: number;
  lineupsByMap: Record<string, number>;
}
