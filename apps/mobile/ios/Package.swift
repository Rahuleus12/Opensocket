// swift-tools-version: 6.0

// OpenSocket iOS shell (xtool/SwiftPM, built on Linux via `xtool dev build`).
// The app is a thin WKWebView wrapper around the Preact frontend built by the
// sibling vite project (`npm run build:mobile`, then `npm run sync:ios` copies
// dist/ into ios/www/). All OSSP transport lives in @opensocket/client inside
// the webview; no Rust, no custom native bridge for v1 (ADR 0001).
import PackageDescription

let package = Package(
    name: "OpenSocket",
    platforms: [
        .iOS(.v17),
    ],
    products: [
        // An xtool project should contain exactly one library product,
        // representing the main app.
        .library(
            name: "OpenSocket",
            targets: ["OpenSocket"]
        ),
    ],
    targets: [
        .target(
            name: "OpenSocket"
        ),
    ]
)
