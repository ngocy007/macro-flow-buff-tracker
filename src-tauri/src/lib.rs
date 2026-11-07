//! Recovered buff-monitor backend for macro-flow (Tauri 2).
//! Only the screen buff-tracking feature is implemented; everything else is a safe stub.

pub mod audio;
pub mod capture;
pub mod detect;
pub mod hotkey;
pub mod macros;
pub mod timers;
pub mod monitor;

use base64::Engine;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

type Res<T> = Result<T, String>;

pub struct Shared {
    pub dir: PathBuf,
    pub cfg: Mutex<Value>,
    pub cfg_ver: AtomicU64,
    pub activity: Mutex<String>,
    pub last_conf: Mutex<f64>,
    pub last_error: Mutex<Option<String>>,
    pub expected: Mutex<Option<u64>>,
    pub preview: Mutex<Option<capture::Frame>>,
    pub audio: audio::Audio,
    pub edit_mode: AtomicBool,
    pub run: Mutex<Option<Arc<AtomicBool>>>,
    pub overlay: Mutex<Value>,
}

impl Shared {
    pub fn state_json(&self) -> Value {
        let monitoring = self.run.lock().is_some() && *self.activity.lock() != "testing";
        json!({
            "config": *self.cfg.lock(),
            "activity": *self.activity.lock(),
            "isMonitoring": monitoring,
            "expectedAtUnixMs": *self.expected.lock(),
            "lastConfidence": *self.last_conf.lock(),
            "lastError": *self.last_error.lock(),
            "captureBorderSupported": false,
            "captureBorderNotice": Value::Null,
        })
    }
    fn save(&self) {
        let cfg = self.cfg.lock().clone();
        if let Ok(s) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(self.dir.join("config-v1.json"), s);
        }
        self.cfg_ver.fetch_add(1, Ordering::Relaxed);
    }
    fn bump(&self) {
        self.cfg_ver.fetch_add(1, Ordering::Relaxed);
    }
}

type S<'a> = State<'a, Arc<Shared>>;

fn default_config() -> Value {
    json!({
        "schemaVersion": 9,
        "target": null,
        "searchRegion": null,
        "template": null,
        "settings": {
            "cycleMs": 20000, "deadlineGraceMs": 1500, "threshold": 0.95,
            "confirmFrames": 3, "missingFrames": 5,
            "sound": {
                "triggerEnabled": true, "prewarnFiveEnabled": true, "prewarnFourEnabled": true,
                "prewarnThreeEnabled": true, "prewarnTwoEnabled": true, "prewarnOneEnabled": true,
                "prewarnMode": "countdown", "volume": 0.45
            },
            "overlay": { "x": 40, "y": 100, "showWaitingDot": false, "excludeFromCapture": false,
                         "width": 330, "height": 92, "colorScheme": "gold" },
            "capture": { "showSystemBorder": true, "engine": "wgc", "hdrMode": false }
        }
    })
}

fn copy_dir(src: &Path, dst: &Path) {
    let _ = std::fs::create_dir_all(dst);
    if let Ok(rd) = std::fs::read_dir(src) {
        for e in rd.flatten() {
            let p = e.path();
            let t = dst.join(e.file_name());
            if p.is_dir() {
                copy_dir(&p, &t);
            } else if !t.exists() {
                let _ = std::fs::copy(&p, &t);
            }
        }
    }
}

fn find_payload() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut d = exe.parent()?.to_path_buf();
    for _ in 0..6 {
        let c = d.join("payload");
        if c.join("config-v1.json").exists() {
            return Some(c);
        }
        if !d.pop() {
            break;
        }
    }
    None
}

fn load_or_seed(dir: &Path) -> Value {
    let _ = std::fs::create_dir_all(dir);
    if let Some(p) = find_payload() {
        copy_dir(&p.join("sound-assets"), &dir.join("sound-assets"));
        copy_dir(&p.join("templates"), &dir.join("templates"));
        copy_dir(&p.join("buff-sounds"), &dir.join("buff-sounds"));
        if !dir.join("config-v1.json").exists() {
            let _ = std::fs::copy(p.join("config-v1.json"), dir.join("config-v1.json"));
        }
    }
    let mut cfg = std::fs::read_to_string(dir.join("config-v1.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(default_config);
    // fill missing top-level keys
    let d = default_config();
    if let (Some(c), Some(dd)) = (cfg.as_object_mut(), d.as_object()) {
        for (k, v) in dd {
            c.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    cfg
}

fn data_url_png(f: &capture::Frame) -> Res<String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let mut buf = Vec::new();
    PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter)
        .write_image(&f.rgba, f.w, f.h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

// ---------- overlay window ----------

fn exclude_from_capture(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    if let Ok(h) = w.hwnd() {
        unsafe {
            let _ = SetWindowDisplayAffinity(HWND(h.0 as *mut _), WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

fn ensure_overlay(app: &AppHandle, sh: &Shared) -> Res<()> {
    let ov = sh.cfg.lock()["settings"]["overlay"].clone();
    let w = ov["width"].as_f64().unwrap_or(330.0);
    let h = ov["height"].as_f64().unwrap_or(92.0);
    let x = ov["x"].as_f64().unwrap_or(40.0);
    let y = ov["y"].as_f64().unwrap_or(100.0);
    if let Some(win) = app.get_webview_window("buff-overlay") {
        let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
        let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        let _ = win.show();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, "buff-overlay", WebviewUrl::App("index.html".into()))
        .title("buff-overlay")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .inner_size(w, h)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
    let _ = win.set_ignore_cursor_events(!sh.edit_mode.load(Ordering::Relaxed));
    exclude_from_capture(&win);
    Ok(())
}

fn hide_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("buff-overlay") {
        let _ = w.hide();
    }
}

fn start_run(app: &AppHandle, sh: &Arc<Shared>, testing: bool) -> Res<()> {
    stop_run(app, sh);
    let stop = Arc::new(AtomicBool::new(false));
    *sh.run.lock() = Some(stop.clone());
    *sh.activity.lock() = if testing { "testing" } else { "monitoring" }.into();
    *sh.last_error.lock() = None;
    if !testing {
        ensure_overlay(app, sh)?;
    }
    let (a, s) = (app.clone(), sh.clone());
    std::thread::spawn(move || monitor::run(a, s, stop, testing));
    Ok(())
}

fn stop_run(app: &AppHandle, sh: &Arc<Shared>) {
    if let Some(f) = sh.run.lock().take() {
        f.store(true, Ordering::Relaxed);
    }
    *sh.activity.lock() = "stopped".into();
    *sh.expected.lock() = None;
    if !sh.edit_mode.load(Ordering::Relaxed) {
        hide_overlay(app);
    }
    let _ = app.emit("buff-assistant-state", sh.state_json());
}

fn emit_state(app: &AppHandle, sh: &Shared) -> Value {
    let st = sh.state_json();
    let _ = app.emit("buff-assistant-state", st.clone());
    st
}

/// Start/stop monitoring from the global hotkey (no UI needed).
fn toggle_monitor(app: &AppHandle, sh: &Arc<Shared>) {
    let running = sh.run.lock().is_some() && *sh.activity.lock() != "testing";
    let msg = if running {
        stop_run(app, sh);
        "Đã dừng theo dõi (phím tắt)".to_string()
    } else {
        let (has_target, usable) = {
            let c = sh.cfg.lock();
            let n = c["buffGroup"]["icons"]
                .as_array()
                .map_or(0, |a| a.iter().filter(|i| i["enabled"].as_bool() != Some(false)).count());
            (!c["target"].is_null(), n)
        };
        if !has_target {
            "Chưa chọn cửa sổ game".to_string()
        } else if usable == 0 {
            "Chưa có buff nào được bật".to_string()
        } else {
            match start_run(app, sh, false) {
                Ok(()) => "Đã bắt đầu theo dõi (phím tắt)".to_string(),
                Err(e) => e,
            }
        }
    };
    emit_state(app, sh);
    let _ = app.emit("buff-assistant-hotkey", msg);
}

#[tauri::command]
fn set_buff_hotkey(app: AppHandle, sh: S, hotkey: String) -> Res<Value> {
    hotkey::set(&hotkey)?;
    {
        let mut c = sh.cfg.lock();
        c["settings"]["hotkey"] = json!(hotkey.trim());
    }
    sh.save();
    Ok(emit_state(&app, &sh))
}

/// Save the whole macro list and re-register every macro hotkey.
#[tauri::command]
fn save_macros(app: AppHandle, sh: S, macros: Value) -> Res<Value> {
    if !macros.is_array() {
        return Err("Danh sách macro không hợp lệ".into());
    }
    sh.cfg.lock()["macros"] = macros;
    sh.save();
    let cfg = sh.cfg.lock().clone();
    let errors = macros::register_all(&cfg);
    Ok(json!({ "state": emit_state(&app, &sh), "errors": errors }))
}

#[tauri::command]
fn play_macro(app: AppHandle, sh: S, id: String, delay_ms: Option<u64>) -> Res<()> {
    let cfg = sh.cfg.lock().clone();
    macros::start(&app, &cfg, &id, delay_ms.unwrap_or(0))
}

#[tauri::command]
fn stop_macro(app: AppHandle) {
    macros::stop(&app);
}

/// Save the whole timer list and re-register every timer hotkey.
#[tauri::command]
fn save_timers(app: AppHandle, sh: S, timers: Value) -> Res<Value> {
    if !timers.is_array() {
        return Err("Danh sách hẹn giờ không hợp lệ".into());
    }
    sh.cfg.lock()["timers"] = timers;
    sh.save();
    let cfg = sh.cfg.lock().clone();
    let errors = timers::register_all(&cfg);
    Ok(json!({ "state": emit_state(&app, &sh), "errors": errors }))
}

#[tauri::command]
fn start_timer(app: AppHandle, sh: S, id: String) -> Res<()> {
    timers::start(&app, &sh, &id)
}

#[tauri::command]
fn cancel_timer(app: AppHandle, id: String) {
    timers::cancel(&app, &id);
}

#[tauri::command]
fn get_timer_state() -> Value {
    timers::state()
}

/// Pick a .wav with the native Windows dialog and copy it into sound-assets.
#[tauri::command]
async fn import_buff_assistant_sound(sh: S<'_>, _cue: Option<String>) -> Res<Option<Value>> {
    let script = "Add-Type -AssemblyName System.Windows.Forms;         $d = New-Object System.Windows.Forms.OpenFileDialog;         $d.Filter = 'Âm thanh WAV (*.wav)|*.wav'; $d.Title = 'Chọn file nhạc (.wav)';         if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.FileName }";
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", script])
        .output()
        .map_err(|e| e.to_string())?;
    let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if picked.is_empty() {
        return Ok(None);
    }
    let src = PathBuf::from(&picked);
    // fail early with a clear message if rodio can't decode it
    let f = std::fs::File::open(&src).map_err(|e| e.to_string())?;
    if rodio::Decoder::new(std::io::BufReader::new(f)).is_err() {
        return Err("File này không đọc được. Hãy dùng file .wav chuẩn (PCM).".into());
    }
    let stem = src.file_stem().and_then(|x| x.to_str()).unwrap_or("nhac");
    let clean: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let dir = sh.dir.join("sound-assets");
    let _ = std::fs::create_dir_all(&dir);
    let mut id = format!("custom-{clean}");
    let mut n = 2;
    while dir.join(format!("{id}.wav")).exists() {
        id = format!("custom-{clean}-{n}");
        n += 1;
    }
    std::fs::copy(&src, dir.join(format!("{id}.wav"))).map_err(|e| e.to_string())?;
    Ok(Some(json!({ "assetId": id, "fileName": format!("{id}.wav"), "label": stem })))
}

// ---------- commands: misc / stubs ----------

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
#[tauri::command]
fn get_feature_access_status() -> Value {
    json!({ "restrictedWorkspacesUnlocked": false })
}
#[tauri::command]
fn check_for_update() -> Value {
    json!({ "currentVersion": env!("CARGO_PKG_VERSION"), "update": null })
}
#[tauri::command]
fn install_update() -> Res<()> {
    Err("Cập nhật tự động đã bị tắt trong bản khôi phục".into())
}
#[tauri::command]
fn submit_feedback(_content: String) -> Res<()> {
    Err("Máy chủ phản hồi cũ không còn".into())
}
#[tauri::command]
fn report_frontend_error(message: String) {
    eprintln!("[frontend-error] {message}");
}
#[tauri::command]
fn switch_workspace(_workspace: String) -> Res<()> {
    Ok(())
}
#[tauri::command]
async fn recreate_overlay(app: AppHandle, sh: S<'_>) -> Res<()> {
    if let Some(w) = app.get_webview_window("buff-overlay") {
        let _ = w.destroy();
    }
    if sh.run.lock().is_some() || sh.edit_mode.load(Ordering::Relaxed) {
        ensure_overlay(&app, &sh)?;
    }
    Ok(())
}

// ---------- commands: buff ----------

#[tauri::command]
fn get_buff_assistant_state(sh: S) -> Value {
    sh.state_json()
}

#[tauri::command]
async fn update_buff_assistant_settings(app: AppHandle, sh: S<'_>, settings: Value) -> Res<Value> {
    sh.cfg.lock()["settings"] = settings;
    sh.save();
    if sh.run.lock().is_some() || sh.edit_mode.load(Ordering::Relaxed) {
        let _ = ensure_overlay(&app, &sh);
    }
    Ok(emit_state(&app, &sh))
}

#[tauri::command]
fn set_buff_group_config(app: AppHandle, sh: S, buff_group: Value) -> Res<Value> {
    sh.cfg.lock()["buffGroup"] = buff_group;
    sh.save();
    // Positioning mode shows static sample rows: rebuild them so toggled buffs appear / disappear at once.
    if sh.edit_mode.load(Ordering::Relaxed) && sh.run.lock().is_none() {
        let st = edit_overlay_state(&sh);
        *sh.overlay.lock() = st.clone();
        let _ = app.emit("buff-overlay-state", st);
    }
    Ok(emit_state(&app, &sh))
}

#[tauri::command]
fn set_buff_capture_engine(app: AppHandle, sh: S, engine: String) -> Res<Value> {
    sh.cfg.lock()["settings"]["capture"]["engine"] = json!(engine);
    sh.save();
    Ok(emit_state(&app, &sh))
}

#[tauri::command]
fn set_buff_capture_hdr_mode(app: AppHandle, sh: S, hdr_mode: bool) -> Res<Value> {
    sh.cfg.lock()["settings"]["capture"]["hdrMode"] = json!(hdr_mode);
    sh.save();
    Ok(emit_state(&app, &sh))
}

#[tauri::command]
fn request_buff_borderless_capture_access() -> &'static str {
    "unsupported"
}

#[tauri::command]
fn list_buff_capture_windows(app: AppHandle) -> Vec<capture::WindowInfo> {
    let own: Vec<String> = app
        .webview_windows()
        .values()
        .filter_map(|w| w.title().ok())
        .collect();
    let own_refs: Vec<&str> = own.iter().map(|s| s.as_str()).collect();
    capture::list_windows(&own_refs)
}

fn preview_of(sh: &Shared, window_id: &str) -> Res<Value> {
    let f = capture::capture(window_id)?;
    let url = data_url_png(&f)?;
    let (w, h) = (f.w, f.h);
    *sh.preview.lock() = Some(f);
    Ok(json!({ "windowId": window_id, "dataUrl": url, "width": w, "height": h,
               "capturedAtUnixMs": monitor::now_ms() }))
}

#[tauri::command]
fn capture_buff_preview(sh: S, window_id: String) -> Res<Value> {
    preview_of(&sh, &window_id)
}
#[tauri::command]
fn capture_buff_preview_hidden(sh: S, window_id: String) -> Res<Value> {
    preview_of(&sh, &window_id)
}

#[tauri::command]
fn save_buff_target(app: AppHandle, sh: S, window_id: String) -> Res<Value> {
    let w = capture::list_windows(&[])
        .into_iter()
        .find(|w| w.id == window_id)
        .ok_or("Không thấy cửa sổ đã chọn")?;
    sh.cfg.lock()["target"] = json!({
        "processName": w.process_name,
        "windowTitle": w.window_title,
        "className": w.class_name,
        "referenceWidth": w.width,
        "referenceHeight": w.height,
    });
    sh.save();
    Ok(emit_state(&app, &sh))
}

fn rect_px(v: &Value, w: u32, h: u32) -> (u32, u32, u32, u32) {
    let g = |k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let x = (g("x").clamp(0.0, 1.0) * w as f64).round() as u32;
    let y = (g("y").clamp(0.0, 1.0) * h as f64).round() as u32;
    let rw = ((g("width").clamp(0.0, 1.0) * w as f64).round() as u32).min(w - x).max(1);
    let rh = ((g("height").clamp(0.0, 1.0) * h as f64).round() as u32).min(h - y).max(1);
    (x, y, rw, rh)
}

#[tauri::command]
fn save_buff_template(
    app: AppHandle,
    sh: S,
    search_region: Value,
    crop: Value,
    mask_data_url: Option<String>,
) -> Res<Value> {
    let prev = sh.preview.lock();
    let f = prev.as_ref().ok_or("Chưa có ảnh xem trước, hãy chụp trước")?;
    // crop is relative to the search-region image shown in the editor
    let (sx, sy, sw, shh) = rect_px(&search_region, f.w, f.h);
    let (cx, cy, cw, ch) = rect_px(&crop, sw, shh);
    let (x, y) = (sx + cx, sy + cy);
    let mut img = image::RgbaImage::new(cw, ch);
    for yy in 0..ch {
        for xx in 0..cw {
            let i = (((y + yy) * f.w + x + xx) * 4) as usize;
            img.put_pixel(xx, yy, image::Rgba([f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], 255]));
        }
    }
    drop(prev);
    let id = format!("template-{}", monitor::now_ms());
    let dir = sh.dir.join("templates").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    img.save(dir.join("template.png")).map_err(|e| e.to_string())?;
    if let Some(m) = mask_data_url {
        if let Some(b64) = m.split(',').last() {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                let _ = std::fs::write(dir.join("mask.png"), bytes);
            }
        }
    }
    {
        let mut c = sh.cfg.lock();
        c["searchRegion"] = search_region;
        c["template"] = json!({ "id": id, "width": cw, "height": ch });
    }
    sh.save();
    Ok(emit_state(&app, &sh))
}

#[tauri::command]
fn delete_buff_template(app: AppHandle, sh: S) -> Res<Value> {
    {
        let mut c = sh.cfg.lock();
        c["template"] = Value::Null;
    }
    sh.save();
    Ok(emit_state(&app, &sh))
}

fn target_ready(sh: &Shared) -> Res<()> {
    if sh.cfg.lock()["target"].is_null() {
        return Err("Chưa chọn cửa sổ game: hãy chọn cửa sổ rồi bấm lưu mục tiêu".into());
    }
    Ok(())
}

#[tauri::command]
async fn start_buff_monitor(app: AppHandle, sh: S<'_>) -> Res<Value> {
    target_ready(&sh)?;
    start_run(&app, &sh, false)?;
    Ok(emit_state(&app, &sh))
}
#[tauri::command]
fn stop_buff_monitor(app: AppHandle, sh: S) -> Value {
    stop_run(&app, &sh);
    sh.state_json()
}
#[tauri::command]
fn start_buff_template_test(app: AppHandle, sh: S, window_id: String) -> Res<Value> {
    // make sure the target matches the window being tested
    if sh.cfg.lock()["target"].is_null() {
        save_buff_target_inner(&sh, &window_id)?;
    }
    start_run(&app, &sh, true)?;
    Ok(emit_state(&app, &sh))
}
fn save_buff_target_inner(sh: &Shared, window_id: &str) -> Res<()> {
    let w = capture::list_windows(&[])
        .into_iter()
        .find(|w| w.id == window_id)
        .ok_or("Không thấy cửa sổ đã chọn")?;
    sh.cfg.lock()["target"] = json!({
        "processName": w.process_name, "windowTitle": w.window_title, "className": w.class_name,
        "referenceWidth": w.width, "referenceHeight": w.height,
    });
    sh.save();
    Ok(())
}
#[tauri::command]
fn stop_buff_template_test(app: AppHandle, sh: S) -> Value {
    stop_run(&app, &sh);
    sh.state_json()
}

#[tauri::command]
fn list_buff_sound_templates(sh: S) -> Vec<Value> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(sh.dir.join("buff-sounds")) {
        for e in rd.flatten() {
            if let Ok(s) = std::fs::read_to_string(e.path().join("manifest.json")) {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    out.push(v);
                }
            }
        }
    }
    out
}

#[tauri::command]
fn set_buff_search_region(app: AppHandle, sh: S, search_region: Value) -> Res<Value> {
    sh.cfg.lock()["searchRegion"] = search_region;
    sh.save();
    Ok(emit_state(&app, &sh))
}

#[tauri::command]
fn list_buff_sound_assets(sh: S) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    if let Ok(rd) = std::fs::read_dir(sh.dir.join("sound-assets")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()).map_or(false, |x| x.eq_ignore_ascii_case("wav")) {
                if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
                    out.push(json!({ "assetId": stem, "fileName": format!("{stem}.wav") }));
                }
            }
        }
    }
    out.sort_by(|a, b| a["assetId"].as_str().cmp(&b["assetId"].as_str()));
    out
}

#[tauri::command]
fn open_data_folder(sh: S) -> Res<()> {
    std::process::Command::new("explorer").arg(&sh.dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn play_buff_assistant_sound(sh: S, cue: String, source: Value, volume: f64) -> Res<()> {
    let _ = cue;
    if let Some(p) = match source.get("type").and_then(|x| x.as_str()) {
        Some("custom") => source
            .get("assetId")
            .and_then(|x| x.as_str())
            .map(|id| sh.dir.join("sound-assets").join(format!("{id}.wav"))),
        _ => None,
    } {
        sh.audio.play(p, volume as f32);
    }
    Ok(())
}

/// Overlay state used while positioning the overlay: one sample row per *enabled* buff.
fn edit_overlay_state(sh: &Shared) -> Value {
    let now = monitor::now_ms();
    let c = sh.cfg.lock();
    let mut rows: Vec<Value> = vec![];
    if let Some(arr) = c["buffGroup"]["icons"].as_array() {
        for (i, ic) in arr.iter().filter(|ic| ic["enabled"].as_bool() != Some(false)).enumerate() {
            let (stage, exp) = match i % 3 {
                0 => ("cooling", now + 12000),
                1 => ("readySoon", now + 3500),
                _ => ("active", now + 3000),
            };
            rows.push(json!({
                "name": ic["name"].as_str().unwrap_or("Buff"), "stage": stage,
                "remainingMs": 12000, "isElapsed": false, "ocrSeconds": null, "mergedGroup": null,
                "activeUntilUnixMs": if stage == "active" { Some(exp) } else { None },
                "expectedAtUnixMs": if stage == "active" { Some(now + 20000) } else { Some(exp) },
                "durationMs": ic["durationMs"], "cycleMs": ic["cycleMs"],
            }));
        }
    }
    let cs = c["settings"]["overlay"]["colorScheme"].clone();
    json!({
        "mode": "editing", "message": "", "expectedAtUnixMs": null, "cycleMs": null,
        "buffs": rows, "emittedAtUnixMs": now, "editable": true,
        "colorScheme": if cs.is_null() { json!("gold") } else { cs },
        "hideUntilSeen": c["settings"]["overlay"]["hideUntilSeen"].clone(),
    })
}

#[tauri::command]
fn get_buff_overlay_state(sh: S) -> Value {
    let v = sh.overlay.lock().clone();
    if v.is_null() {
        json!({ "mode": "hidden", "message": "", "expectedAtUnixMs": null, "cycleMs": null, "buffs": [],
                "emittedAtUnixMs": 0, "editable": false, "colorScheme": "gold" })
    } else {
        v
    }
}

#[tauri::command]
fn get_buff_overlay_appearance(sh: S) -> Value {
    sh.cfg.lock()["settings"]["overlay"]
        .get("appearance")
        .cloned()
        .unwrap_or(json!({ "paddingScale": 1, "opacity": 1, "fontScale": 1, "textColor": null }))
}

#[tauri::command]
fn preview_buff_overlay_appearance(app: AppHandle, appearance: Value) {
    let _ = app.emit("buff-overlay-appearance", appearance);
}

#[tauri::command]
async fn set_buff_overlay_edit_mode(app: AppHandle, sh: S<'_>, enabled: bool) -> Res<Value> {
    sh.edit_mode.store(enabled, Ordering::Relaxed);
    if enabled {
        ensure_overlay(&app, &sh)?;
        if let Some(w) = app.get_webview_window("buff-overlay") {
            let _ = w.set_ignore_cursor_events(false);
        }
        let st = edit_overlay_state(&sh);
        *sh.overlay.lock() = st.clone();
        let _ = app.emit("buff-overlay-state", st);
    } else {
        if let Some(w) = app.get_webview_window("buff-overlay") {
            let _ = w.set_ignore_cursor_events(true);
            // persist the position and size the user dragged the overlay to
            let mut c = sh.cfg.lock();
            if let Ok(p) = w.outer_position() {
                c["settings"]["overlay"]["x"] = json!(p.x);
                c["settings"]["overlay"]["y"] = json!(p.y);
            }
            if let Ok(sz) = w.inner_size() {
                c["settings"]["overlay"]["width"] = json!(sz.width);
                c["settings"]["overlay"]["height"] = json!(sz.height);
            }
        }
        sh.save();
        if sh.run.lock().is_none() {
            let hidden = json!({ "mode": "hidden", "message": "", "expectedAtUnixMs": null, "cycleMs": null,
                                 "buffs": [], "emittedAtUnixMs": monitor::now_ms(), "editable": false,
                                 "colorScheme": "gold" });
            *sh.overlay.lock() = hidden.clone();
            let _ = app.emit("buff-overlay-state", hidden);
            hide_overlay(&app);
        }
    }
    Ok(emit_state(&app, &sh))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("buff-assistant");
            let cfg = load_or_seed(&dir);
            let sh = Arc::new(Shared {
                dir,
                cfg: Mutex::new(cfg),
                cfg_ver: AtomicU64::new(1),
                activity: Mutex::new("stopped".into()),
                last_conf: Mutex::new(0.0),
                last_error: Mutex::new(None),
                expected: Mutex::new(None),
                preview: Mutex::new(None),
                audio: audio::Audio::spawn(),
                edit_mode: AtomicBool::new(false),
                run: Mutex::new(None),
                overlay: Mutex::new(Value::Null),
            });
            app.manage(sh.clone());
            let handle = app.handle().clone();
            let sh2 = sh.clone();
            hotkey::spawn(move |id| {
                if id == hotkey::MONITOR_ID {
                    toggle_monitor(&handle, &sh2);
                } else {
                    let cfg = sh2.cfg.lock().clone();
                    macros::on_hotkey(&handle, &cfg, id);
                }
            });
            let saved = sh.cfg.lock()["settings"]["hotkey"].as_str().unwrap_or("").to_string();
            if !saved.is_empty() {
                if let Err(e) = hotkey::set(&saved) {
                    eprintln!("[hotkey] {e}");
                }
            }
            let cfg = sh.cfg.lock().clone();
            for e in macros::register_all(&cfg) {
                eprintln!("[macro hotkey] {e}");
            }
            for e in timers::register_all(&cfg) {
                eprintln!("[timer hotkey] {e}");
            }
            timers::spawn_ticker(app.handle().clone(), sh.clone());
            timers::spawn_hook(app.handle().clone(), sh.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_feature_access_status,
            check_for_update,
            install_update,
            submit_feedback,
            report_frontend_error,
            switch_workspace,
            recreate_overlay,
            get_buff_assistant_state,
            update_buff_assistant_settings,
            set_buff_group_config,
            set_buff_capture_engine,
            set_buff_capture_hdr_mode,
            request_buff_borderless_capture_access,
            list_buff_capture_windows,
            capture_buff_preview,
            capture_buff_preview_hidden,
            save_buff_target,
            save_buff_template,
            delete_buff_template,
            start_buff_monitor,
            stop_buff_monitor,
            start_buff_template_test,
            stop_buff_template_test,
            list_buff_sound_templates,
            list_buff_sound_assets,
            set_buff_search_region,
            open_data_folder,
            import_buff_assistant_sound,
            set_buff_hotkey,
            play_buff_assistant_sound,
            get_buff_overlay_state,
            get_buff_overlay_appearance,
            preview_buff_overlay_appearance,
            set_buff_overlay_edit_mode,
            save_macros,
            play_macro,
            stop_macro,
            save_timers,
            start_timer,
            cancel_timer,
            get_timer_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running macro-flow-recovered");
}
