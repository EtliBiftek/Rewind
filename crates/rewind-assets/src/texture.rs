//! Converting `vtex_c` colour textures to what the glTF carries: KTX2 with BC1/BC3 blocks (stays
//! compressed on the GPU) or PNG/JPEG (portable fallback), downscaled to the quality's size.

use heatel::texture::{Encoding, PixelFormat};
use heatel::Texture;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TexFormat {
    /// KTX2 with BC1/BC3 blocks (`KHR_texture_basisu` image, decoded by three's KTX2Loader without a transcoder).
    Ktx2,
    /// PNG (with alpha) / JPEG (opaque).
    Image,
}

pub struct EncodedTexture {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Estimated GPU memory incl. mips.
    pub gpu_bytes: usize,
    pub has_alpha: bool,
}

/// Number of top levels to drop so the largest side is at most `max`.
fn levels_to_drop(w: u32, h: u32, max: u32) -> usize {
    let mut n = 0;
    let mut s = w.max(h);
    while s > max && s > 4 {
        s /= 2;
        n += 1;
    }
    n
}

/// Converts a parsed vtex. `need_alpha`: the material uses the alpha channel (alpha test/blend).
pub fn encode(tex: &Texture, max_size: u32, need_alpha: bool, fmt: TexFormat, jpeg_quality: u8) -> Result<EncodedTexture, String> {
    let tex = if tex.is_sheet() { tex.first_frame() } else { tex.clone() };
    let drop = levels_to_drop(tex.width(), tex.height(), max_size);
    match fmt {
        TexFormat::Ktx2 => encode_ktx2(&tex, drop, max_size, need_alpha),
        TexFormat::Image => {
            let (w, h, px) = level_pixels(&tex, drop, max_size)?;
            encode_image(w, h, &px, need_alpha, jpeg_quality)
        }
    }
}

/// RGBA8 pixels of the level closest to `max` (decoding only that level), resized if the texture
/// has no suitable level.
fn level_pixels(tex: &Texture, drop: usize, max: u32) -> Result<(u32, u32, Vec<u8>), String> {
    let level = drop.min(tex.mips().len() - 1);
    let (w, h) = ((tex.width() >> level).max(1), (tex.height() >> level).max(1));
    let px = tex.level_rgba8(level).map_err(|e| e.to_string())?;
    if w.max(h) <= max {
        return Ok((w, h, px));
    }
    // single-level texture larger than wanted: halve with a box filter
    let (mut w, mut h, mut px) = (w, h, px);
    while w.max(h) > max && w > 1 && h > 1 {
        let (nw, nh) = (w / 2, h / 2);
        let mut out = vec![0u8; (nw * nh * 4) as usize];
        for y in 0..nh as usize {
            for x in 0..nw as usize {
                for c in 0..4 {
                    let s = |dx: usize, dy: usize| px[((2 * y + dy) * w as usize + 2 * x + dx) * 4 + c] as u32;
                    out[(y * nw as usize + x) * 4 + c] = ((s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1) + 2) / 4) as u8;
                }
            }
        }
        (w, h, px) = (nw, nh, out);
    }
    Ok((w, h, px))
}

fn bytes_with_mips(w: u32, h: u32, bytes_per_block: usize, block: u32) -> usize {
    let (mut w, mut h, mut total) = (w, h, 0usize);
    loop {
        total += (w.div_ceil(block) * h.div_ceil(block)) as usize * bytes_per_block;
        if w <= 1 && h <= 1 {
            break;
        }
        w = (w / 2).max(1);
        h = (h / 2).max(1);
    }
    total
}

fn encode_ktx2(tex: &Texture, drop: usize, max: u32, need_alpha: bool) -> Result<EncodedTexture, String> {
    let small = tex.without_top_levels(drop);
    let whole_blocks = small.width().is_multiple_of(4) && small.height().is_multiple_of(4);
    let out = match small.format() {
        PixelFormat::Bc1 if whole_blocks && small.width().max(small.height()) <= max => small,
        PixelFormat::Bc3 if whole_blocks && small.width().max(small.height()) <= max => {
            if need_alpha {
                small
            } else {
                small.bc3_colour_as_bc1().map_err(|e| e.to_string())?
            }
        }
        _ => {
            // BC7, plain, ETC... : decode one level and compress to BC1/BC3
            let (mut w, mut h, mut px) = level_pixels(tex, drop, max)?;
            if w % 4 != 0 || h % 4 != 0 {
                // pad to whole blocks by edge replication
                let (nw, nh) = (w.div_ceil(4) * 4, h.div_ceil(4) * 4);
                let mut out = vec![0u8; (nw * nh * 4) as usize];
                for y in 0..nh {
                    for x in 0..nw {
                        let (sx, sy) = (x.min(w - 1), y.min(h - 1));
                        let s = ((sy * w + sx) * 4) as usize;
                        let d = ((y * nw + x) * 4) as usize;
                        out[d..d + 4].copy_from_slice(&px[s..s + 4]);
                    }
                }
                (w, h, px) = (nw, nh, out);
            }
            let rgba = Texture::from_rgba8(w, h, px).map_err(|e| e.to_string())?.with_mips(Encoding::Srgb);
            let target = if need_alpha { PixelFormat::Bc3 } else { PixelFormat::Bc1 };
            rgba.compressed(target, Encoding::Srgb).map_err(|e| e.to_string())?
        }
    };
    let bpb = if out.format() == PixelFormat::Bc1 { 8 } else { 16 };
    let gpu = bytes_with_mips(out.width(), out.height(), bpb, 4);
    let has_alpha = out.format() == PixelFormat::Bc3 || (need_alpha && out.format() == PixelFormat::Bc1);
    Ok(EncodedTexture { mime: "image/ktx2", bytes: out.to_ktx2(Encoding::Srgb), width: out.width(), height: out.height(), gpu_bytes: gpu, has_alpha })
}

fn encode_image(w: u32, h: u32, px: &[u8], need_alpha: bool, jpeg_quality: u8) -> Result<EncodedTexture, String> {
    let gpu = bytes_with_mips(w, h, 4, 1);
    if need_alpha {
        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.set_compression(png::Compression::Fast);
            let mut wr = enc.write_header().map_err(|e| e.to_string())?;
            wr.write_image_data(px).map_err(|e| e.to_string())?;
        }
        Ok(EncodedTexture { mime: "image/png", bytes: out, width: w, height: h, gpu_bytes: gpu, has_alpha: true })
    } else {
        let rgb: Vec<u8> = px.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        let mut out = Vec::new();
        let enc = jpeg_encoder::Encoder::new(&mut out, jpeg_quality);
        enc.encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb).map_err(|e| e.to_string())?;
        Ok(EncodedTexture { mime: "image/jpeg", bytes: out, width: w, height: h, gpu_bytes: gpu, has_alpha: false })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drop_levels() {
        assert_eq!(levels_to_drop(2048, 2048, 512), 2);
        assert_eq!(levels_to_drop(512, 256, 512), 0);
        assert_eq!(levels_to_drop(4096, 1024, 1024), 2);
    }
    #[test]
    fn mip_bytes() {
        assert_eq!(bytes_with_mips(4, 4, 8, 4), 8 * 3);
        assert_eq!(bytes_with_mips(1, 1, 4, 1), 4);
    }
    #[test]
    fn synthetic_rgba_to_both_formats() {
        let (w, h) = (64u32, 32u32);
        let px: Vec<u8> = (0..w * h).flat_map(|i| [(i % 251) as u8, (i / 7 % 256) as u8, 40, if i % 3 == 0 { 0 } else { 255 }]).collect();
        let t = Texture::from_rgba8(w, h, px).unwrap();
        let k = encode(&t, 32, true, TexFormat::Ktx2, 85).unwrap();
        assert_eq!(&k.bytes[..12], b"\xABKTX 20\xBB\r\n\x1A\n");
        assert_eq!((k.width, k.height), (32, 16));
        assert!(k.has_alpha);
        let j = encode(&t, 1024, false, TexFormat::Image, 85).unwrap();
        assert_eq!(j.mime, "image/jpeg");
        let p = encode(&t, 1024, true, TexFormat::Image, 85).unwrap();
        assert_eq!(&p.bytes[1..4], b"PNG");
    }
}
