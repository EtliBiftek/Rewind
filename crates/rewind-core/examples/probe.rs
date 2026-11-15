use ahash::AHashMap;
use cs2_demoparser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use cs2_demoparser::parse_demo::{Parser, ParsingMode};
use cs2_demoparser::second_pass::parser_settings::create_huffman_lookup_table;
use std::collections::BTreeMap;

fn main() {
    let path = std::env::args().nth(1).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let huf = create_huffman_lookup_table();
    let t = std::time::Instant::now();
    let pprops: Vec<String> = ["X", "Y", "Z", "last_place_name", "team_num", "health"].iter().map(|s| s.to_string()).collect();
    let real = rm_user_friendly_names(&pprops).unwrap();
    let mut r2o = AHashMap::default();
    for (r, o) in real.iter().zip(&pprops) { r2o.insert(r.clone(), o.clone()); }
    let settings = ParserInputs {
        real_name_to_og_name: r2o,
        wanted_players: vec![],
        wanted_player_props: real,
        wanted_other_props: vec![],
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: vec![],
        wanted_events: vec!["all".to_string()],
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        parse_weapons: false,
        only_header: false,
        list_props: false,
        only_convars: false,
        huffman_lookup_table: &huf,
        order_by_steamid: false,
        fallback_bytes: None,
    };
    let mut p = Parser::new(settings, ParsingMode::Normal);
    let out = p.parse_demo(&bytes).unwrap();
    eprintln!("parse {:?}", t.elapsed());
    println!("header {:?}", out.header);
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut example: BTreeMap<String, String> = BTreeMap::new();
    for e in &out.game_events {
        *counts.entry(e.name.clone()).or_default() += 1;
        example.entry(e.name.clone()).or_insert_with(|| format!("tick={} {:?}", e.tick, e.fields.iter().map(|f| format!("{}={:?}", f.name, f.data)).collect::<Vec<_>>()));
    }
    let filt: Vec<String> = std::env::args().skip(2).collect();
    if !filt.is_empty() {
        for e in &out.game_events { if filt.contains(&e.name) { println!("{} t={} {}", e.name, e.tick, e.fields.iter().filter(|f| !f.name.starts_with("user_") || f.name=="user_name").map(|f| format!("{}={:?}", f.name, f.data)).collect::<Vec<_>>().join(" ")); } }
        return;
    }
    for (k, v) in &counts { println!("{k}: {v}\n    {}", example[k]); }
    println!("voice packets: {}", out.voice_data.len());
    for (tick, v) in out.voice_data.iter().take(5) {
        let a = v.audio.as_ref().unwrap();
        println!("tick {tick} xuid {} fmt {:?} len {} sr {:?} np {:?} offs {:?} seq {:?} sec {:?} uso {:?}", v.xuid(), a.format, a.voice_data().len(), a.sample_rate, a.num_packets, a.packet_offsets, a.sequence_bytes, a.section_number, a.uncompressed_sample_offset);
    }
    println!("chat {}", out.chat_messages.len());
    for c in out.chat_messages.iter().take(3) { println!("{:?}", c); }
    println!("player_md {:?}", out.player_md);
    println!("convars {:?}", out.convars.iter().filter(|(k,_)| k.contains("mp_") || k.contains("tv_")).take(40).collect::<Vec<_>>());
}
