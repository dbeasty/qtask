import AppKit
import QTaskCore
import WebKit

/// The page's only way out. bridge.js turns the client's `fetch('/api/…')` into a message;
/// this answers it by asking the local server (see BackendHTTP), never anything else.
///
/// Messages are `{op, …}` objects posted to `window.webkit.messageHandlers.qtask`:
///   fetch    {method, path, headers, body?: base64}  → {status, headers, text | body: base64}
///   changed  {path}                                  → a write succeeded (refreshes the Dock badge)
///
/// A request whose path is not under /api/ (or /health) is refused here, so even a page
/// that posts messages by hand cannot use the bridge to reach another address.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
  private let http: BackendHTTP
  var onChanged: (() -> Void)?
  /// Counts forwarded requests; the e2e suite reads it to prove the page used the bridge.
  private(set) var forwarded = 0
  private(set) var refused = 0

  init(http: BackendHTTP) { self.http = http }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage,
    replyHandler: @escaping (Any?, String?) -> Void
  ) {
    guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
      refused += 1
      replyHandler(nil, "malformed message")
      return
    }
    switch op {
    case "fetch":
      handleFetch(body, reply: replyHandler)
    case "changed":
      onChanged?()
      replyHandler(NSNull(), nil)
    default:
      refused += 1
      replyHandler(nil, "unknown op")
    }
  }

  private func handleFetch(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
    guard let method = body["method"] as? String, let path = body["path"] as? String else {
      refused += 1
      reply(nil, "malformed fetch")
      return
    }
    guard RequestPolicy.isAllowedMethod(method), RequestPolicy.isAllowedPath(path) else {
      refused += 1
      reply(nil, "not part of the app's API")
      return
    }
    var headers: [String: String] = [:]
    if let h = body["headers"] as? [String: Any] {
      for (k, v) in h { if let s = v as? String { headers[k] = s } }
    }
    let payload: Data? = (body["body"] as? String).flatMap { Data(base64Encoded: $0) }
    forwarded += 1
    let http = self.http
    Task {
      do {
        let r = try await http.send(method: method, path: path, headers: headers, body: payload)
        var out: [String: Any] = ["status": r.status, "headers": r.headers]
        let type = r.headers["content-type"]?.lowercased() ?? ""
        if (type.hasPrefix("application/json") || type.hasPrefix("text/")), let text = String(data: r.body, encoding: .utf8) {
          out["text"] = text
        } else {
          out["body"] = r.body.base64EncodedString()
        }
        await MainActor.run { reply(out, nil) }
      } catch {
        await MainActor.run { reply(nil, "\(error)") }
      }
    }
  }
}
