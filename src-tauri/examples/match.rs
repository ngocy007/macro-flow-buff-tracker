use macro_flow_lib::capture::Frame;
use macro_flow_lib::detect::*;
use std::time::Instant;
fn load(p: &str) -> Frame {
    let i = image::open(p).unwrap().to_rgba8();
    Frame { w: i.width(), h: i.height(), rgba: i.into_raw() }
}
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let full = load(&a[1]);
    let n = |i: usize| -> u32 { a[i].parse().unwrap() };
    // template crop
    let (tx, ty, tw, th) = (n(2), n(3), n(4), n(5));
    let img = image::RgbaImage::from_raw(full.w, full.h, full.rgba.clone()).unwrap();
    let t = image::imageops::crop_imm(&img, tx, ty, tw, th).to_image();
    t.save(&a[6]).unwrap();
    let mut png = Vec::new();
    t.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let tpl = Template::from_png(&png).unwrap();
    for target in &a[7..] {
        let f = load(target);
        let g = Gray::from_frame(&f);
        let t0 = Instant::now();
        let region = (0, 0, (f.w as f32 * 0.7) as usize, f.h as usize);
        let hit = search(&g, region, &tpl, &[0.7, 0.8, 0.9, 1.0, 1.1, 1.2]);
        println!("{target}: {:?}  ({} ms)  colour_diff={:?}", hit, t0.elapsed().as_millis(), hit.map(|h| tpl.colour_diff(&f, &h)));
    }
}
