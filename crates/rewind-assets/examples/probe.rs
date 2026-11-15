//! Dev tool: try to parse every compiled resource in a folder. `probe <dir>`
use heatel::{Resource, Texture, Model};
fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
    files.sort();
    for p in files {
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with("_c") { continue; }
        let bytes = std::fs::read(&p).unwrap();
        let r = match Resource::parse(&bytes) { Ok(r) => r, Err(e) => { println!("{name}: RESOURCE ERR {e}"); continue; } };
        let blocks: Vec<String> = r.blocks().iter().map(|b| String::from_utf8_lossy(&b.kind).to_string()).collect();
        let data = match r.data() { Some(Ok(_)) => "ok".to_string(), Some(Err(e)) => format!("ERR {e}"), None => "none".into() };
        let extra = if name.ends_with(".vtex_c") {
            match Texture::parse(&bytes) { Ok(t) => format!("tex {}x{} {:?} mips={}", t.width(), t.height(), t.format(), t.mips().len()), Err(e) => format!("TEX ERR {e}") }
        } else if name.ends_with(".vmdl_c") {
            match Model::read(&r) { Ok(m) => format!("model meshes={} prims={}", m.meshes.len(), m.meshes.iter().map(|x| x.primitives.len()).sum::<usize>()), Err(e) => format!("MODEL ERR {e}") }
        } else { String::new() };
        println!("{name}: v{} [{}] data={data} {extra}", r.version(), blocks.join(","));
    }
}
