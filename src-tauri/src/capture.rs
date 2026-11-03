//! Window enumeration + GDI screen capture (client area of a window).
//! The original also had DXGI / Windows.Graphics.Capture engines; GDI is the simple fallback
//! (the game window must be visible and not covered by another window).

use serde::Serialize;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetClientRect, GetWindowLongW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: String,
    pub process_name: String,
    pub window_title: String,
    pub class_name: String,
    pub width: u32,
    pub height: u32,
}

pub struct Frame {
    pub w: u32,
    pub h: u32,
    /// RGBA, row-major
    pub rgba: Vec<u8>,
}

fn hwnd_from_id(id: &str) -> Option<HWND> {
    let n: usize = id.parse().ok()?;
    Some(HWND(n as *mut core::ffi::c_void))
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn process_name(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return String::new();
        }
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 520];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(h);
        if ok.is_err() {
            return String::new();
        }
        let full = String::from_utf16_lossy(&buf[..size as usize]);
        full.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    }
}

fn client_size(hwnd: HWND) -> (u32, u32) {
    unsafe {
        let mut r = RECT::default();
        if GetClientRect(hwnd, &mut r).is_ok() {
            ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32)
        } else {
            (0, 0)
        }
    }
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return BOOL(1);
    }
    let mut title = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut title);
    if n <= 0 {
        return BOOL(1);
    }
    let (w, h) = client_size(hwnd);
    if w < 200 || h < 150 {
        return BOOL(1);
    }
    let mut cls = [0u16; 256];
    let cn = GetClassNameW(hwnd, &mut cls);
    let class_name = if cn > 0 { wide_to_string(&cls) } else { String::new() };
    out.push(WindowInfo {
        id: (hwnd.0 as usize).to_string(),
        process_name: process_name(hwnd),
        window_title: wide_to_string(&title),
        class_name,
        width: w,
        height: h,
    });
    BOOL(1)
}

pub fn list_windows(skip_titles: &[&str]) -> Vec<WindowInfo> {
    let mut v: Vec<WindowInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut v as *mut _ as isize));
    }
    v.retain(|w| !skip_titles.iter().any(|t| w.window_title == *t));
    v
}

/// Re-resolve a window by the saved target (process name + title), falling back to class name.
pub fn find_target(process: &str, title: &str, class_name: &str) -> Option<WindowInfo> {
    let list = list_windows(&[]);
    let p = process.to_lowercase();
    list.iter()
        .find(|w| w.window_title == title && (p.is_empty() || w.process_name.to_lowercase() == p))
        .or_else(|| {
            if class_name.is_empty() {
                None
            } else {
                list.iter().find(|w| w.class_name == class_name && w.window_title == title)
            }
        })
        .cloned()
}

pub fn window_alive(id: &str) -> bool {
    match hwnd_from_id(id) {
        Some(h) => unsafe { IsWindow(Some(h)).as_bool() && !IsIconic(h).as_bool() },
        None => false,
    }
}

fn looks_black(buf: &[u8]) -> bool {
    // sample ~2000 pixels; a blank capture is (almost) entirely black
    let n = buf.len() / 4;
    if n == 0 {
        return true;
    }
    let step = (n / 2000).max(1);
    let mut lit = 0usize;
    let mut seen = 0usize;
    let mut i = 0usize;
    while i < n {
        let p = &buf[i * 4..i * 4 + 3];
        if p[0] as u32 + p[1] as u32 + p[2] as u32 > 24 {
            lit += 1;
        }
        seen += 1;
        i += step;
    }
    lit * 50 < seen
}

/// Capture the client area of a window.
/// 1) PrintWindow(PW_RENDERFULLCONTENT|PW_CLIENTONLY): asks DWM for the window's own content, so it
///    works even when other windows cover the game. 2) falls back to a screen BitBlt (needs the game visible).
pub fn capture(id: &str) -> Result<Frame, String> {
    let hwnd = hwnd_from_id(id).ok_or("windowId không hợp lệ")?;
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("Cửa sổ game không còn tồn tại".into());
        }
        if IsIconic(hwnd).as_bool() {
            return Err("Cửa sổ game đang thu nhỏ (minimize)".into());
        }
        let (w, h) = client_size(hwnd);
        if w == 0 || h == 0 {
            return Err("Cửa sổ game có kích thước 0".into());
        }
        let mut pt = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut pt).as_bool() {
            return Err("ClientToScreen thất bại".into());
        }
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC thất bại".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w as i32, h as i32);
        let old = SelectObject(mem, bmp.into());

        let mut bi = BITMAPINFO::default();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let mut ok = false;

        // 1) window content straight from DWM (not affected by overlapping windows)
        if PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(3)).as_bool() {
            let lines = GetDIBits(mem, bmp, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
            ok = lines != 0 && !looks_black(&buf);
        }
        // 2) fallback: copy from the screen
        if !ok {
            let blt = BitBlt(mem, 0, 0, w as i32, h as i32, Some(screen), pt.x, pt.y, SRCCOPY | CAPTUREBLT);
            let lines = GetDIBits(mem, bmp, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
            ok = blt.is_ok() && lines != 0;
        }

        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if !ok {
            return Err("Chụp màn hình thất bại".into());
        }
        // BGRA -> RGBA, opaque
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        Ok(Frame { w, h, rgba: buf })
    }
}
