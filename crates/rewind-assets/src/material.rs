//! CS2 material (`vmat_c`) interpretation for a simple PBR-ish renderer: base colour texture,
//! tint, alpha mode, sidedness, overlay/decal and "do not draw" decisions.
//!
//! The shader/flag rules follow Source 2 Viewer's `ShaderDataProvider` (ValveResourceFormat, MIT).

use heatel::material::Material;
use heatel::Resource;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AlphaMode {
    Opaque,
    Mask,
    Blend,
}

#[derive(Debug, Clone)]
pub struct MatInfo {
    pub path: String,
    pub shader: String,
    /// Base colour texture (`.vtex` path without `_c`).
    pub color: Option<String>,
    /// Linear RGB multiplier and opacity.
    pub tint: [f32; 4],
    pub alpha: AlphaMode,
    pub alpha_cutoff: f32,
    pub double_sided: bool,
    /// Decal-like surface drawn on top of other geometry (needs depth offset).
    pub overlay: bool,
    /// Not drawn at all (tools, sky geometry, effects).
    pub skip: bool,
    /// Additive blending.
    pub additive: bool,
    /// Water / glass get a fixed look in the viewer.
    pub kind: &'static str,
    pub roughness: f32,
    pub metalness: f32,
}

impl MatInfo {
    pub fn missing(path: &str) -> Self {
        Self {
            path: path.to_string(),
            shader: String::new(),
            color: None,
            tint: [0.6, 0.6, 0.6, 1.0],
            alpha: AlphaMode::Opaque,
            alpha_cutoff: 0.5,
            double_sided: false,
            overlay: false,
            skip: is_tools_path(path),
            additive: false,
            kind: "missing",
            roughness: 0.9,
            metalness: 0.0,
        }
    }
}

fn is_tools_path(p: &str) -> bool {
    let p = p.to_ascii_lowercase().replace('\\', "/");
    p.starts_with("materials/tools/") || p.contains("/toolsnodraw") || p.contains("/toolsskybox") || p.contains("/toolsclip") || p.contains("/toolsplayerclip") || p.contains("/toolstrigger")
}

/// sRGB (gamma) to linear for one channel.
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

const COLOR_PARAMS: [&str; 8] = ["g_tColor", "g_tColor1", "g_tColorA", "g_tLayer1Color", "g_tColor0", "g_tAlbedo", "g_tBaseColor", "g_tColorB"];

pub fn interpret(path: &str, bytes: &[u8]) -> MatInfo {
    let Ok(res) = Resource::parse(bytes) else { return MatInfo::missing(path) };
    let Some(Ok(data)) = res.data() else { return MatInfo::missing(path) };
    let Ok(m) = Material::from_vmat(path, &data) else { return MatInfo::missing(path) };
    from_material(path, &m)
}

pub fn from_material(path: &str, m: &Material) -> MatInfo {
    let shader = m.shader.trim_end_matches(".vfx").rsplit(['/', '\\']).next().unwrap_or("").to_ascii_lowercase();
    let int = |k: &str| m.int(k);
    let tex = |k: &str| m.textures.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let mut color = COLOR_PARAMS.iter().find_map(|k| tex(k));
    if color.is_none() {
        color = m
            .textures
            .iter()
            .find(|(n, _)| {
                let n = n.to_ascii_lowercase();
                n.contains("color") && !n.contains("tint") && !n.contains("mask") && !n.contains("warp")
            })
            .map(|(_, v)| v.clone());
    }
    // engine placeholder textures carry no information
    if color.as_deref().is_some_and(|c| c.contains("default_color") || c.contains("materials/default/default")) {
        color = None;
    }
    let tint_v = m.vector("g_vColorTint").or_else(|| m.vector("g_vColorTint1")).unwrap_or([1.0, 1.0, 1.0, 1.0]);
    let mut tint = [srgb_to_linear(tint_v[0].clamp(0.0, 4.0)), srgb_to_linear(tint_v[1].clamp(0.0, 4.0)), srgb_to_linear(tint_v[2].clamp(0.0, 4.0)), 1.0];
    let blend_mode = if shader.ends_with("static_overlay") || shader == "csgo_unlitgeneric" { int("F_BLEND_MODE") } else { 0 };
    let translucent_shader = matches!(shader.as_str(), "csgo_glass" | "csgo_effects" | "vr_glass");
    let mut alpha = AlphaMode::Opaque;
    let mut additive = int("F_ADDITIVE_BLEND") == 1 || blend_mode == 4;
    if int("F_TRANSLUCENT") == 1 || additive || (blend_mode > 0 && blend_mode != 2) || translucent_shader {
        alpha = AlphaMode::Blend;
    } else if int("F_ALPHA_TEST") > 0 || blend_mode == 2 || shader == "csgo_foliage" {
        alpha = AlphaMode::Mask;
    }
    let mut kind = "default";
    if shader.contains("water") {
        alpha = AlphaMode::Blend;
        kind = "water";
    } else if shader == "csgo_glass" {
        kind = "glass";
    }
    if alpha == AlphaMode::Blend {
        tint[3] = m.float("g_flOpacityScale").unwrap_or(1.0).clamp(0.0, 1.0);
        if kind == "water" {
            tint[3] = tint[3].min(0.75);
        }
        if kind == "glass" {
            tint[3] = tint[3].min(0.35);
        }
    }
    let alpha_cutoff = m.float("g_flAlphaTestReference").unwrap_or(0.5).clamp(0.05, 0.95);
    let overlay = int("F_OVERLAY") == 1
        || shader.ends_with("static_overlay")
        || shader == "csgo_decalmodulate"
        || (alpha == AlphaMode::Blend && (int("F_DEPTHBIAS") == 1 || int("F_DEPTH_BIAS") == 1));
    // multiplicative decals and engine-only shaders cannot be approximated with standard materials
    let skip = is_tools_path(path)
        || shader.starts_with("tools_")
        || shader.contains("sky")
        || matches!(shader.as_str(), "csgo_decalmodulate" | "spritecard" | "csgo_effects" | "projected_decals" | "error" | "csgo_lightmappedgeneric_tools")
        || blend_mode == 3
        || blend_mode == 5
        || blend_mode == 6;
    if additive && alpha != AlphaMode::Blend {
        additive = false;
    }
    let double_sided = int("F_RENDER_BACKFACES") == 1 || shader == "csgo_foliage" || alpha == AlphaMode::Mask;
    let metalness = m.float("g_flMetalness").unwrap_or(0.0).clamp(0.0, 1.0);
    let roughness = m.float("g_flRoughnessScaleFactor").map(|r| (0.75 * r).clamp(0.35, 1.0)).unwrap_or(0.85);
    MatInfo { path: path.to_string(), shader, color, tint, alpha, alpha_cutoff, double_sided, overlay, skip, additive, kind, roughness, metalness }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn srgb() {
        assert!((srgb_to_linear(1.0) - 1.0).abs() < 1e-6);
        assert!((srgb_to_linear(0.5) - 0.214).abs() < 1e-3);
    }
    #[test]
    fn tools_are_skipped() {
        assert!(MatInfo::missing("materials/tools/toolsnodraw.vmat").skip);
        assert!(!MatInfo::missing("materials/de_mirage/wall.vmat").skip);
    }
}
