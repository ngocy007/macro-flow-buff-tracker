use macro_flow_lib::capture::Frame;
use macro_flow_lib::detect::*;
fn load(p: &str) -> Frame { let i = image::open(p).unwrap().to_rgba8(); Frame { w: i.width(), h: i.height(), rgba: i.into_raw() } }
// usage: neg <src.png> tx ty tw th <out_tpl.png> <target.png> [blank_x blank_y blank_w blank_h]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n = |i: usize| -> u32 { a[i].parse().unwrap() };
    let src = load(&a[1]);
    let img = image::RgbaImage::from_raw(src.w, src.h, src.rgba.clone()).unwrap();
    let t = image::imageops::crop_imm(&img, n(2), n(3), n(4), n(5)).to_image();
    t.save(&a[6]).unwrap();
    let mut png = Vec::new();
    t.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    let tpl = Template::from_png(&png).unwrap();
    let mut f = load(&a[7]);
    if a.len() > 11 {
        let (bx, by, bw, bh) = (n(8), n(9), n(10), n(11));
        for y in by..by + bh { for x in bx..bx + bw { let i = ((y * f.w + x) * 4) as usize; f.rgba[i] = 90; f.rgba[i + 1] = 90; f.rgba[i + 2] = 90; } }
    }
    let g = Gray::from_frame(&f);
    let hit = search(&g, (0, 0, (f.w as f32 * 0.3) as usize, (f.h as f32 * 0.7) as usize), &tpl, &[1.0]);
    println!("{} blank={}: {:?}", a[7].rsplit('/').next().unwrap(), a.len() > 11, hit.map(|h| (h.score, h.x, h.y)));
}
