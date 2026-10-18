// Thin Tauri shell (ADR 0001): the app is an ordinary web frontend speaking
// OSSP to the user's daemon via @opensocket/client. No custom Rust commands
// for v1 — HTTP/WS go straight from the webview (CORS is enabled daemon-side,
// and the daemon's WS handshake has no origin check).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
