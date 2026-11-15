//! Voice extraction: CS2 demos (FACEIT, some ESEA/community servers) carry CSVCMsg_VoiceData
//! packets with Opus frames (48 kHz mono, usually 20 ms each). We segment them by tick and decode
//! to 16-bit mono PCM with libopus transpiled to Rust (`unsafe-libopus`; builds anywhere, no system
//! libs, ~50x faster than the pure-Rust re-implementations we tried and bit-identical to libopus).

use crate::extract::VoicePacket;
use crate::model::{VoiceInfo, VoicePlayer, VoiceSegment};
use std::collections::HashMap;

pub const OUTPUT_RATE: u32 = 24_000;
const VOICEDATA_FORMAT_OPUS: i32 = 2;
/// A new segment starts when a packet arrives this many seconds later than expected.
const SEGMENT_GAP_S: f32 = 0.25;
/// Lost packets (section number gaps) up to this many frames are concealed inside a segment.
const MAX_CONCEAL: u32 = 10;

/// Number of samples (at 48 kHz) an Opus packet decodes to, from its TOC byte (RFC 6716 §3.1).
pub fn opus_packet_samples_48k(p: &[u8]) -> Option<u32> {
    let toc = *p.first()?;
    let config = toc >> 3;
    // frame size in 1/400 s units * 120 = samples @48k
    let frame = match config {
        0..=11 => [480, 960, 1920, 2880][(config % 4) as usize],
        12..=15 => [480, 960][(config % 2) as usize],
        _ => [120, 240, 480, 960][(config % 4) as usize],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => (*p.get(1)? & 0x3F) as u32,
    };
    let total = frame * frames;
    if total == 0 || total > 5760 {
        return None;
    }
    Some(total)
}

#[derive(Debug, Clone)]
enum Item {
    Packet(usize),
    /// packet-loss concealment for this many samples (output rate)
    Conceal(u32),
}

#[derive(Debug, Clone, Default)]
struct PlayerPlan {
    slot: usize,
    steam_id: String,
    /// items in playback order, with output sample counts
    items: Vec<(Item, u32)>,
    segments: Vec<VoiceSegment>,
    total: u64,
}

/// Minimal safe wrapper around the transpiled libopus decoder.
struct Decoder {
    st: *mut unsafe_libopus::OpusDecoder,
}

impl Decoder {
    fn new(rate: u32) -> Option<Decoder> {
        let mut err = 0i32;
        // SAFETY: plain constructor call; returns null on failure which we check.
        let st = unsafe { unsafe_libopus::opus_decoder_create(rate as i32, 1, &mut err) };
        if st.is_null() || err != 0 {
            return None;
        }
        Some(Decoder { st })
    }
    /// Decodes one packet (or conceals a lost one when `packet` is empty) into `out`.
    fn decode(&mut self, packet: &[u8], out: &mut [i16]) -> usize {
        if packet.len() > i32::MAX as usize {
            return 0;
        }
        let (ptr, len) = if packet.is_empty() { (std::ptr::null(), 0) } else { (packet.as_ptr(), packet.len() as i32) };
        // SAFETY: `self.st` is a valid decoder; `ptr/len` describe a live slice (or null for PLC);
        // `out` has room for `out.len()` samples which we pass as the maximum frame size (mono).
        let n = unsafe { unsafe_libopus::opus_decode(self.st, ptr, len, out.as_mut_ptr(), out.len() as i32, 0) };
        if n < 0 {
            0
        } else {
            n as usize
        }
    }
    fn reset(&mut self) {
        // Re-create instead of using the varargs ctl interface.
        if let Some(d) = Decoder::new(OUTPUT_RATE) {
            *self = d;
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: created by opus_decoder_create and destroyed exactly once.
        unsafe { unsafe_libopus::opus_decoder_destroy(self.st) }
    }
}

/// Holds the compressed packets; decodes a player's PCM on demand.
#[derive(Debug, Clone, Default)]
pub struct VoiceStore {
    packets: Vec<Vec<u8>>,
    plans: Vec<PlayerPlan>,
    pub info_rate: u32,
}

impl VoiceStore {
    pub fn info(&self) -> VoiceInfo {
        VoiceInfo {
            available: self.plans.iter().any(|p| p.total > 0),
            sample_rate: OUTPUT_RATE,
            players: self
                .plans
                .iter()
                .map(|p| VoicePlayer {
                    slot: p.slot,
                    steam_id: p.steam_id.clone(),
                    total_samples: p.total,
                    segments: p.segments.clone(),
                })
                .collect(),
        }
    }

    pub fn steam_ids(&self) -> Vec<String> {
        self.plans.iter().map(|p| p.steam_id.clone()).collect()
    }

    /// Decodes all segments of one player into Int16 mono PCM at OUTPUT_RATE.
    pub fn decode(&self, steam_id: &str) -> Option<Vec<i16>> {
        let plan = self.plans.iter().find(|p| p.steam_id == steam_id)?;
        let mut out: Vec<i16> = Vec::with_capacity(plan.total as usize);
        let mut dec = Decoder::new(OUTPUT_RATE)?;
        let mut buf = vec![0i16; 5760];
        let mut seg_idx = 0usize;
        for (item, count) in &plan.items {
            // reset decoder state at segment boundaries (speech resumes after silence)
            while seg_idx < plan.segments.len() && plan.segments[seg_idx].sample_offset <= out.len() as u64 {
                if plan.segments[seg_idx].sample_offset == out.len() as u64 {
                    dec.reset();
                }
                seg_idx += 1;
            }
            let want = *count as usize;
            let n = match item {
                Item::Packet(i) => dec.decode(&self.packets[*i], &mut buf),
                Item::Conceal(n) => dec.decode(&[], &mut buf[..(*n as usize).min(5760)]),
            };
            let n = n.min(buf.len());
            if n >= want {
                out.extend_from_slice(&buf[..want]);
            } else {
                out.extend_from_slice(&buf[..n]);
                out.extend(std::iter::repeat(0).take(want - n));
            }
        }
        Some(out)
    }

    pub fn decode_bytes(&self, steam_id: &str) -> Option<Vec<u8>> {
        let pcm = self.decode(steam_id)?;
        let mut b = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            b.extend_from_slice(&s.to_le_bytes());
        }
        Some(b)
    }
}

/// Builds the voice store. `slot_of` maps an xuid to a player slot (packets of unknown xuids are
/// kept under a synthetic slot only if `keep_unknown`).
pub fn build(packets: Vec<VoicePacket>, slot_of: &dyn Fn(u64) -> Option<(usize, String)>, tick_rate: f32) -> VoiceStore {
    let mut by_player: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut store = VoiceStore { packets: Vec::with_capacity(packets.len()), plans: vec![], info_rate: OUTPUT_RATE };
    let mut meta: Vec<(i32, u32)> = Vec::with_capacity(packets.len());
    for p in packets {
        if p.format != VOICEDATA_FORMAT_OPUS || p.data.is_empty() {
            continue;
        }
        let idx = store.packets.len();
        meta.push((p.tick, p.section));
        store.packets.push(p.data);
        by_player.entry(p.xuid).or_default().push(idx);
    }
    let ratio = OUTPUT_RATE as f32 / 48_000.0;
    let mut plans = vec![];
    for (xuid, mut idxs) in by_player {
        let Some((slot, steam_id)) = slot_of(xuid) else { continue };
        idxs.sort_by_key(|&i| (meta[i].0, meta[i].1));
        // drop exact duplicates (same section number seen twice)
        idxs.dedup_by_key(|i| meta[*i].1);
        let mut plan = PlayerPlan { slot, steam_id, ..Default::default() };
        let mut seg_start_tick = 0i32;
        let mut seg_samples: u64 = 0;
        let mut last_section: Option<u32> = None;
        let mut last_dur: u32 = (960.0 * ratio) as u32;
        for i in idxs {
            let (tick, section) = meta[i];
            let Some(s48) = opus_packet_samples_48k(&store.packets[i]) else { continue };
            let dur = ((s48 as f32) * ratio).round() as u32;
            let expected_tick = seg_start_tick as f32 + seg_samples as f32 / OUTPUT_RATE as f32 * tick_rate;
            let new_segment = plan.segments.is_empty()
                || (tick as f32) > expected_tick + SEGMENT_GAP_S * tick_rate
                || match last_section {
                    Some(ls) => section.wrapping_sub(ls) > MAX_CONCEAL + 1 || section <= ls,
                    None => true,
                };
            if new_segment {
                plan.segments.push(VoiceSegment { start_tick: tick, sample_offset: plan.total, sample_count: 0 });
                seg_start_tick = tick;
                seg_samples = 0;
            } else if let Some(ls) = last_section {
                let missing = section.wrapping_sub(ls).saturating_sub(1);
                for _ in 0..missing {
                    plan.items.push((Item::Conceal(last_dur), last_dur));
                    plan.total += last_dur as u64;
                    seg_samples += last_dur as u64;
                    if let Some(seg) = plan.segments.last_mut() {
                        seg.sample_count += last_dur as u64;
                    }
                }
            }
            plan.items.push((Item::Packet(i), dur));
            plan.total += dur as u64;
            seg_samples += dur as u64;
            if let Some(seg) = plan.segments.last_mut() {
                seg.sample_count += dur as u64;
            }
            last_section = Some(section);
            last_dur = dur;
        }
        if plan.total > 0 {
            plans.push(plan);
        }
    }
    plans.sort_by_key(|p| p.slot);
    store.plans = plans;
    store
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toc_durations() {
        // CELT 20 ms, 1 frame (config 31, code 0)
        assert_eq!(opus_packet_samples_48k(&[31 << 3, 0]), Some(960));
        // SILK 20 ms, 2 frames
        assert_eq!(opus_packet_samples_48k(&[(1 << 3) | 1, 0]), Some(1920));
        // code 3 with 3 frames of 10 ms SILK
        assert_eq!(opus_packet_samples_48k(&[3, 3]), Some(1440));
        assert_eq!(opus_packet_samples_48k(&[]), None);
    }

    #[test]
    fn segmentation_and_concealment() {
        // fake CELT 20ms packets (content is garbage; decoder errors are padded with silence)
        let mk = |tick: i32, section: u32| VoicePacket {
            tick,
            xuid: 7,
            section,
            data: vec![31 << 3, 0xff, 0xfe],
            sample_rate: 48000,
            format: 2,
        };
        // 3 packets back to back, one lost packet, then a gap of 2 s -> second segment
        let pk = vec![mk(100, 1), mk(101, 2), mk(103, 4), mk(230, 5), mk(231, 6)];
        let store = build(pk, &|x| if x == 7 { Some((0, "7".into())) } else { None }, 64.0);
        let info = store.info();
        assert!(info.available);
        let p = &info.players[0];
        assert_eq!(p.segments.len(), 2);
        assert_eq!(p.segments[0].sample_count, 4 * 480); // 3 packets + 1 concealed
        assert_eq!(p.segments[1].start_tick, 230);
        assert_eq!(p.segments[1].sample_offset, 4 * 480);
        assert_eq!(p.total_samples, 6 * 480);
        let pcm = store.decode("7").unwrap();
        assert_eq!(pcm.len() as u64, p.total_samples);
    }
}
