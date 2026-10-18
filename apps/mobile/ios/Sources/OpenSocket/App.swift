import SwiftUI
import WebKit

/// OpenSocket iOS shell (xtool SwiftPM project): a full-screen WKWebView
/// running the vite-built Preact frontend from the app bundle's www/
/// directory. The frontend speaks OSSP (HTTP + WebSocket) straight to the
/// user's daemon via @opensocket/client — cleartext LAN http is allowed by
/// the ATS exception in Info.plist; TLS via `tailscale serve` off-LAN.
@main
struct OpenSocketApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea()
        }
    }
}

struct ContentView: View {
    var body: some View {
        if let index = Bundle.main.resourceURL?.appendingPathComponent("www/index.html") {
            WebView(url: index)
        } else {
            Text("OpenSocket: bundled frontend missing (www/)")
                .font(.caption)
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x0f / 255, green: 0x11 / 255, blue: 0x15 / 255, alpha: 1)
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // The bundled app origin (file URL) is the only in-app
            // navigation; anything else is the daemon itself (http/ws) or an
            // external link, which the frontend opens deliberately.
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation?,
            withError error: Error
        ) {
            NSLog("OpenSocket webview navigation failed: \(error.localizedDescription)")
        }
    }
}
