//! Build the app icon set from one square source image.
//! usage: cargo run --release --example mkicon -- <source.png> <icons_dir> <ui_dir>
use image::imageops::FilterType;
use image::ImageEncoder;

fn png_bytes(img: &image::RgbaImage) -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new_with_quality(
        &mut out,
        image::codecs::png::CompressionType::Best,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
    .unwrap();
    out
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let src = image::open(&a[1]).expect("open source").to_rgba8();
    let (w, h) = (src.width(), src.height());
    assert_eq!(w, h, "source must be square");
    let icons_dir = std::path::Path::new(&a[2]);
    let ui_dir = std::path::Path::new(&a[3]);
    std::fs::create_dir_all(icons_dir).unwrap();

    let scaled = |s: u32| image::imageops::resize(&src, s, s, FilterType::Lanczos3);

    // Windows .ico with PNG-compressed entries
    let sizes = [16u32, 24, 32, 48, 64, 128, 256];
    let blobs: Vec<(u32, Vec<u8>)> = sizes.iter().map(|&s| (s, png_bytes(&scaled(s)))).collect();
    let mut ico = Vec::new();
    ico.extend_from_slice(&0u16.to_le_bytes());
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&(blobs.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * blobs.len() as u32;
    for (s, b) in &blobs {
        let dim = if *s >= 256 { 0u8 } else { *s as u8 };
        ico.extend_from_slice(&[dim, dim, 0, 0]);
        ico.extend_from_slice(&1u16.to_le_bytes()); // planes
        ico.extend_from_slice(&32u16.to_le_bytes()); // bpp
        ico.extend_from_slice(&(b.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += b.len() as u32;
    }
    for (_, b) in &blobs {
        ico.extend_from_slice(b);
    }
    std::fs::write(icons_dir.join("icon.ico"), &ico).unwrap();

    // PNGs used as the window icon / bundle icons
    std::fs::write(icons_dir.join("icon.png"), png_bytes(&scaled(512))).unwrap();
    std::fs::write(icons_dir.join("128x128.png"), png_bytes(&scaled(128))).unwrap();
    std::fs::write(icons_dir.join("32x32.png"), png_bytes(&scaled(32))).unwrap();

    // header logo + favicon for the web UI
    std::fs::write(ui_dir.join("logo.png"), png_bytes(&scaled(128))).unwrap();
    std::fs::write(ui_dir.join("favicon.png"), png_bytes(&scaled(64))).unwrap();
    println!("ok: ico {} bytes, {} sizes", ico.len(), sizes.len());
}
