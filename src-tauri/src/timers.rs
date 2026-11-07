//! Manual timers: press a hotkey (in game) and a countdown of N seconds starts. It shows on the overlay,
//! reads 5-4-3-2-1 with the shared countdown sounds and plays a sound when time is up.
//! Keys are watched with a low-level keyboard hook that never swallows them, so a timer can be bound to the
//! skill key itself: pressing it in game casts the skill AND starts the countdown.
//!
//! Config shape (`config.timers`, edited by the UI):
//! `{ id, name, enabled, hotkey, seconds, prewarn, sound: {type,assetId,fileName} | null, repress: "restart" | "cancel" }`

use crate::{hotkey, monitor, Shared};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, OnceLock};
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use tauri::{AppHandle, Emitter};

/// How long a finished timer stays on the overlay showing "Hết giờ".
const SHOW_DONE_MS: u64 = 3000;

struct Run {
    name: String,
    ends_at: u64,
    duration: u64,
    prewarn: bool,
    sound: Value,
    prewarned: [bool; 6],
    done: bool,
}

static RUNS: Mutex<Vec<(String, Run)>> = Mutex::new(Vec::new());
/// (timer id, modifier bits, virtual key) watched by the keyboard hook.
static BINDS: Mutex<Vec<(String, u32, u32)>> = Mutex::new(Vec::new());
/// Keys currently held, so auto-repeat while holding a key does not restart the timer.
static HELD: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static TX: OnceLock<Sender<String>> = OnceLock::new();

fn find(cfg: &Value, id: &str) -> Option<Value> {
    cfg["timers"].as_array()?.iter().find(|t| t["id"].as_str() == Some(id)).cloned()
}

fn snapshot() -> Value {
    let runs = RUNS.lock();
    let rows: Vec<Value> = runs
        .iter()
        .map(|(id, r)| json!({ "id": id, "name": r.name, "endsAtUnixMs": r.ends_at, "durationMs": r.duration }))
        .collect();
    json!({ "timers": rows })
}

fn emit(app: &AppHandle) {
    let _ = app.emit("timer-state", snapshot());
}

pub fn state() -> Value {
    snapshot()
}

/// Start (or restart) a timer from the config.
pub fn start(app: &AppHandle, sh: &Shared, id: &str) -> Result<(), String> {
    let t = find(&sh.cfg.lock(), id).ok_or("Không tìm thấy hẹn giờ")?;
    let secs = t["seconds"].as_f64().unwrap_or(0.0);
    if !(secs > 0.0) {
        return Err("Số giây phải lớn hơn 0".into());
    }
    let duration = (secs * 1000.0).round() as u64;
    let run = Run {
        name: t["name"].as_str().unwrap_or("Hẹn giờ").to_string(),
        ends_at: monitor::now_ms() + duration,
        duration,
        prewarn: t["prewarn"].as_bool() != Some(false),
        sound: t["sound"].clone(),
        prewarned: [false; 6],
        done: false,
    };
    {
        let mut runs = RUNS.lock();
        runs.retain(|(k, _)| k != id);
        runs.push((id.to_string(), run));
    }
    let _ = crate::ensure_overlay(app, sh);
    let _ = app.emit("buff-assistant-execution-log", format!("Hẹn giờ “{}”: bắt đầu {secs} giây", t["name"].as_str().unwrap_or(id)));
    emit(app);
    Ok(())
}

pub fn cancel(app: &AppHandle, id: &str) {
    RUNS.lock().retain(|(k, _)| k != id);
    emit(app);
}

/// The bound key was pressed (from the keyboard hook).
fn on_key(app: &AppHandle, sh: &Shared, id: &str) {
    let running = RUNS.lock().iter().any(|(k, r)| k == id && !r.done);
    let cancel_on_repress = find(&sh.cfg.lock(), id).is_some_and(|t| t["repress"].as_str() == Some("cancel"));
    if running && cancel_on_repress {
        cancel(app, id);
        let _ = app.emit("buff-assistant-execution-log", "Đã hủy hẹn giờ (phím tắt)".to_string());
        return;
    }
    if let Err(e) = start(app, sh, id) {
        let _ = app.emit("buff-assistant-hotkey", format!("Hẹn giờ: {e}"));
    }
}

fn key_down(vk: VIRTUAL_KEY) -> bool {
    unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 }
}

fn current_mods() -> u32 {
    let mut m = 0;
    if key_down(VK_CONTROL) {
        m |= MOD_CONTROL.0;
    }
    if key_down(VK_MENU) {
        m |= MOD_ALT.0;
    }
    if key_down(VK_SHIFT) {
        m |= MOD_SHIFT.0;
    }
    if key_down(VK_LWIN) || key_down(VK_RWIN) {
        m |= MOD_WIN.0;
    }
    m
}

unsafe extern "system" fn hook_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
        let vk = k.vkCode;
        let msg = w.0 as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let first = {
                let mut held = HELD.lock();
                if held.contains(&vk) {
                    false
                } else {
                    held.push(vk);
                    true
                }
            };
            if first {
                let mods = current_mods();
                if let Some(tx) = TX.get() {
                    for (id, m, v) in BINDS.lock().iter() {
                        if *v == vk && *m == mods {
                            let _ = tx.send(id.clone());
                        }
                    }
                }
            }
        } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
            HELD.lock().retain(|x| *x != vk);
        }
    }
    CallNextHookEx(None, code, w, l)
}

/// Install the keyboard hook (its own message-loop thread) and the worker that reacts to bound keys.
pub fn spawn_hook(app: AppHandle, sh: Arc<Shared>) {
    let (tx, rx) = channel::<String>();
    let _ = TX.set(tx);
    std::thread::spawn(move || {
        while let Ok(id) = rx.recv() {
            on_key(&app, &sh, &id);
        }
    });
    std::thread::spawn(|| unsafe {
        let hmod = GetModuleHandleW(None).ok().map(|h| HINSTANCE(h.0));
        if let Err(e) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), hmod, 0) {
            eprintln!("[timer hook] {e}");
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
    });
}

/// Background ticker: countdown sounds, the "time is up" sound, overlay updates.
pub fn spawn_ticker(app: AppHandle, sh: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut had_any = false;
        let mut last_emit = 0u64;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let now = monitor::now_ms();
            if RUNS.lock().is_empty() {
                if had_any {
                    had_any = false;
                    emit(&app);
                    // hide the overlay again unless the buff monitor (or edit mode) still needs it
                    if sh.run.lock().is_none() && !sh.edit_mode.load(Ordering::Relaxed) {
                        crate::hide_overlay(&app);
                    }
                }
                continue;
            }
            had_any = true;
            let settings = sh.cfg.lock()["settings"].clone();
            let snd = &settings["sound"];
            let volume = snd["volume"].as_f64().unwrap_or(0.45) as f32;
            let pre_on = snd["prewarnMode"].as_str() != Some("off");
            let mut logs = Vec::new();
            {
                let mut runs = RUNS.lock();
                for (_, r) in runs.iter_mut() {
                    let rem = r.ends_at as i64 - now as i64;
                    if rem > 0 {
                        let sec = ((rem + 999) / 1000) as usize;
                        if r.prewarn && pre_on && (1..=5).contains(&sec) && !r.prewarned[sec] && r.duration > 5000 {
                            r.prewarned[sec] = true;
                            let (en, src) = match sec {
                                5 => ("prewarnFiveEnabled", "prewarnFiveSource"),
                                4 => ("prewarnFourEnabled", "prewarnFourSource"),
                                3 => ("prewarnThreeEnabled", "prewarnThreeSource"),
                                2 => ("prewarnTwoEnabled", "prewarnTwoSource"),
                                _ => ("prewarnOneEnabled", "prewarnOneSource"),
                            };
                            if snd[en].as_bool() != Some(false) {
                                if let Some(s) = snd.get(src) {
                                    monitor::play_source(&sh, s, volume);
                                }
                            }
                        }
                    } else if !r.done {
                        r.done = true;
                        if snd["triggerEnabled"].as_bool() != Some(false) {
                            let src = if r.sound.is_object() { Some(r.sound.clone()) } else { snd.get("triggerSource").cloned() };
                            if let Some(s) = src {
                                monitor::play_source(&sh, &s, volume);
                            }
                        }
                        logs.push(format!("Hẹn giờ “{}”: hết giờ", r.name));
                    }
                }
                runs.retain(|(_, r)| !(r.done && now > r.ends_at + SHOW_DONE_MS));
            }
            for m in logs {
                let _ = app.emit("buff-assistant-execution-log", m);
            }
            if now.saturating_sub(last_emit) >= 250 {
                last_emit = now;
                emit(&app);
            }
        }
    });
}

/// Rebuild the key bindings from the config. Returns one message per timer whose key is unusable.
pub fn register_all(cfg: &Value) -> Vec<String> {
    let monitor_hk = cfg["settings"]["hotkey"].as_str().unwrap_or("").trim().to_ascii_uppercase();
    let mut binds = Vec::new();
    let mut errors = Vec::new();
    for t in cfg["timers"].as_array().into_iter().flatten() {
        let hk = t["hotkey"].as_str().unwrap_or("").trim();
        let (Some(id), true) = (t["id"].as_str(), t["enabled"].as_bool() != Some(false)) else { continue };
        if hk.is_empty() {
            continue;
        }
        let name = t["name"].as_str().unwrap_or(id);
        if hk.to_ascii_uppercase() == monitor_hk {
            errors.push(format!("“{name}”: phím {hk} đang dùng để bật/tắt theo dõi"));
            continue;
        }
        match hotkey::parse(hk) {
            Ok(Some((m, vk))) => binds.push((id.to_string(), m.0, vk)),
            Ok(None) => {}
            Err(e) => errors.push(format!("“{name}”: {e}")),
        }
    }
    *BINDS.lock() = binds;
    errors
}
