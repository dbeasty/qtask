import AppKit
import QTaskCore
import WebKit

/// One web view showing the client from `app://qtask/`.
///
/// What keeps it off the network:
///  * the page is served by this class (an `app:` scheme handler); nothing is loaded over http(s);
///  * every response carries a content security policy with `connect-src 'none'`, and
///    index.html also carries it as a meta tag, so a fetch/XHR/WebSocket/EventSource that
///    bypasses bridge.js is refused by the engine;
///  * navigation to anything but the app's own address is cancelled (links to http(s) and
///    mailto open in the default browser, when the user clicks them);
///  * new windows are never created.
@MainActor
final class WebController: NSObject, WKNavigationDelegate, WKUIDelegate, WKURLSchemeHandler {
  private(set) var webView: WKWebView!
  private let assets: WebAssets
  private var stopped = Set<ObjectIdentifier>()
  /// Console output and security policy violations, for the e2e control folder.
  var onLog: ((String) -> Void)?
  var onPageLoaded: (() -> Void)?
  var onProcessTerminated: (() -> Void)?
  private(set) var pageLoads = 0

  init(layout: BundleLayout, bridge: Bridge, interceptConsole: Bool) {
    assets = WebAssets(root: layout.web)
    let config = WKWebViewConfiguration()
    let controller = WKUserContentController()

    if let source = try? String(contentsOf: layout.bridgeScript, encoding: .utf8) {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    if interceptConsole {
      controller.addUserScript(WKUserScript(source: WebController.consoleHook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    controller.addScriptMessageHandler(bridge, contentWorld: .page, name: "qtask")
    config.userContentController = controller
    config.websiteDataStore = .default()
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.preferences.isFraudulentWebsiteWarningEnabled = false
    super.init()
    // The handler must be registered before the web view copies the configuration.
    config.setURLSchemeHandler(self, forURLScheme: WebAssets.scheme)
    webView = WKWebView(frame: .zero, configuration: config)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
    #if QTASK_E2E
      if #available(macOS 13.3, *) { webView.isInspectable = true }
    #endif
  }

  func load() {
    webView.load(URLRequest(url: URL(string: "\(WebAssets.origin)/")!))
  }

  func reload() { webView.reload() }

  /// Tells the page about a menu command; the client listens for `qtask:command`.
  func sendCommand(_ command: String) {
    let js = "window.__qtaskDesktop && window.__qtaskDesktop.event({name:'command',payload:\(Self.jsString(command))})"
    webView.evaluateJavaScript(js, completionHandler: nil)
  }

  private static func jsString(_ s: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
    let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
  }

  // Forwards console output and CSP violations to the message handler-free log hook below.
  static let consoleHook = """
    (function () {
      var out = [];
      window.__qtaskLog = out;
      ['log', 'info', 'warn', 'error'].forEach(function (level) {
        var orig = console[level].bind(console);
        console[level] = function () {
          try { out.push(level + ': ' + Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ')); } catch (e) {}
          if (out.length > 500) out.shift();
          return orig.apply(null, arguments);
        };
      });
      document.addEventListener('securitypolicyviolation', function (e) {
        out.push('csp: blocked ' + e.violatedDirective + ' ' + e.blockedURI);
        window.__qtaskCsp = (window.__qtaskCsp || []).concat([{ directive: e.violatedDirective, uri: e.blockedURI }]);
      });
      window.addEventListener('error', function (e) { out.push('error: ' + e.message); });
    })();
    """

  // MARK: WKURLSchemeHandler

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    guard let url = urlSchemeTask.request.url else {
      urlSchemeTask.didFailWithError(URLError(.badURL))
      return
    }
    guard let resolved = assets.resolve(url: url), var data = try? Data(contentsOf: resolved.file) else {
      respond(urlSchemeTask, url: url, status: 404, mime: "text/plain; charset=utf-8", data: Data("Not found".utf8))
      return
    }
    if resolved.file.lastPathComponent == "index.html", var html = String(data: data, encoding: .utf8),
      let range = html.range(of: "<head>")
    {
      // Belt and braces: the header carries the policy too, but a meta tag does not depend
      // on how the engine treats headers from a custom scheme.
      let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(WebAssets.contentSecurityPolicy)\">"
      html.insert(contentsOf: meta, at: range.upperBound)
      data = Data(html.utf8)
    }
    respond(urlSchemeTask, url: url, status: 200, mime: resolved.mimeType, data: data)
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    stopped.insert(ObjectIdentifier(urlSchemeTask as AnyObject))
  }

  private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
    // Answered synchronously, so the task cannot have been stopped yet.
    let headers = WebAssets.headers(mimeType: mime, length: data.count)
    guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
    else {
      task.didFailWithError(URLError(.cannotParseResponse))
      return
    }
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  // MARK: WKNavigationDelegate

  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    if url.scheme == WebAssets.scheme && url.host == WebAssets.host { return decisionHandler(.allow) }
    if url.scheme == "about" { return decisionHandler(.allow) }
    // A link the user clicked opens where the user would expect; nothing loads in-app.
    if navigationAction.navigationType == .linkActivated, ["http", "https", "mailto"].contains(url.scheme ?? "") {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    pageLoads += 1
    onPageLoaded?()
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    onLog?("web content process terminated; reloading")
    onProcessTerminated?()
    webView.reload()
  }

  // MARK: WKUIDelegate

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.beginSheetModal(for: webView.window ?? NSApp.mainWindow ?? NSWindow()) { _ in completionHandler() }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: webView.window ?? NSApp.mainWindow ?? NSWindow()) {
      completionHandler($0 == .alertFirstButtonReturn)
    }
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
  }
}
