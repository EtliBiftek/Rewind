//! A minimal binary glTF 2.0 writer: one buffer, accessors with bounds, meshes of one primitive
//! per node, materials, textures (PNG/JPEG or KTX2 through `KHR_texture_basisu`).

use serde_json::{json, Value};

pub struct GlbBuilder {
    pub bin: Vec<u8>,
    pub buffer_views: Vec<Value>,
    pub accessors: Vec<Value>,
    pub meshes: Vec<Value>,
    pub nodes: Vec<Value>,
    pub materials: Vec<Value>,
    pub textures: Vec<Value>,
    pub images: Vec<Value>,
    pub samplers: Vec<Value>,
    pub extensions_used: Vec<String>,
    pub extensions_required: Vec<String>,
}

pub const ARRAY_BUFFER: u32 = 34962;
pub const ELEMENT_ARRAY_BUFFER: u32 = 34963;
pub const FLOAT: u32 = 5126;
pub const BYTE: u32 = 5120;
pub const UNSIGNED_BYTE: u32 = 5121;
pub const UNSIGNED_SHORT: u32 = 5123;
pub const UNSIGNED_INT: u32 = 5125;

impl Default for GlbBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl GlbBuilder {
    pub fn new() -> Self {
        Self {
            bin: Vec::new(),
            buffer_views: Vec::new(),
            accessors: Vec::new(),
            meshes: Vec::new(),
            nodes: Vec::new(),
            materials: Vec::new(),
            textures: Vec::new(),
            images: Vec::new(),
            samplers: Vec::new(),
            extensions_used: Vec::new(),
            extensions_required: Vec::new(),
        }
    }

    pub fn use_extension(&mut self, name: &str, required: bool) {
        if !self.extensions_used.iter().any(|e| e == name) {
            self.extensions_used.push(name.to_string());
        }
        if required && !self.extensions_required.iter().any(|e| e == name) {
            self.extensions_required.push(name.to_string());
        }
    }

    /// Appends bytes as a buffer view (4-byte aligned); returns its index.
    pub fn view(&mut self, bytes: &[u8], target: Option<u32>, stride: Option<usize>) -> usize {
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        let offset = self.bin.len();
        self.bin.extend_from_slice(bytes);
        let mut v = json!({ "buffer": 0, "byteOffset": offset, "byteLength": bytes.len() });
        if let Some(t) = target {
            v["target"] = json!(t);
        }
        if let Some(s) = stride {
            v["byteStride"] = json!(s);
        }
        self.buffer_views.push(v);
        self.buffer_views.len() - 1
    }

    #[allow(clippy::too_many_arguments)]
    pub fn accessor(&mut self, view: usize, component: u32, count: usize, kind: &str, normalized: bool, min: Option<Value>, max: Option<Value>) -> usize {
        let mut a = json!({ "bufferView": view, "componentType": component, "count": count, "type": kind });
        if normalized {
            a["normalized"] = json!(true);
        }
        if let Some(m) = min {
            a["min"] = m;
        }
        if let Some(m) = max {
            a["max"] = m;
        }
        self.accessors.push(a);
        self.accessors.len() - 1
    }

    pub fn image(&mut self, bytes: &[u8], mime: &str) -> usize {
        let v = self.view(bytes, None, None);
        self.images.push(json!({ "bufferView": v, "mimeType": mime }));
        self.images.len() - 1
    }

    pub fn finish(mut self, scene_extras: Value, generator: &str) -> Vec<u8> {
        let node_ids: Vec<usize> = (0..self.nodes.len()).collect();
        while !self.bin.len().is_multiple_of(4) {
            self.bin.push(0);
        }
        let mut doc = json!({
            "asset": { "version": "2.0", "generator": generator },
            "scene": 0,
            "scenes": [ { "name": "map", "nodes": node_ids, "extras": scene_extras } ],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.buffer_views,
            "buffers": [ { "byteLength": self.bin.len() } ],
        });
        if !self.materials.is_empty() {
            doc["materials"] = json!(self.materials);
        }
        if !self.textures.is_empty() {
            doc["textures"] = json!(self.textures);
            doc["images"] = json!(self.images);
            doc["samplers"] = json!(self.samplers);
        }
        if !self.extensions_used.is_empty() {
            doc["extensionsUsed"] = json!(self.extensions_used);
        }
        if !self.extensions_required.is_empty() {
            doc["extensionsRequired"] = json!(self.extensions_required);
        }
        let mut js = serde_json::to_vec(&doc).unwrap_or_default();
        while !js.len().is_multiple_of(4) {
            js.push(b' ');
        }
        let total = 12 + 8 + js.len() + 8 + self.bin.len();
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(js.len() as u32).to_le_bytes());
        out.extend_from_slice(b"JSON");
        out.extend_from_slice(&js);
        out.extend_from_slice(&(self.bin.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&self.bin);
        out
    }
}

/// Splits a GLB into its JSON document and binary chunk (for tests and the CLI's `map-info`).
pub fn parse(glb: &[u8]) -> Option<(Value, &[u8])> {
    if glb.len() < 20 || &glb[0..4] != b"glTF" {
        return None;
    }
    let jl = u32::from_le_bytes(glb[12..16].try_into().ok()?) as usize;
    let js = glb.get(20..20 + jl)?;
    let doc: Value = serde_json::from_slice(js).ok()?;
    let rest = glb.get(20 + jl..)?;
    let bin = if rest.len() >= 8 {
        let bl = u32::from_le_bytes(rest[0..4].try_into().ok()?) as usize;
        rest.get(8..8 + bl)?
    } else {
        &[]
    };
    Some((doc, bin))
}
