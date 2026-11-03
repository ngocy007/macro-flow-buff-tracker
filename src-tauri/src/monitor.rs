//! Monitor loop: capture -> detect -> per-buff timeline -> overlay / sounds / events.
//!
//! Cost model (so that adding buffs stays cheap):
//!  * one window capture per tick, shared by every buff;
//!  * grayscale is computed only for the union of the buffs' search regions;
//!  * a buff that is locked (visible) only does a tiny local re-check around its last position;
//!  * a buff in cooldown is re-scanned slowly (it cannot reappear before the cooldown ends) and
//!    only scanned at full rate shortly before it is due, or when it has never been seen.

use crate::capture;
use crate::detect::{self, Gray, Hit, Template};
use crate::Shared;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn num(v: &Value, k: &str, d: f64) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(d)
}
fn flag(v: &Value, k: &str, d: bool) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(d)
}
fn rect4(v: &Value, k: &str) -> Option<[f32; 4]> {
    let a = v.get(k)?.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let mut o = [0f32; 4];
    for i in 0..4 {
        o[i] = a[i].as_f64()? as f32;
    }
    Some(o)
}

struct Icon {
    name: String,
    group: Option<String>,
    tpl: Option<Template>,
    match_thr: f32,
    rect: [f32; 4],
    search: Option<[f32; 4]>,
    hue: (f32, f32),
    sat: f32,
    val: f32,
    gold_thr: f32,
    cycle: u64,
    duration: u64,
    /// window height the template was captured at (0 = use target.referenceHeight)
    ref_h: f32,
    prewarn: bool,
    ready_sound: Option<Value>,
    // runtime
    present_cnt: u32,
    miss_cnt: u32,
    active: bool,
    seen: bool,
    trigger_at: Option<u64>,
    first_present: Option<u64>,
    expected: Option<u64>,
    prewarned: [bool; 6],
    ready_played: bool,
    last_hit: Option<Hit>,
    last_scan: u64,
    score: f32,
    present: bool,
    /// last tick the icon was seen (for measuring how long the buff really stays on screen)
    last_seen: u64,
    /// last measured on-screen time of a finished run, ms
    observed: Option<u64>,
}

fn build_icons(cfg: &Value) -> Vec<Icon> {
    let chaoguang_player = cfg["buffGroup"].get("chaoguangPlayer").and_then(|x| x.as_bool()).unwrap_or(true);
    let Some(arr) = cfg["buffGroup"].get("icons").and_then(|x| x.as_array()) else {
        return vec![];
    };
    let mut out = vec![];
    for ic in arr {
        if !flag(ic, "enabled", true) {
            continue;
        }
        if flag(ic, "chaoguangOnly", false) && !chaoguang_player {
            continue;
        }
        let tpl = ic
            .get("iconTemplate")
            .and_then(|x| x.as_str())
            .and_then(|s| {
                let s = s.split(',').last().unwrap_or(s);
                base64::engine::general_purpose::STANDARD.decode(s.trim()).ok()
            })
            .and_then(|b| Template::from_png(&b).ok());
        out.push(Icon {
            name: ic.get("name").and_then(|x| x.as_str()).unwrap_or("?").to_string(),
            group: ic.get("sharedCdGroup").and_then(|x| x.as_str()).map(|s| s.to_string()),
            tpl,
            match_thr: num(ic, "matchThreshold", 0.9) as f32,
            rect: rect4(ic, "iconRect").unwrap_or([0.0, 0.0, 0.03, 0.03]),
            search: rect4(ic, "searchRect"),
            hue: (num(ic, "hueMin", 30.0) as f32, num(ic, "hueMax", 55.0) as f32),
            sat: num(ic, "saturationMin", 0.3) as f32,
            val: num(ic, "valueMin", 0.5) as f32,
            gold_thr: num(ic, "goldRatioThreshold", 0.15) as f32,
            cycle: num(ic, "cycleMs", 20000.0) as u64,
            duration: num(ic, "durationMs", 4000.0) as u64,
            ref_h: num(ic, "templateRefHeight", 0.0) as f32,
            prewarn: flag(ic, "prewarnEnabled", true),
            ready_sound: ic
                .get("cdEndSound")
                .filter(|v| !v.is_null())
                .or_else(|| ic.get("triggerSound").filter(|v| !v.is_null()))
                .cloned(),
            present_cnt: 0,
            miss_cnt: 0,
            active: false,
            seen: false,
            trigger_at: None,
            first_present: None,
            expected: None,
            prewarned: [false; 6],
            ready_played: false,
            last_hit: None,
            last_scan: 0,
            score: 0.0,
            present: false,
            last_seen: 0,
            observed: None,
        });
    }
    out
}

fn search_region(cfg: &Value, ic: &Icon, fw: usize, fh: usize) -> (usize, usize, usize, usize) {
    let r: Option<[f32; 4]> = ic.search.or_else(|| {
        let s = cfg.get("searchRegion")?;
        if s.is_null() {
            return None;
        }
        Some([num(s, "x", 0.0) as f32, num(s, "y", 0.0) as f32, num(s, "width", 1.0) as f32, num(s, "height", 1.0) as f32])
    });
    let r = r.unwrap_or([0.0, 0.0, 1.0, 1.0]);
    let x = (r[0].clamp(0.0, 1.0) * fw as f32) as usize;
    let y = (r[1].clamp(0.0, 1.0) * fh as f32) as usize;
    let w = ((r[2].clamp(0.0, 1.0) * fw as f32) as usize).min(fw.saturating_sub(x));
    let h = ((r[3].clamp(0.0, 1.0) * fh as f32) as usize).min(fh.saturating_sub(y));
    (x, y, w.max(1), h.max(1))
}

/// How often (ms) this icon needs a *full-region* scan right now. None = never (locked).
fn scan_interval(ic: &Icon, now: u64) -> Option<u64> {
    if ic.active {
        // Locked buffs normally match in the cheap local check. If that fails (e.g. the buff list scrolled
        // up by a row), search the whole region at once instead of waiting and counting it as gone.
        return Some(150);
    }
    match ic.expected {
        Some(e) => {
            let rem = e as i64 - now as i64;
            if rem > 3500 {
                Some(1000) // still cooling down: only a slow safety net
            } else {
                Some(150)
            }
        }
        None => Some(150), // never seen yet
    }
}

fn detect_icon(cfg: &Value, ic: &mut Icon, gray: &Gray, frame: &capture::Frame, scale0: f32, now: u64) -> bool {
    let (fw, fh) = (frame.w as usize, frame.h as usize);
    if let Some(tpl) = &ic.tpl {
        let mut best = -1f32;
        // 1) cheap local re-check around the last known position
        if let Some(h) = ic.last_hit {
            let pad_x = h.w.max(8);
            let pad_y = h.h.max(8);
            let x0 = h.x.saturating_sub(pad_x);
            let y0 = h.y.saturating_sub(pad_y);
            let x1 = (h.x + h.w + pad_x).min(fw);
            let y1 = (h.y + h.h + pad_y).min(fh);
            if let Some(nh) = detect::search(gray, (x0, y0, x1 - x0, y1 - y0), tpl, &[h.scale]) {
                best = nh.score;
                if nh.score >= ic.match_thr {
                    ic.last_hit = Some(nh);
                    ic.score = nh.score;
                    return true;
                }
            }
        }
        // 2) full scan of the search region, only when this icon is due
        if let Some(iv) = scan_interval(ic, now) {
            // a locked buff that was not found next to its last spot is searched everywhere immediately
            if ic.active || now.saturating_sub(ic.last_scan) >= iv {
                ic.last_scan = now;
                let reg = search_region(cfg, ic, fw, fh);
                if let Some(nh) = detect::search(gray, reg, tpl, &[scale0]) {
                    best = best.max(nh.score);
                    if nh.score >= ic.match_thr {
                        ic.last_hit = Some(nh);
                        ic.score = nh.score;
                        return true;
                    }
                }
            }
        }
        if best >= 0.0 {
            ic.score = best;
        }
        false
    } else {
        let x = (ic.rect[0] * fw as f32) as usize;
        let y = (ic.rect[1] * fh as f32) as usize;
        let w = ((ic.rect[2] * fw as f32) as usize).max(1);
        let h = ((ic.rect[3] * fh as f32) as usize).max(1);
        let r = detect::gold_ratio(frame, (x, y, w, h), ic.hue, ic.sat, ic.val);
        ic.score = r;
        r >= ic.gold_thr
    }
}

fn sound_path(sh: &Shared, src: &Value) -> Option<std::path::PathBuf> {
    match src.get("type").and_then(|x| x.as_str()) {
        Some("custom") => {
            let id = src.get("assetId")?.as_str()?;
            Some(sh.dir.join("sound-assets").join(format!("{id}.wav")))
        }
        _ => None,
    }
}

pub fn play_source(sh: &Shared, src: &Value, volume: f32) {
    if let Some(p) = sound_path(sh, src) {
        sh.audio.play(p, volume);
    }
}

fn log(app: &AppHandle, msg: String) {
    let _ = app.emit("buff-assistant-execution-log", msg);
}

pub fn run(app: AppHandle, sh: Arc<Shared>, stop: Arc<AtomicBool>, testing: bool) {
    let mut ver = u64::MAX;
    let mut cfg = Value::Null;
    let mut icons: Vec<Icon> = vec![];
    let mut win: Option<capture::WindowInfo> = None;
    let mut last_resolve = 0u64;
    let mut last_overlay_emit = 0u64;
    let mut last_state_emit = 0u64;
    let mut last_metric = 0u64;
    let mut prev_activity = String::new();

    log(&app, if testing { "Bắt đầu kiểm tra nhận diện".into() } else { "Bắt đầu theo dõi buff".into() });

    while !stop.load(Ordering::Relaxed) {
        let tick = Instant::now();
        let now = now_ms();

        // reload config when it changed (keeps runtime state of buffs that still exist)
        let v = sh.cfg_ver.load(Ordering::Relaxed);
        if v != ver {
            ver = v;
            cfg = sh.cfg.lock().clone();
            let keep: std::collections::HashMap<String, (bool, Option<u64>, bool, Option<u64>)> = icons
                .iter()
                .map(|i| (i.name.clone(), (i.seen, i.expected, i.active, i.trigger_at)))
                .collect();
            icons = build_icons(&cfg);
            for i in icons.iter_mut() {
                if let Some((seen, exp, act, trig)) = keep.get(&i.name) {
                    i.seen = *seen;
                    i.expected = *exp;
                    i.active = *act;
                    i.trigger_at = *trig;
                }
            }
        }
        let settings = cfg.get("settings").cloned().unwrap_or(Value::Null);
        let confirm = num(&settings, "confirmFrames", 2.0).max(1.0) as u32;
        let missing = num(&settings, "missingFrames", 3.0).max(1.0) as u32;
        let volume = num(&settings["sound"], "volume", 0.45) as f32;

        // resolve the target window
        let need_resolve = win.as_ref().map_or(true, |w| !capture::window_alive(&w.id));
        if need_resolve && now.saturating_sub(last_resolve) > 1000 {
            last_resolve = now;
            let t = &cfg["target"];
            if !t.is_null() {
                win = capture::find_target(
                    t.get("processName").and_then(|x| x.as_str()).unwrap_or(""),
                    t.get("windowTitle").and_then(|x| x.as_str()).unwrap_or(""),
                    t.get("className").and_then(|x| x.as_str()).unwrap_or(""),
                );
            }
        }
        let mut activity = if testing { "testing" } else { "monitoring" };
        let mut conf = 0f32;
        let mut present_any = false;

        match win.as_ref().filter(|w| capture::window_alive(&w.id)) {
            None => {
                activity = "targetUnavailable";
                *sh.last_error.lock() = Some("Không tìm thấy cửa sổ game (đang chờ kết nối lại)".into());
            }
            Some(w) => match capture::capture(&w.id) {
                Err(e) => {
                    activity = "targetUnavailable";
                    *sh.last_error.lock() = Some(e);
                }
                Ok(frame) => {
                    *sh.last_error.lock() = None;
                    let (fw, fh) = (frame.w as usize, frame.h as usize);
                    // grayscale only for the union of search regions
                    let (mut ux0, mut uy0, mut ux1, mut uy1) = (fw, fh, 0usize, 0usize);
                    for ic in icons.iter() {
                        if ic.tpl.is_some() {
                            let (x, y, w, h) = search_region(&cfg, ic, fw, fh);
                            ux0 = ux0.min(x);
                            uy0 = uy0.min(y);
                            ux1 = ux1.max(x + w);
                            uy1 = uy1.max(y + h);
                        }
                    }
                    let gray = if ux1 > ux0 && uy1 > uy0 {
                        // small safety margin so the local re-check box is inside the image
                        let m = 48usize;
                        let (x0, y0) = (ux0.saturating_sub(m), uy0.saturating_sub(m));
                        let (x1, y1) = ((ux1 + m).min(fw), (uy1 + m).min(fh));
                        Gray::from_frame_region(&frame, x0, y0, x1 - x0, y1 - y0)
                    } else {
                        Gray { w: 0, h: 0, d: vec![], ox: 0, oy: 0 }
                    };
                    let ref_h = num(&cfg["target"], "referenceHeight", frame.h as f64).max(1.0) as f32;

                    for ic in icons.iter_mut() {
                        let scale0 = frame.h as f32 / if ic.ref_h > 0.0 { ic.ref_h } else { ref_h };
                        let present = detect_icon(&cfg, ic, &gray, &frame, scale0, now);
                        ic.present = present;
                        conf = conf.max(ic.score);
                        present_any |= present;
                        if testing {
                            continue;
                        }
                        if present {
                            if ic.present_cnt == 0 {
                                ic.first_present = Some(now);
                            }
                            ic.present_cnt += 1;
                            ic.miss_cnt = 0;
                            ic.last_seen = now;
                            if !ic.active && ic.present_cnt >= confirm {
                                // Seen again while the previous run should still be showing (e.g. the list reflowed and the
                                // icon briefly lost its position): continue that run instead of starting a new one.
                                let continuing = ic.trigger_at.map_or(false, |t| now < t + ic.duration + 1500);
                                ic.active = true;
                                ic.seen = true;
                                if !continuing {
                                    // anchor on the first frame the buff was seen, not on the confirmation frame
                                    let anchor = ic.first_present.unwrap_or(now);
                                    if let Some(prev) = ic.trigger_at {
                                        log(&app, format!(
                                            "{}: khoảng cách từ lần trước ≈ {:.1} giây (đang đặt hồi chiêu {:.1} giây)",
                                            ic.name, anchor.saturating_sub(prev) as f64 / 1000.0, ic.cycle as f64 / 1000.0));
                                    }
                                    ic.trigger_at = Some(anchor);
                                    ic.expected = Some(anchor + ic.cycle);
                                    ic.prewarned = [false; 6];
                                    ic.ready_played = false;
                                    log(&app, format!("{}: phát hiện buff, lượt kế sau {} giây", ic.name, ic.cycle / 1000));
                                }
                            }
                        } else {
                            ic.miss_cnt += 1;
                            ic.present_cnt = 0;
                            ic.first_present = None;
                            if ic.active && ic.miss_cnt >= missing {
                                ic.active = false;
                                let shown = ic.trigger_at.map(|t| ic.last_seen.saturating_sub(t)).unwrap_or(0);
                                ic.observed = Some(shown);
                                log(&app, format!(
                                    "{}: buff đã hết. Thời gian hiện trên màn hình đo được ≈ {:.1} giây (đang đặt {:.1} giây). Số đo thường thấp hơn thật khoảng 0,3–0,5 giây do độ trễ nhận diện.",
                                    ic.name, shown as f64 / 1000.0, ic.duration as f64 / 1000.0));
                            }
                        }
                    }
                }
            },
        }

        // per-buff timeline, prewarn / ready sounds, overlay rows
        let mut rows = vec![];
        let mut next_expected: Option<u64> = None;
        if !testing {
            let pre_mode = settings["sound"].get("prewarnMode").and_then(|x| x.as_str()).unwrap_or("countdown");
            for ic in icons.iter_mut() {
                let (stage, remaining) = if ic.active {
                    ("active", ic.trigger_at.map(|t| (t + ic.duration) as i64 - now as i64).unwrap_or(0))
                } else if let Some(e) = ic.expected {
                    let rem = e as i64 - now as i64;
                    if rem > 5000 {
                        ("cooling", rem)
                    } else if rem > 0 {
                        if ic.prewarn && pre_mode != "off" {
                            let sec = ((rem + 999) / 1000) as usize; // 5..1
                            if (1..=5).contains(&sec) && !ic.prewarned[sec] {
                                ic.prewarned[sec] = true;
                                let (en, src) = match sec {
                                    5 => ("prewarnFiveEnabled", "prewarnFiveSource"),
                                    4 => ("prewarnFourEnabled", "prewarnFourSource"),
                                    3 => ("prewarnThreeEnabled", "prewarnThreeSource"),
                                    2 => ("prewarnTwoEnabled", "prewarnTwoSource"),
                                    _ => ("prewarnOneEnabled", "prewarnOneSource"),
                                };
                                if flag(&settings["sound"], en, true) {
                                    if let Some(s) = settings["sound"].get(src) {
                                        play_source(&sh, s, volume);
                                    }
                                }
                            }
                        }
                        ("readySoon", rem)
                    } else {
                        if !ic.ready_played {
                            ic.ready_played = true;
                            if flag(&settings["sound"], "triggerEnabled", true) {
                                let src = ic.ready_sound.clone().or_else(|| settings["sound"].get("triggerSource").cloned());
                                if let Some(s) = src {
                                    play_source(&sh, &s, volume);
                                }
                            }
                            log(&app, format!("{}: đã tới lượt, sẵn sàng", ic.name));
                        }
                        ("ready", rem)
                    }
                } else {
                    ("unknown", 0)
                };
                if let Some(e) = ic.expected {
                    if stage == "cooling" || stage == "readySoon" {
                        next_expected = Some(next_expected.map_or(e, |n| n.min(e)));
                    }
                }
                rows.push(json!({
                    "name": ic.name,
                    "stage": stage,
                    "remainingMs": remaining.max(0),
                    "isElapsed": remaining <= 0 && stage != "unknown" && stage != "active",
                    "ocrSeconds": Value::Null,
                    "mergedGroup": ic.group,
                    "activeUntilUnixMs": ic.trigger_at.map(|t| t + ic.duration),
                    "expectedAtUnixMs": ic.expected,
                    "durationMs": ic.duration,
                    "cycleMs": ic.cycle,
                }));
            }
        }

        // publish
        *sh.last_conf.lock() = conf as f64;
        *sh.expected.lock() = next_expected;
        let act_str = activity.to_string();
        if act_str != prev_activity || now.saturating_sub(last_state_emit) > 1000 {
            *sh.activity.lock() = act_str.clone();
            prev_activity = act_str;
            last_state_emit = now;
            let _ = app.emit("buff-assistant-state", sh.state_json());
        }
        if testing || now.saturating_sub(last_metric) >= 150 {
            last_metric = now;
            let _ = app.emit("buff-assistant-metric", json!({ "confidence": conf, "present": present_any }));
            let per: Vec<Value> = icons
                .iter()
                .map(|i| json!({ "name": i.name, "score": i.score, "present": i.present, "threshold": i.match_thr, "hasTemplate": i.tpl.is_some(), "observedMs": i.observed }))
                .collect();
            let _ = app.emit("buff-assistant-icons", per);
        }
        if !testing && now.saturating_sub(last_overlay_emit) >= 100 {
            last_overlay_emit = now;
            let any_seen = rows.iter().any(|r| r["stage"] != "unknown");
            let editing = sh.edit_mode.load(Ordering::Relaxed);
            let mode = if editing {
                "editing"
            } else if any_seen {
                "countdown"
            } else {
                "waiting"
            };
            let st = json!({
                "mode": mode,
                "message": if any_seen { "" } else { "Đang chờ buff xuất hiện…" },
                "expectedAtUnixMs": next_expected,
                "cycleMs": icons.first().map(|i| i.cycle),
                "buffs": rows,
                "emittedAtUnixMs": now,
                "editable": editing,
                "colorScheme": cfg["settings"]["overlay"].get("colorScheme").cloned().unwrap_or(json!("gold")),
                "hideUntilSeen": cfg["settings"]["overlay"].get("hideUntilSeen").cloned().unwrap_or(json!(false)),
            });
            *sh.overlay.lock() = st.clone();
            let _ = app.emit("buff-overlay-state", st);
        }

        // Nothing can change soon (every buff is cooling down with > 3.5 s left): capture less often.
        let idle = !testing
            && !icons.is_empty()
            && icons.iter().all(|i| !i.active && i.expected.map_or(false, |e| e as i64 - now_ms() as i64 > 3500));
        let min_tick = Duration::from_millis(if idle { 450 } else { 60 });
        let spent = tick.elapsed();
        if spent < min_tick {
            std::thread::sleep(min_tick - spent);
        }
    }
    log(&app, "Đã dừng".into());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(p: &str) -> capture::Frame {
        let i = image::open(p).unwrap().to_rgba8();
        capture::Frame { w: i.width(), h: i.height(), rgba: i.into_raw() }
    }

    /// Regression: a locked buff whose row moves (list reflow) must be found again at once,
    /// not reported as "gone". Needs the sample screenshots, so it only runs on request:
    ///   MF_TEST_IMG_DIR=<dir with 8.png and 3.png> MF_TEST_TPL=<template.png> cargo test --release -- --ignored reflow
    #[test]
    #[ignore]
    fn reflow_keeps_lock() {
        let dir = std::env::var("MF_TEST_IMG_DIR").expect("MF_TEST_IMG_DIR");
        let tpl = std::env::var("MF_TEST_TPL").expect("MF_TEST_TPL");
        let b64 = base64::engine::general_purpose::STANDARD.encode(std::fs::read(tpl).unwrap());
        let cfg = json!({
            "target": { "referenceHeight": 1080 },
            "searchRegion": { "x": 0.0, "y": 0.2, "width": 0.3, "height": 0.5 },
            "buffGroup": { "icons": [ { "name": "Con Ngo", "iconTemplate": b64, "matchThreshold": 0.9, "templateRefHeight": 1080 } ] }
        });
        let mut icons = build_icons(&cfg);
        let ic = &mut icons[0];

        // frame A: buff on the third row (y = 487)
        let a = load(&format!("{dir}/8.png"));
        let ga = Gray::from_frame(&a);
        assert!(detect_icon(&cfg, ic, &ga, &a, 1.0, 1_000), "should see the buff at its first position");
        assert_eq!(ic.last_hit.unwrap().y, 487);
        ic.active = true; // locked, as in a running monitor

        // frame B: the rows above vanished, the same icon is now on the first row (y = 393), 94 px away
        let b = load(&format!("{dir}/3.png"));
        let gb = Gray::from_frame(&b);
        let found = detect_icon(&cfg, ic, &gb, &b, 1.0, 1_050);
        assert!(found, "a locked buff that moved must be re-found in the same tick (score {})", ic.score);
        assert_eq!(ic.last_hit.unwrap().y, 393);
    }
}
