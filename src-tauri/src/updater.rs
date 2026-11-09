//! Self-update from GitHub Releases.
//!
//! CI publishes a release tagged `build-<run_number>` with `TroThuBuff.zip` (folder `TroThuBuff/`
//! holding `TroThuBuff.exe` + `payload/`). The running build number is baked in at compile time
//! through the `BUILD_NUMBER` env var. A running exe cannot be overwritten on Windows but it can be
//! renamed, so the install is: extract -> rename exe to `.old` -> move new exe in -> relaunch.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

const REPO: &str = "ngocy007/macro-flow-buff-tracker";
const ASSET: &str = "TroThuBuff.zip";
const UA: &str = "TroThuBuff-updater";

/// Build number of this binary (0 for local/dev builds).
pub fn current_build() -> u64 {
    option_env!("BUILD_NUMBER").and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

pub fn current_label() -> String {
    match current_build() {
        0 => format!("{} (dev)", env!("CARGO_PKG_VERSION")),
        n => format!("build {n}"),
    }
}

struct Latest {
    build: u64,
    tag: String,
    notes: String,
    url: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(30))
        .user_agent(UA)
        .build()
}

fn fetch_latest() -> Result<Latest, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let v: Value = agent()
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Không kết nối được máy chủ cập nhật: {e}"))?
        .into_json()
        .map_err(|e| format!("Phản hồi cập nhật không hợp lệ: {e}"))?;
    let tag = v["tag_name"].as_str().unwrap_or("").to_string();
    let build = tag.trim_start_matches("build-").parse::<u64>().map_err(|_| format!("Tên bản phát hành lạ: {tag}"))?;
    let url = v["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["name"] == ASSET))
        .and_then(|x| x["browser_download_url"].as_str())
        .ok_or_else(|| format!("Bản {tag} không có file {ASSET}"))?
        .to_string();
    Ok(Latest { build, tag, notes: v["body"].as_str().unwrap_or("").to_string(), url })
}

/// `{currentVersion, currentBuild, update: null | {version, notes}}`
pub fn check() -> Result<Value, String> {
    let cur = current_build();
    let l = fetch_latest()?;
    let update = if l.build > cur { json!({ "version": l.tag, "build": l.build, "notes": l.notes }) } else { Value::Null };
    Ok(json!({ "currentVersion": current_label(), "currentBuild": cur, "update": update }))
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(120))
        .user_agent(UA)
        .build()
        .get(url)
        .call()
        .map_err(|e| format!("Tải bản cập nhật thất bại: {e}"))?;
    let mut buf = Vec::new();
    resp.into_reader().take(300 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| format!("Tải bản cập nhật thất bại: {e}"))?;
    Ok(buf)
}

/// Extract everything under `TroThuBuff/` into `dir`. The exe goes to `<exe>.new`, not over the live file.
fn extract(zip_bytes: Vec<u8>, dir: &Path, new_exe: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| format!("File cập nhật hỏng: {e}"))?;
    let mut got_exe = false;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name rejects absolute paths and `..` (zip-slip)
        let Some(rel) = f.enclosed_name() else { continue };
        let rel: PathBuf = rel.components().skip(1).collect(); // drop top "TroThuBuff/"
        if rel.as_os_str().is_empty() || f.is_dir() {
            continue;
        }
        let is_exe = rel.to_string_lossy().eq_ignore_ascii_case("TroThuBuff.exe");
        let out = if is_exe { new_exe.to_path_buf() } else { dir.join(&rel) };
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut o = std::fs::File::create(&out).map_err(|e| format!("Không ghi được {}: {e}", out.display()))?;
        std::io::copy(&mut f, &mut o).map_err(|e| e.to_string())?;
        got_exe |= is_exe;
    }
    if got_exe { Ok(()) } else { Err("File cập nhật không chứa TroThuBuff.exe".into()) }
}

/// Download + swap the exe. Caller relaunches (see `relaunch`).
pub fn install() -> Result<(), String> {
    let l = fetch_latest()?;
    if l.build <= current_build() {
        return Err("Đã là bản mới nhất".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("Không xác định được thư mục cài đặt")?.to_path_buf();
    let new_exe = exe.with_extension("exe.new");
    let old_exe = exe.with_extension("exe.old");

    let bytes = download(&l.url)?;
    extract(bytes, &dir, &new_exe).map_err(|e| {
        let _ = std::fs::remove_file(&new_exe);
        format!("{e}. Nếu app nằm trong thư mục cần quyền (Program Files), hãy chạy bằng Admin hoặc chép sang thư mục khác.")
    })?;

    let _ = std::fs::remove_file(&old_exe);
    std::fs::rename(&exe, &old_exe).map_err(|e| format!("Không thay được file chạy: {e}"))?;
    if let Err(e) = std::fs::rename(&new_exe, &exe) {
        let _ = std::fs::rename(&old_exe, &exe); // roll back
        return Err(format!("Không thay được file chạy: {e}"));
    }
    Ok(())
}

pub fn relaunch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe).spawn().map_err(|e| format!("Không mở lại được app: {e}"))?;
    Ok(())
}

/// Remove leftovers of a previous update (call at startup).
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(exe.with_extension("exe.old"));
        let _ = std::fs::remove_file(exe.with_extension("exe.new"));
    }
}
