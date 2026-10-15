fn main() {
    build_mago_prelude();
    tauri_build::build()
}

/// Encodes PHP's built-in definitions for Mago's analyzer into OUT_DIR/prelude.bin,
/// the same way the Mago CLI does. Building it needs a large stack.
fn build_mago_prelude() {
    let out = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("prelude.bin");
    let bytes = std::thread::Builder::new()
        .stack_size(36 * 1024 * 1024)
        .name("mago-prelude".into())
        .spawn(|| mago_prelude::Prelude::build().encode().expect("encode Mago prelude"))
        .expect("spawn prelude builder")
        .join()
        .expect("build Mago prelude");
    std::fs::write(out, bytes).expect("write prelude.bin");
}
