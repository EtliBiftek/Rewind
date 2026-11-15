fn main() {
    let path = std::env::args().nth(1).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let t = std::time::Instant::now();
    let raw = rewind_core::extract::extract(&bytes, &|s, p| eprintln!("{s} {p} {:?}", std::time::Instant::now())).unwrap();
    eprintln!("extract {:?}", t.elapsed());
    let mut c = std::collections::BTreeMap::new();
    for e in &raw.events { *c.entry(e.name.clone()).or_insert(0) += 1; }
    println!("{:?}", c);
    println!("tick rows {} proj rows {} voice {}", raw.ticks.rows, raw.projectiles.rows, raw.voice.len());
    for e in raw.events.iter().filter(|e| e.name == "round_end").take(3) { println!("{:?}", e); }
}
