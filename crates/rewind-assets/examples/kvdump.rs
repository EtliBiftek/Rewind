//! Dev tool: dump a compiled resource's DATA as JSON. `kvdump <dir> <vpk-or-file> [entry]`
use heatel::{DirSource, Resource, Vpk};
fn shorten(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::Array(a) => { if a.len() > 40 { a.truncate(40); a.push("...".into()); } a.iter_mut().for_each(shorten) }
        serde_json::Value::Object(o) => o.values_mut().for_each(shorten),
        serde_json::Value::String(s) if s.len() > 300 => { s.truncate(300); }
        _ => {}
    }
}
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let src = DirSource::new(&a[1]);
    let bytes = if a.len() > 3 {
        let vpk = Vpk::open(&src, &a[2]).unwrap();
        if a[3] == "-l" { for e in vpk.entries() { println!("{} {}", e.path(), e.size()); } return; }
        vpk.read_file(&src, &a[3]).unwrap()
    } else { std::fs::read(std::path::Path::new(&a[1]).join(&a[2])).unwrap() };
    let r = Resource::parse(&bytes).unwrap();
    for b in r.blocks() { eprintln!("block {} {}", String::from_utf8_lossy(&b.kind), b.size); }
    if let Ok(refs) = r.external_refs() { for x in refs.iter().take(50) { eprintln!("ref {}", x.name); } }
    let d = r.data().unwrap().unwrap();
    let mut j = serde_json::to_value(&d).unwrap();
    if std::env::var("FULL").is_err() { shorten(&mut j); }
    println!("{}", serde_json::to_string_pretty(&j).unwrap());
}
