use image::imageops::FilterType;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let img = image::open(&a[1]).unwrap().to_rgba8();
    let (x, y, w, h, s): (u32, u32, u32, u32, u32) = (a[2].parse().unwrap(), a[3].parse().unwrap(), a[4].parse().unwrap(), a[5].parse().unwrap(), a[6].parse().unwrap());
    let c = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    let c = image::imageops::resize(&c, w * s, h * s, FilterType::Nearest);
    c.save(&a[7]).unwrap();
}
