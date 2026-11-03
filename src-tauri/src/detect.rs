//! Icon detection: zero-mean normalised cross-correlation (NCC) template matching
//! with a coarse-to-fine search, plus the HSV "gold ratio" colour test.

use crate::capture::Frame;

#[derive(Clone)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub d: Vec<f32>,
    /// origin of this image inside the full frame (for cropped regions)
    pub ox: usize,
    pub oy: usize,
}

impl Gray {
    pub fn from_frame(f: &Frame) -> Gray {
        let (w, h) = (f.w as usize, f.h as usize);
        let mut d = Vec::with_capacity(w * h);
        for px in f.rgba.chunks_exact(4) {
            d.push(0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32);
        }
        Gray { w, h, d, ox: 0, oy: 0 }
    }

    /// Grayscale of only a sub-rectangle of the frame (coordinates stay absolute via ox/oy).
    pub fn from_frame_region(f: &Frame, x: usize, y: usize, w: usize, h: usize) -> Gray {
        let x = x.min(f.w as usize);
        let y = y.min(f.h as usize);
        let w = w.min(f.w as usize - x);
        let h = h.min(f.h as usize - y);
        let mut d = Vec::with_capacity(w * h);
        for r in 0..h {
            let base = ((y + r) * f.w as usize + x) * 4;
            for c in 0..w {
                let px = &f.rgba[base + c * 4..base + c * 4 + 3];
                d.push(0.299 * px[0] as f32 + 0.587 * px[1] as f32 + 0.114 * px[2] as f32);
            }
        }
        Gray { w, h, d, ox: x, oy: y }
    }

    pub fn crop(&self, x: usize, y: usize, w: usize, h: usize) -> Gray {
        let x = x.min(self.w);
        let y = y.min(self.h);
        let w = w.min(self.w - x);
        let h = h.min(self.h - y);
        let mut d = Vec::with_capacity(w * h);
        for r in 0..h {
            let s = (y + r) * self.w + x;
            d.extend_from_slice(&self.d[s..s + w]);
        }
        Gray { w, h, d, ox: self.ox + x, oy: self.oy + y }
    }

    /// Box-filter (area average) resize; good for down-scaling, fine for mild up-scaling.
    pub fn resize(&self, nw: usize, nh: usize) -> Gray {
        let nw = nw.max(1);
        let nh = nh.max(1);
        if nw == self.w && nh == self.h {
            return self.clone();
        }
        let mut d = vec![0f32; nw * nh];
        let sx = self.w as f32 / nw as f32;
        let sy = self.h as f32 / nh as f32;
        for y in 0..nh {
            let y0f = y as f32 * sy;
            let y1f = ((y + 1) as f32 * sy).max(y0f + 1.0);
            let y0 = y0f.floor() as usize;
            let y1 = (y1f.ceil() as usize).min(self.h).max(y0 + 1);
            for x in 0..nw {
                let x0f = x as f32 * sx;
                let x1f = ((x + 1) as f32 * sx).max(x0f + 1.0);
                let x0 = x0f.floor() as usize;
                let x1 = (x1f.ceil() as usize).min(self.w).max(x0 + 1);
                let mut sum = 0f32;
                let mut n = 0f32;
                for yy in y0..y1.min(self.h) {
                    let row = yy * self.w;
                    for xx in x0..x1.min(self.w) {
                        sum += self.d[row + xx];
                        n += 1.0;
                    }
                }
                d[y * nw + x] = if n > 0.0 { sum / n } else { 0.0 };
            }
        }
        Gray { w: nw, h: nh, d, ox: self.ox, oy: self.oy }
    }
}

/// Decoded template: grayscale + optional alpha mask (alpha < 128 ignored).
#[derive(Clone)]
pub struct Template {
    pub rgb: Vec<[u8; 3]>,
    pub gray: Gray,
    pub mask: Option<Vec<bool>>,
}

impl Template {
    pub fn from_png(bytes: &[u8]) -> Result<Template, String> {
        let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?.to_rgba8();
        let (w, h) = (img.width() as usize, img.height() as usize);
        let mut d = Vec::with_capacity(w * h);
        let mut mask = Vec::with_capacity(w * h);
        let mut rgb = Vec::with_capacity(w * h);
        let mut any_transparent = false;
        for p in img.pixels() {
            d.push(0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32);
            rgb.push([p[0], p[1], p[2]]);
            let keep = p[3] >= 128;
            any_transparent |= !keep;
            mask.push(keep);
        }
        Ok(Template { rgb, gray: Gray { w, h, d, ox: 0, oy: 0 }, mask: if any_transparent { Some(mask) } else { None } })
    }

    fn scaled(&self, s: f32) -> Template {
        let nw = ((self.gray.w as f32 * s).round() as usize).max(4);
        let nh = ((self.gray.h as f32 * s).round() as usize).max(4);
        let gray = self.gray.resize(nw, nh);
        let mask = self.mask.as_ref().map(|m| {
            let mut out = vec![false; nw * nh];
            for y in 0..nh {
                for x in 0..nw {
                    let sx = (x * self.gray.w / nw).min(self.gray.w - 1);
                    let sy = (y * self.gray.h / nh).min(self.gray.h - 1);
                    out[y * nw + x] = m[sy * self.gray.w + sx];
                }
            }
            out
        });
        let mut rgb = Vec::with_capacity(nw * nh);
        for y in 0..nh {
            for x in 0..nw {
                rgb.push(self.rgb[(y * self.gray.h / nh).min(self.gray.h - 1) * self.gray.w + (x * self.gray.w / nw).min(self.gray.w - 1)]);
            }
        }
        Template { rgb, gray, mask }
    }
}

struct Integral {
    w: usize,
    sum: Vec<f64>,
    sq: Vec<f64>,
}

impl Integral {
    fn new(g: &Gray) -> Integral {
        let w1 = g.w + 1;
        let mut sum = vec![0f64; w1 * (g.h + 1)];
        let mut sq = vec![0f64; w1 * (g.h + 1)];
        for y in 0..g.h {
            let mut rs = 0f64;
            let mut rq = 0f64;
            for x in 0..g.w {
                let v = g.d[y * g.w + x] as f64;
                rs += v;
                rq += v * v;
                sum[(y + 1) * w1 + x + 1] = sum[y * w1 + x + 1] + rs;
                sq[(y + 1) * w1 + x + 1] = sq[y * w1 + x + 1] + rq;
            }
        }
        Integral { w: w1, sum, sq }
    }
    #[inline]
    fn rect(&self, x: usize, y: usize, w: usize, h: usize) -> (f64, f64) {
        let w1 = self.w;
        let a = y * w1 + x;
        let b = y * w1 + x + w;
        let c = (y + h) * w1 + x;
        let d = (y + h) * w1 + x + w;
        (
            self.sum[d] - self.sum[b] - self.sum[c] + self.sum[a],
            self.sq[d] - self.sq[b] - self.sq[c] + self.sq[a],
        )
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub score: f32,
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
    pub scale: f32,
}

/// Prepared template: zero-mean values (masked pixels = 0 and excluded).
struct Prepared {
    w: usize,
    h: usize,
    zm: Vec<f32>,
    energy: f64,
    n: usize,
    unmasked: bool,
    mask: Option<Vec<bool>>,
}

fn prepare(t: &Template) -> Option<Prepared> {
    let (w, h) = (t.gray.w, t.gray.h);
    let n_all = w * h;
    let (mut sum, mut cnt) = (0f64, 0usize);
    for i in 0..n_all {
        if t.mask.as_ref().map_or(true, |m| m[i]) {
            sum += t.gray.d[i] as f64;
            cnt += 1;
        }
    }
    if cnt < 16 {
        return None;
    }
    let mean = (sum / cnt as f64) as f32;
    let mut zm = vec![0f32; n_all];
    let mut energy = 0f64;
    for i in 0..n_all {
        if t.mask.as_ref().map_or(true, |m| m[i]) {
            let v = t.gray.d[i] - mean;
            zm[i] = v;
            energy += (v * v) as f64;
        }
    }
    if energy < 1e-3 {
        return None; // flat template, NCC undefined
    }
    Some(Prepared { w, h, zm, energy, n: cnt, unmasked: t.mask.is_none(), mask: t.mask.clone() })
}

/// Best NCC over positions x in [x0,x1], y in [y0,y1] (top-left coordinates inside `img`).
fn best_in(
    img: &Gray,
    integ: &Integral,
    p: &Prepared,
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
) -> (f32, usize, usize) {
    let mut best = (-2f32, 0usize, 0usize);
    if img.w < p.w || img.h < p.h {
        return best;
    }
    let x1 = x1.min(img.w - p.w);
    let y1 = y1.min(img.h - p.h);
    if x0 > x1 || y0 > y1 {
        return best;
    }
    let n = p.n as f64;
    for y in y0..=y1 {
        for x in x0..=x1 {
            // dot with zero-mean template (== dot with centred window since template sums to 0)
            let mut dot = 0f32;
            for ty in 0..p.h {
                let irow = (y + ty) * img.w + x;
                let trow = ty * p.w;
                for tx in 0..p.w {
                    dot += img.d[irow + tx] * p.zm[trow + tx];
                }
            }
            let (s, sq) = if p.unmasked {
                integ.rect(x, y, p.w, p.h)
            } else {
                // masked: compute directly
                let (mut s, mut sq) = (0f64, 0f64);
                for ty in 0..p.h {
                    for tx in 0..p.w {
                        if p.mask.as_ref().map_or(true, |m| m[ty * p.w + tx]) {
                            let v = img.d[(y + ty) * img.w + x + tx] as f64;
                            s += v;
                            sq += v * v;
                        }
                    }
                }
                (s, sq)
            };
            let var = sq - s * s / n;
            if var < 1.0 {
                continue; // flat patch
            }
            let score = (dot as f64 / (var * p.energy).sqrt()) as f32;
            if score > best.0 {
                best = (score, x, y);
            }
        }
    }
    best
}

/// Search `region` (x,y,w,h in frame pixels) with template at several scales.
/// `scales` are absolute multipliers applied to the template's native size.
pub fn search(frame: &Gray, region: (usize, usize, usize, usize), tpl: &Template, scales: &[f32]) -> Option<Hit> {
    let (rx, ry, rw, rh) = region;
    // clip the absolute region to what this (possibly cropped) gray image covers
    let cx0 = rx.max(frame.ox);
    let cy0 = ry.max(frame.oy);
    let cx1 = (rx + rw).min(frame.ox + frame.w);
    let cy1 = (ry + rh).min(frame.oy + frame.h);
    if cx1 <= cx0 || cy1 <= cy0 {
        return None;
    }
    let (rx, ry, rw, rh) = (cx0, cy0, cx1 - cx0, cy1 - cy0);
    let sub = frame.crop(rx - frame.ox, ry - frame.oy, rw, rh);
    let mut best: Option<Hit> = None;
    for &s in scales {
        let st = tpl.scaled(s);
        let (tw, th) = (st.gray.w, st.gray.h);
        if tw >= sub.w || th >= sub.h {
            continue;
        }
        let Some(p_full) = prepare(&st) else { continue };
        // coarse level
        let f = (tw.min(th) / 10).clamp(1, 4);
        let (cx, cy, hit_coarse);
        if f > 1 {
            let cs = sub.resize(sub.w / f, sub.h / f);
            let ct = st.gray.resize((tw / f).max(4), (th / f).max(4));
            let cmask = st.mask.as_ref().map(|m| {
                let (nw, nh) = (ct.w, ct.h);
                let mut out = vec![false; nw * nh];
                for y in 0..nh {
                    for x in 0..nw {
                        out[y * nw + x] = m[(y * f).min(th - 1) * tw + (x * f).min(tw - 1)];
                    }
                }
                out
            });
            let Some(pc) = prepare(&Template { rgb: vec![], gray: ct, mask: cmask }) else { continue };
            let ci = Integral::new(&cs);
            let (sc, bx, by) = best_in(&cs, &ci, &pc, 0, usize::MAX, 0, usize::MAX);
            if sc < 0.35 {
                continue; // nothing plausible at this scale
            }
            cx = bx * f;
            cy = by * f;
            hit_coarse = sc;
        } else {
            cx = 0;
            cy = 0;
            hit_coarse = 0.0;
        }
        let _ = hit_coarse;
        // fine level
        let fi = Integral::new(&sub);
        let (x0, x1, y0, y1) = if f > 1 {
            (cx.saturating_sub(f + 1), cx + f + 1, cy.saturating_sub(f + 1), cy + f + 1)
        } else {
            (0, usize::MAX, 0, usize::MAX)
        };
        let (sc, bx, by) = best_in(&sub, &fi, &p_full, x0, x1, y0, y1);
        if sc > best.map_or(-2.0, |h| h.score) {
            best = Some(Hit { score: sc, x: rx + bx, y: ry + by, w: tw, h: th, scale: s });
        }
    }
    best
}

/// Fraction of pixels in the rect (x,y,w,h pixels) inside the gold HSV band.
pub fn gold_ratio(f: &Frame, rect: (usize, usize, usize, usize), hue: (f32, f32), sat_min: f32, val_min: f32) -> f32 {
    let (x, y, w, h) = rect;
    let x1 = (x + w).min(f.w as usize);
    let y1 = (y + h).min(f.h as usize);
    let (mut hit, mut tot) = (0u32, 0u32);
    for yy in y..y1 {
        for xx in x..x1 {
            let i = (yy * f.w as usize + xx) * 4;
            let (r, g, b) = (f.rgba[i] as f32 / 255.0, f.rgba[i + 1] as f32 / 255.0, f.rgba[i + 2] as f32 / 255.0);
            let mx = r.max(g).max(b);
            let mn = r.min(g).min(b);
            let d = mx - mn;
            let v = mx;
            let s = if mx > 0.0 { d / mx } else { 0.0 };
            let hh = if d == 0.0 {
                0.0
            } else if mx == r {
                60.0 * (((g - b) / d).rem_euclid(6.0))
            } else if mx == g {
                60.0 * ((b - r) / d + 2.0)
            } else {
                60.0 * ((r - g) / d + 4.0)
            };
            tot += 1;
            if hh >= hue.0 && hh <= hue.1 && s >= sat_min && v >= val_min {
                hit += 1;
            }
        }
    }
    if tot == 0 {
        0.0
    } else {
        hit as f32 / tot as f32
    }
}

impl Template {
    /// Mean colour distance (0..1) between the template (scaled to the hit size) and the frame at `hit`.
    /// Grayscale NCC cannot tell two same-shaped icons of different colour apart; this can.
    pub fn colour_diff(&self, f: &Frame, hit: &Hit) -> f32 {
        let st = self.scaled(hit.scale);
        let (mut sum, mut n) = (0f32, 0f32);
        for y in 0..st.gray.h {
            for x in 0..st.gray.w {
                if st.mask.as_ref().map_or(false, |m| !m[y * st.gray.w + x]) {
                    continue;
                }
                let (fx, fy) = (hit.x + x, hit.y + y);
                if fx >= f.w as usize || fy >= f.h as usize {
                    continue;
                }
                let i = (fy * f.w as usize + fx) * 4;
                let t = st.rgb[y * st.gray.w + x];
                for c in 0..3 {
                    sum += (f.rgba[i + c] as f32 - t[c] as f32).abs();
                }
                n += 3.0;
            }
        }
        if n == 0.0 { 1.0 } else { sum / n / 255.0 }
    }
}
