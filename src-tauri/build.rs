fn main() {
    println!("cargo:rerun-if-env-changed=BUILD_NUMBER");
    tauri_build::build()
}
