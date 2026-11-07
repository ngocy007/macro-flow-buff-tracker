//! Global hotkey (Win32 RegisterHotKey) on its own message-loop thread: works while the game has focus.

use parking_lot::Mutex;
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

type Reply = Sender<Result<(), String>>;
struct Req {
    id: i32,
    key: Option<(HOT_KEY_MODIFIERS, u32)>,
    reply: Reply,
}

static THREAD_ID: OnceLock<u32> = OnceLock::new();
static PENDING: Mutex<Option<Req>> = Mutex::new(None);
const WM_REBIND: u32 = WM_APP + 1;

/// "Ctrl+Alt+F8" -> (modifiers, virtual-key). Empty string = no hotkey.
pub fn parse(s: &str) -> Result<Option<(HOT_KEY_MODIFIERS, u32)>, String> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let mut mods = HOT_KEY_MODIFIERS(0);
    let mut vk: Option<u32> = None;
    for part in s.split('+').map(|p| p.trim()).filter(|p| !p.is_empty()) {
        let up = part.to_ascii_uppercase();
        match up.as_str() {
            "CTRL" | "CONTROL" => mods |= MOD_CONTROL,
            "ALT" => mods |= MOD_ALT,
            "SHIFT" => mods |= MOD_SHIFT,
            "WIN" | "META" | "SUPER" => mods |= MOD_WIN,
            _ => {
                if vk.is_some() {
                    return Err(format!("Phím tắt có hơn một phím chính: “{s}”"));
                }
                vk = Some(key_code(&up).ok_or_else(|| format!("Không nhận ra phím “{part}”"))?);
            }
        }
    }
    let vk = vk.ok_or("Phím tắt cần có một phím chính (ví dụ F8)")?;
    Ok(Some((mods, vk)))
}

pub fn key_code(k: &str) -> Option<u32> {
    let b = k.as_bytes();
    if b.len() == 1 && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit()) {
        return Some(b[0] as u32);
    }
    if let Some(n) = k.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=24).contains(&n) {
            return Some(VK_F1.0 as u32 + n - 1);
        }
    }
    if let Some(n) = k.strip_prefix("NUM").and_then(|n| n.parse::<u32>().ok()) {
        if n <= 9 {
            return Some(VK_NUMPAD0.0 as u32 + n);
        }
    }
    Some(match k {
        "SPACE" => VK_SPACE.0,
        "TAB" => VK_TAB.0,
        "ENTER" | "RETURN" => VK_RETURN.0,
        "ESC" | "ESCAPE" => VK_ESCAPE.0,
        "CAPSLOCK" => VK_CAPITAL.0,
        "BACKSPACE" => VK_BACK.0,
        "INSERT" => VK_INSERT.0,
        "DELETE" => VK_DELETE.0,
        "HOME" => VK_HOME.0,
        "END" => VK_END.0,
        "PAGEUP" => VK_PRIOR.0,
        "PAGEDOWN" => VK_NEXT.0,
        "UP" => VK_UP.0,
        "DOWN" => VK_DOWN.0,
        "LEFT" => VK_LEFT.0,
        "RIGHT" => VK_RIGHT.0,
        "`" => VK_OEM_3.0,
        "-" => VK_OEM_MINUS.0,
        "=" => VK_OEM_PLUS.0,
        "[" => VK_OEM_4.0,
        "]" => VK_OEM_6.0,
        ";" => VK_OEM_1.0,
        "'" => VK_OEM_7.0,
        "," => VK_OEM_COMMA.0,
        "." => VK_OEM_PERIOD.0,
        "/" => VK_OEM_2.0,
        "\\" => VK_OEM_5.0,
        _ => return None,
    } as u32)
}

/// Hotkey id of the "start / stop monitoring" combo; macros use ids from `MACRO_BASE` up.
pub const MONITOR_ID: i32 = 1;
pub const MACRO_BASE: i32 = 100;

/// Start the hotkey thread once; `on_press(id)` runs on that thread each time a registered hotkey fires.
pub fn spawn(on_press: impl Fn(i32) + Send + 'static) {
    let (ready_tx, ready_rx) = channel::<u32>();
    std::thread::spawn(move || unsafe {
        let mut msg = MSG::default();
        // force creation of this thread's message queue before anyone posts to it
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
        let _ = ready_tx.send(GetCurrentThreadId());
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                on_press(msg.wParam.0 as i32);
            } else if msg.message == WM_REBIND {
                if let Some(req) = PENDING.lock().take() {
                    let _ = UnregisterHotKey(None, req.id);
                    let res = match req.key {
                        None => Ok(()),
                        Some((m, vk)) => RegisterHotKey(None, req.id, m | MOD_NOREPEAT, vk)
                            .map_err(|_| "Phím tắt này đã bị chương trình khác (hoặc phím tắt khác trong app) chiếm, hãy chọn tổ hợp khác".to_string()),
                    };
                    let _ = req.reply.send(res);
                }
            }
        }
    });
    if let Ok(id) = ready_rx.recv() {
        let _ = THREAD_ID.set(id);
    }
}

/// Register (or clear, with an empty string) the monitor start/stop hotkey.
pub fn set(combo: &str) -> Result<(), String> {
    set_id(MONITOR_ID, combo)
}

/// Register (or clear) the hotkey with this id. Returns the error if the OS refuses it.
pub fn set_id(id: i32, combo: &str) -> Result<(), String> {
    static SERIAL: Mutex<()> = Mutex::new(());
    let _one_at_a_time = SERIAL.lock();
    let key = parse(combo)?;
    let tid = *THREAD_ID.get().ok_or("Luồng phím tắt chưa chạy")?;
    let (tx, rx) = channel();
    *PENDING.lock() = Some(Req { id, key, reply: tx });
    unsafe { PostThreadMessageW(tid, WM_REBIND, WPARAM(0), LPARAM(0)) }.map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "Đăng ký phím tắt quá thời gian".to_string())?
}
