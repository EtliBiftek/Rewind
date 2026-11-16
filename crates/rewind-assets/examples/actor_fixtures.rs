//! Dev tool: export agents, weapons and animation JSON for the browser fixture mode.
//! `actor_fixtures <csgo dir> <out dir> <path>...` (paths as in the game; `.vmdl` or animation resources)
use rewind_assets::{actors, Game, TexFormat};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let game = Game::open(std::path::Path::new(&a[1])).unwrap();
    let out = std::path::Path::new(&a[2]);
    for p in &a[3..] {
        let t = std::time::Instant::now();
        let r = if p.ends_with(".vmdl") { actors::export_actor(&game, p, TexFormat::Image, 1024) } else { actors::anim_json(&game, p) };
        match r {
            Ok(b) => {
                let f = out.join(p);
                std::fs::create_dir_all(f.parent().unwrap()).unwrap();
                std::fs::write(&f, &b).unwrap();
                println!("{p}: {} KB in {} ms", b.len() / 1024, t.elapsed().as_millis());
            }
            Err(e) => println!("{p}: ERR {e}"),
        }
    }
}
