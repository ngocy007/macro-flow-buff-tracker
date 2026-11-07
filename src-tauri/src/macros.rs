//! Keyboard / mouse macros: a list of steps played with SendInput (scan codes, so games see real key presses),
//! each macro bound to its own global hotkey. Pressing a running macro's hotkey again stops it.
//!
//! Config shape (`config.macros`, edited by the UI):
//! `{ id, name, enabled, hotkey, repeat: "once" | "count" | "toggle", count, gapMs,
//!    steps: [{ t: "tap", key, holdMs } | { t: "down", key } | { t: "up", key } | { t: "delay", ms } | { t: "click", button, holdMs }] }`

use crate::hotkey;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

struct Running {
    id: String,
    stop: Arc<AtomicBool>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
/// Macro ids in hotkey-slot order: slot i is hotkey id `MACRO_BASE + i`.
static SLOTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Key name (same names as the hotkey field) -> virtual key, including bare modifiers.
fn vk_of(name: &str) -> Option<u16> {
    let up = name.trim().to_ascii_uppercase();
    let vk = match up.as_str() {
        "CTRL" | "CONTROL" => VK_LCONTROL.0,
        "SHIFT" => VK_LSHIFT.0,
        "ALT" => VK_LMENU.0,
        "WIN" | "META" => VK_LWIN.0,
        _ => hotkey::key_code(&up)? as u16,
    };
    Some(vk)
}

fn is_extended(vk: u16) -> bool {
    [VK_INSERT, VK_DELETE, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_UP, VK_DOWN, VK_LEFT, VK_RIGHT, VK_LWIN, VK_RWIN, VK_RCONTROL, VK_RMENU]
        .iter()
        .any(|k| k.0 == vk)
}

fn send_key(vk: u16, up: bool) {
    unsafe {
        let scan = MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16;
        let mut flags = KEYEVENTF_SCANCODE;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        if is_extended(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

fn send_mouse(button: &str, up: bool) {
    let flags = match (button, up) {
        ("right", false) => MOUSEEVENTF_RIGHTDOWN,
        ("right", true) => MOUSEEVENTF_RIGHTUP,
        ("middle", false) => MOUSEEVENTF_MIDDLEDOWN,
        ("middle", true) => MOUSEEVENTF_MIDDLEUP,
        (_, false) => MOUSEEVENTF_LEFTDOWN,
        (_, true) => MOUSEEVENTF_LEFTUP,
    };
    unsafe {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

/// Sleep in small slices so a stop request is honoured within ~5 ms. Returns false if stopped.
fn wait(ms: u64, stop: &AtomicBool) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    loop {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let now = Instant::now();
        if now >= end {
            return true;
        }
        std::thread::sleep((end - now).min(Duration::from_millis(5)));
    }
}

fn emit(app: &AppHandle) {
    let id = RUNNING.lock().as_ref().map(|r| r.id.clone());
    let _ = app.emit("macro-state", json!({ "runningId": id }));
}

fn play_steps(m: &Value, stop: &AtomicBool) -> Result<(), String> {
    let steps = m["steps"].as_array().cloned().unwrap_or_default();
    if steps.is_empty() {
        return Err("Macro chưa có bước nào".into());
    }
    let repeat = m["repeat"].as_str().unwrap_or("once");
    let count = m["count"].as_u64().unwrap_or(1).clamp(1, 100_000);
    let gap = m["gapMs"].as_u64().unwrap_or(0).min(600_000);
    let mut held: Vec<u16> = Vec::new();
    let mut held_mouse: Vec<String> = Vec::new();
    let mut n = 0u64;
    'outer: loop {
        for s in &steps {
            if stop.load(Ordering::Relaxed) {
                break 'outer;
            }
            let key = || vk_of(s["key"].as_str().unwrap_or(""));
            match s["t"].as_str().unwrap_or("") {
                "tap" => {
                    if let Some(vk) = key() {
                        send_key(vk, false);
                        held.push(vk);
                        let ok = wait(s["holdMs"].as_u64().unwrap_or(30).min(60_000), stop);
                        send_key(vk, true);
                        held.retain(|k| *k != vk);
                        if !ok {
                            break 'outer;
                        }
                    }
                }
                "down" => {
                    if let Some(vk) = key() {
                        send_key(vk, false);
                        if !held.contains(&vk) {
                            held.push(vk);
                        }
                    }
                }
                "up" => {
                    if let Some(vk) = key() {
                        send_key(vk, true);
                        held.retain(|k| *k != vk);
                    }
                }
                "delay" => {
                    if !wait(s["ms"].as_u64().unwrap_or(0).min(600_000), stop) {
                        break 'outer;
                    }
                }
                "click" => {
                    let b = s["button"].as_str().unwrap_or("left").to_string();
                    send_mouse(&b, false);
                    held_mouse.push(b.clone());
                    let ok = wait(s["holdMs"].as_u64().unwrap_or(30).min(60_000), stop);
                    send_mouse(&b, true);
                    held_mouse.retain(|x| *x != b);
                    if !ok {
                        break 'outer;
                    }
                }
                _ => {}
            }
        }
        n += 1;
        let more = match repeat {
            "toggle" => true,
            "count" => n < count,
            _ => false,
        };
        if !more || !wait(gap, stop) {
            break;
        }
    }
    // never leave a key or button stuck down
    for vk in held {
        send_key(vk, true);
    }
    for b in held_mouse {
        send_mouse(&b, true);
    }
    Ok(())
}

fn find(cfg: &Value, id: &str) -> Option<Value> {
    cfg["macros"].as_array()?.iter().find(|m| m["id"].as_str() == Some(id)).cloned()
}

/// Stop the running macro (if any). Returns its id.
pub fn stop(app: &AppHandle) -> Option<String> {
    let r = RUNNING.lock().take();
    let id = r.map(|r| {
        r.stop.store(true, Ordering::Relaxed);
        r.id
    });
    emit(app);
    id
}

/// Start a macro from the config; any other running macro is stopped first.
pub fn start(app: &AppHandle, cfg: &Value, id: &str, delay_ms: u64) -> Result<(), String> {
    let m = find(cfg, id).ok_or("Không tìm thấy macro")?;
    if m["steps"].as_array().map_or(true, |a| a.is_empty()) {
        return Err("Macro chưa có bước nào".into());
    }
    stop(app);
    let flag = Arc::new(AtomicBool::new(false));
    *RUNNING.lock() = Some(Running { id: id.to_string(), stop: flag.clone() });
    emit(app);
    let app2 = app.clone();
    let id2 = id.to_string();
    std::thread::spawn(move || {
        let res = if wait(delay_ms.min(60_000), &flag) { play_steps(&m, &flag) } else { Ok(()) };
        {
            let mut cur = RUNNING.lock();
            if cur.as_ref().is_some_and(|r| Arc::ptr_eq(&r.stop, &flag)) {
                *cur = None;
            }
        }
        if let Err(e) = res {
            let _ = app2.emit("buff-assistant-hotkey", format!("Macro: {e}"));
        }
        let _ = app2.emit("buff-assistant-execution-log", format!("Macro “{}” đã dừng", m["name"].as_str().unwrap_or(&id2)));
        emit(&app2);
    });
    Ok(())
}

/// Hotkey press for a macro slot: toggles that macro.
pub fn on_hotkey(app: &AppHandle, cfg: &Value, hotkey_id: i32) {
    let Some(id) = SLOTS.lock().get((hotkey_id - hotkey::MACRO_BASE) as usize).cloned() else { return };
    let running_this = RUNNING.lock().as_ref().is_some_and(|r| r.id == id);
    if running_this {
        stop(app);
        return;
    }
    let name = find(cfg, &id).and_then(|m| m["name"].as_str().map(String::from)).unwrap_or_default();
    match start(app, cfg, &id, 0) {
        Ok(()) => {
            let _ = app.emit("buff-assistant-execution-log", format!("Chạy macro “{name}” (phím tắt)"));
        }
        Err(e) => {
            let _ = app.emit("buff-assistant-hotkey", format!("Macro “{name}”: {e}"));
        }
    }
}

/// (Re)register every enabled macro's hotkey. Returns one message per macro whose hotkey failed.
pub fn register_all(cfg: &Value) -> Vec<String> {
    let mut slots = SLOTS.lock();
    for i in 0..slots.len() {
        let _ = hotkey::set_id(hotkey::MACRO_BASE + i as i32, "");
    }
    slots.clear();
    let monitor = cfg["settings"]["hotkey"].as_str().unwrap_or("").trim().to_ascii_uppercase();
    let mut errors = Vec::new();
    for m in cfg["macros"].as_array().into_iter().flatten() {
        let hk = m["hotkey"].as_str().unwrap_or("").trim();
        let (Some(id), true) = (m["id"].as_str(), m["enabled"].as_bool() != Some(false)) else { continue };
        if hk.is_empty() {
            continue;
        }
        let name = m["name"].as_str().unwrap_or(id);
        if hk.to_ascii_uppercase() == monitor {
            errors.push(format!("“{name}”: phím {hk} đang dùng để bật/tắt theo dõi"));
            continue;
        }
        let slot = hotkey::MACRO_BASE + slots.len() as i32;
        match hotkey::set_id(slot, hk) {
            Ok(()) => slots.push(id.to_string()),
            Err(e) => errors.push(format!("“{name}”: {e}")),
        }
    }
    errors
}
