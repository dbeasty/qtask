import Foundation

/// The web client's files, served to the web view from `app://qtask/…`.
///
/// The page's origin is the app, so the content security policy can refuse everything
/// else. `connect-src 'none'` is the important part: the only way the page reaches the
/// backend is the bridge (a message to native code), and anything that bypasses the
/// bridge's fetch replacement (XHR, WebSocket, EventSource, a raw fetch to another origin)
/// is refused by the engine.
public struct WebAssets {
  public static let scheme = "app"
  public static let host = "qtask"
  public static var origin: String { "\(scheme)://\(host)" }

  public static let contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].joined(separator: "; ")

  public let root: URL

  public init(root: URL) { self.root = root.standardizedFileURL }

  public struct Resolved {
    public let file: URL
    public let mimeType: String
  }

  /// Maps a request URL to a file under `root`. A path without an extension is a client
  /// route (`/projects`) and gets `index.html`, as on the hosted site. Anything that
  /// escapes `root`, and anything under `/api/`, is not an asset.
  public func resolve(url: URL) -> Resolved? {
    guard url.scheme == Self.scheme, url.host == Self.host else { return nil }
    var path = url.path
    if path.isEmpty { path = "/" }
    if path.hasPrefix("/api/") || path == "/health" { return nil }
    let decoded = path.removingPercentEncoding ?? path
    if decoded.contains("\0") || decoded.contains("\\") { return nil }
    let components = decoded.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    if components.contains("..") || components.contains(".") { return nil }

    var candidate = root
    for c in components { candidate.appendPathComponent(c) }
    let hasExtension = !(components.last ?? "").isEmpty && (components.last ?? "").contains(".")
    if components.isEmpty || !hasExtension {
      candidate = root.appendingPathComponent("index.html")
    }
    candidate = candidate.standardizedFileURL
    guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else { return nil }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir), !isDir.boolValue else {
      return nil
    }
    return Resolved(file: candidate, mimeType: Self.mimeType(forExtension: candidate.pathExtension))
  }

  public static func mimeType(forExtension ext: String) -> String {
    switch ext.lowercased() {
    case "html", "htm": return "text/html; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json", "map": return "application/json; charset=utf-8"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "gif": return "image/gif"
    case "ico": return "image/x-icon"
    case "webp": return "image/webp"
    case "woff": return "font/woff"
    case "woff2": return "font/woff2"
    case "txt": return "text/plain; charset=utf-8"
    default: return "application/octet-stream"
    }
  }

  public static func headers(mimeType: String, length: Int) -> [String: String] {
    [
      "Content-Type": mimeType,
      "Content-Length": String(length),
      "Content-Security-Policy": contentSecurityPolicy,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    ]
  }
}
