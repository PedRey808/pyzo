import UIKit
import WebKit

/// The whole game is game/index.html from the app bundle, shown in a WKWebView.
final class GameViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var web: WKWebView!
    private let darkBg = UIColor(red: 0x1B / 255.0, green: 0x16 / 255.0, blue: 0x50 / 255.0, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // keeps localStorage (name, theme, saved games)
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "MagnatIOS/1"
        let scripts = WKUserContentController()
        scripts.add(WeakMessageHandler(self), name: "magnat")
        config.userContentController = scripts

        web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = darkBg
        web.scrollView.backgroundColor = darkBg
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = darkBg
        guard let dir = Bundle.main.url(forResource: "game", withExtension: nil) else { return }
        web.loadFileURL(dir.appendingPathComponent("index.html"), allowingReadAccessTo: dir)
    }

    // MARK: messages from the page: window.webkit.messageHandlers.magnat.postMessage({...})
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["t"] as? String else { return }
        switch type {
        case "share":
            let text = body["text"] as? String ?? ""
            let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            if let pop = sheet.popoverPresentationController {   // iPad
                pop.sourceView = view
                pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            present(sheet, animated: true)
        case "vibrate":
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "bar":
            if let hex = body["color"] as? String, let color = UIColor(hex: hex) {
                view.backgroundColor = color
                web.backgroundColor = color
                web.scrollView.backgroundColor = color
            }
        default:
            break
        }
    }

    // MARK: alert / confirm / prompt from JavaScript
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }

    // MARK: navigation: links to other sites open in Safari
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let scheme = url.scheme, scheme != "file", scheme != "about",
           action.targetFrame?.isMainFrame ?? true {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// Avoids a retain cycle between WKUserContentController and the view controller.
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

extension UIColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255.0,
                  green: CGFloat((v >> 8) & 0xFF) / 255.0,
                  blue: CGFloat(v & 0xFF) / 255.0,
                  alpha: 1)
    }
}
