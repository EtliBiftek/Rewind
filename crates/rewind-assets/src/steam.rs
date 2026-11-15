//! Finding the user's Counter-Strike 2 install (Steam app 730) on Windows, Linux and macOS.
//!
//! The game's content lives in `<library>/steamapps/common/Counter-Strike Global Offensive/game/csgo`.
//! Steam libraries are listed in `<steam>/steamapps/libraryfolders.vdf` (KeyValues 1 text).

use std::path::{Path, PathBuf};

/// Steam app id of Counter-Strike 2.
pub const CS2_APP_ID: &str = "730";
const DEFAULT_INSTALL_DIR: &str = "Counter-Strike Global Offensive";

/// A minimal KeyValues 1 text node (enough for `libraryfolders.vdf` and `appmanifest_*.acf`).
#[derive(Debug, Clone, PartialEq)]
pub enum Kv {
    Str(String),
    Obj(Vec<(String, Kv)>),
}

impl Kv {
    pub fn get(&self, key: &str) -> Option<&Kv> {
        match self {
            Kv::Obj(items) => items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            Kv::Str(_) => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Kv::Str(s) => Some(s),
            Kv::Obj(_) => None,
        }
    }
    pub fn entries(&self) -> &[(String, Kv)] {
        match self {
            Kv::Obj(items) => items,
            Kv::Str(_) => &[],
        }
    }
}

/// Parses KeyValues 1 text. Tolerant: unknown syntax ends the current object instead of failing.
pub fn parse_kv(text: &str) -> Kv {
    let tokens = tokenize(text);
    let mut pos = 0;
    Kv::Obj(parse_obj(&tokens, &mut pos, 0))
}

#[derive(Debug, PartialEq)]
enum Tok {
    S(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        match c {
            '{' => {
                chars.next();
                out.push(Tok::Open);
            }
            '}' => {
                chars.next();
                out.push(Tok::Close);
            }
            '"' => {
                chars.next();
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(o) => s.push(o),
                            None => break,
                        },
                        '"' => break,
                        o => s.push(o),
                    }
                }
                out.push(Tok::S(s));
            }
            '/' => {
                // `// comment`
                chars.next();
                if chars.peek() == Some(&'/') {
                    for c in chars.by_ref() {
                        if c == '\n' {
                            break;
                        }
                    }
                }
            }
            c if c.is_whitespace() => {
                chars.next();
            }
            _ => {
                let mut s = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || c == '{' || c == '}' || c == '"' {
                        break;
                    }
                    s.push(c);
                    chars.next();
                }
                out.push(Tok::S(s));
            }
        }
    }
    out
}

fn parse_obj(tokens: &[Tok], pos: &mut usize, depth: usize) -> Vec<(String, Kv)> {
    let mut items = Vec::new();
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Tok::Close => {
                *pos += 1;
                break;
            }
            Tok::Open => {
                // stray brace: skip the block
                *pos += 1;
                if depth < 64 {
                    parse_obj(tokens, pos, depth + 1);
                }
            }
            Tok::S(key) => {
                *pos += 1;
                match tokens.get(*pos) {
                    Some(Tok::S(v)) => {
                        *pos += 1;
                        items.push((key.clone(), Kv::Str(v.clone())));
                    }
                    Some(Tok::Open) => {
                        *pos += 1;
                        let child = if depth < 64 { parse_obj(tokens, pos, depth + 1) } else { Vec::new() };
                        items.push((key.clone(), Kv::Obj(child)));
                    }
                    _ => break,
                }
            }
        }
    }
    items
}

/// Candidate Steam root folders on this OS, most likely first (not checked for existence).
pub fn steam_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        out.extend(windows_registry_steam_paths());
        for var in ["ProgramFiles(x86)", "ProgramFiles"] {
            if let Some(p) = std::env::var_os(var) {
                out.push(PathBuf::from(p).join("Steam"));
            }
        }
        out.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
        out.push(PathBuf::from(r"C:\Program Files\Steam"));
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = home_dir() {
            out.push(home.join("Library/Application Support/Steam"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(home) = home_dir() {
            out.push(home.join(".steam/steam"));
            out.push(home.join(".steam/root"));
            out.push(home.join(".local/share/Steam"));
            out.push(home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
            out.push(home.join("snap/steam/common/.local/share/Steam"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

#[cfg(unix)]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(windows)]
fn windows_registry_steam_paths() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let mut out = Vec::new();
    if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam") {
        if let Ok(p) = k.get_value::<String, _>("SteamPath") {
            out.push(PathBuf::from(p.replace('/', "\\")));
        }
    }
    for sub in [r"SOFTWARE\WOW6432Node\Valve\Steam", r"SOFTWARE\Valve\Steam"] {
        if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(sub) {
            if let Ok(p) = k.get_value::<String, _>("InstallPath") {
                out.push(PathBuf::from(p));
            }
        }
    }
    // Direct CS2 uninstall entry (path of the game itself).
    if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 730") {
        if let Ok(p) = k.get_value::<String, _>("InstallLocation") {
            // ".../steamapps/common/Counter-Strike Global Offensive" -> library root
            let p = PathBuf::from(p);
            if let Some(lib) = p.parent().and_then(Path::parent).and_then(Path::parent) {
                out.push(lib.to_path_buf());
            }
        }
    }
    out
}

/// Library folders listed by a Steam root (`steamapps/libraryfolders.vdf`), with whether each
/// says it holds app 730. The root itself is always included.
pub fn library_folders(steam_root: &Path) -> Vec<(PathBuf, bool)> {
    let mut out = vec![(steam_root.to_path_buf(), false)];
    for vdf in [steam_root.join("steamapps/libraryfolders.vdf"), steam_root.join("config/libraryfolders.vdf")] {
        let Ok(text) = std::fs::read_to_string(&vdf) else { continue };
        let kv = parse_kv(&text);
        let Some(root) = kv.get("libraryfolders").or_else(|| kv.get("LibraryFolders")) else { continue };
        for (key, entry) in root.entries() {
            let (path, has) = match entry {
                // new format: "0" { "path" "..." "apps" { "730" "size" } }
                Kv::Obj(_) => (
                    entry.get("path").and_then(Kv::as_str).map(PathBuf::from),
                    entry.get("apps").is_some_and(|a| a.get(CS2_APP_ID).is_some()),
                ),
                // old format: "1" "D:\\SteamLibrary"
                Kv::Str(s) if key.chars().all(|c| c.is_ascii_digit()) => (Some(PathBuf::from(s)), false),
                Kv::Str(_) => (None, false),
            };
            if let Some(p) = path {
                if let Some(e) = out.iter_mut().find(|(q, _)| same_path(q, &p)) {
                    e.1 |= has;
                } else {
                    out.push((p, has));
                }
            }
        }
    }
    // libraries that claim CS2 first
    out.sort_by_key(|(_, has)| !*has);
    out
}

fn same_path(a: &Path, b: &Path) -> bool {
    let n = |p: &Path| p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
    n(a) == n(b)
}

/// `game/csgo` of a library folder, if CS2 is installed there.
pub fn csgo_dir_in_library(library: &Path) -> Option<PathBuf> {
    let mut names = vec![DEFAULT_INSTALL_DIR.to_string()];
    if let Ok(text) = std::fs::read_to_string(library.join("steamapps").join(format!("appmanifest_{CS2_APP_ID}.acf"))) {
        if let Some(d) = parse_kv(&text).get("AppState").and_then(|a| a.get("installdir")).and_then(Kv::as_str) {
            names.insert(0, d.to_string());
        }
    }
    names
        .into_iter()
        .map(|n| library.join("steamapps").join("common").join(n).join("game").join("csgo"))
        .find(|p| is_csgo_dir(p))
}

/// Whether `dir` looks like CS2's `game/csgo` content folder.
pub fn is_csgo_dir(dir: &Path) -> bool {
    dir.join("pak01_dir.vpk").is_file() || (dir.join("maps").is_dir() && dir.join("gameinfo.gi").is_file())
}

/// Accepts what a user may pick for "the CS2 folder" (the game folder, `game`, `game/csgo`, the
/// `maps` folder, a Steam library or Steam itself) and returns its `game/csgo`.
pub fn resolve_user_path(p: &Path) -> Option<PathBuf> {
    let candidates = [
        p.to_path_buf(),
        p.join("csgo"),
        p.join("game").join("csgo"),
        p.parent().map(Path::to_path_buf).unwrap_or_default(),
        p.join(DEFAULT_INSTALL_DIR).join("game").join("csgo"),
        p.join("common").join(DEFAULT_INSTALL_DIR).join("game").join("csgo"),
    ];
    if let Some(c) = candidates.iter().find(|c| !c.as_os_str().is_empty() && is_csgo_dir(c)) {
        return Some(c.clone());
    }
    // a Steam library or Steam root
    csgo_dir_in_library(p).or_else(|| library_folders(p).iter().find_map(|(l, _)| csgo_dir_in_library(l)))
}

/// Finds CS2's `game/csgo` automatically.
pub fn discover() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("REWIND_CS2_PATH") {
        if let Some(d) = resolve_user_path(Path::new(&p)) {
            return Some(d);
        }
    }
    for root in steam_roots() {
        if !root.is_dir() {
            continue;
        }
        for (lib, _) in library_folders(&root) {
            if let Some(d) = csgo_dir_in_library(&lib) {
                return Some(d);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_library_folders_new_and_old_format() {
        let new = r#"
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"1015498"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"apps"
		{
			"730"		"39812321233"
		}
	}
}"#;
        let kv = parse_kv(new);
        let lf = kv.get("libraryfolders").unwrap();
        assert_eq!(lf.entries().len(), 2);
        assert_eq!(lf.get("1").unwrap().get("path").unwrap().as_str(), Some("D:\\SteamLibrary"));
        assert!(lf.get("1").unwrap().get("apps").unwrap().get("730").is_some());

        let old = "\"LibraryFolders\" { \"TimeNextStatsReport\" \"1\" \"1\" \"E:\\\\Games\\\\Steam\" }";
        let kv = parse_kv(old);
        assert_eq!(kv.get("LibraryFolders").unwrap().get("1").unwrap().as_str(), Some("E:\\Games\\Steam"));
    }

    #[test]
    fn libraries_from_a_fake_steam_root() {
        let tmp = std::env::temp_dir().join(format!("rewind-steam-test-{}", std::process::id()));
        let lib2 = tmp.join("lib2");
        let csgo = lib2.join("steamapps/common/Counter-Strike Global Offensive/game/csgo");
        std::fs::create_dir_all(&csgo).unwrap();
        std::fs::create_dir_all(tmp.join("steam/steamapps")).unwrap();
        std::fs::write(csgo.join("pak01_dir.vpk"), b"x").unwrap();
        let vdf = format!(
            "\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" \"apps\" {{ \"730\" \"1\" }} }} }}",
            tmp.join("steam").to_string_lossy().replace('\\', "\\\\"),
            lib2.to_string_lossy().replace('\\', "\\\\")
        );
        std::fs::write(tmp.join("steam/steamapps/libraryfolders.vdf"), vdf).unwrap();
        let libs = library_folders(&tmp.join("steam"));
        assert!(libs[0].1, "library with 730 sorted first: {libs:?}");
        assert_eq!(csgo_dir_in_library(&libs[0].0).as_deref(), Some(csgo.as_path()));
        // user picks: the game folder, `game`, `game/csgo`, the Steam root
        let game = lib2.join("steamapps/common/Counter-Strike Global Offensive");
        for pick in [game.clone(), game.join("game"), csgo.clone(), tmp.join("steam"), csgo.join("maps")] {
            std::fs::create_dir_all(csgo.join("maps")).unwrap();
            assert_eq!(resolve_user_path(&pick).as_deref(), Some(csgo.as_path()), "pick {pick:?}");
        }
        assert_eq!(resolve_user_path(&tmp.join("nothing")), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn tolerant_on_garbage() {
        let kv = parse_kv("}}}{{ \"a\" { \"b\" ");
        let _ = kv.get("a");
        let kv = parse_kv("\"unterminated");
        assert!(kv.entries().len() <= 1);
    }
}
