import Foundation

/// What the page is allowed to ask the app to fetch on its behalf.
///
/// The page names a *path*, never a host: this builds the loopback URL itself, so no
/// script in the web view can use the bridge to reach anything but the local server.
public enum RequestPolicy {
  public static let allowedMethods: Set<String> = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]

  /// Headers the page may not set; the app adds its own where needed.
  static let blockedHeaders: Set<String> = [
    "host", "origin", "referer", "cookie", "content-length", "connection", "transfer-encoding",
    "x-qtask-device-token",
  ]

  public static let maxBodyBytes = 32 * 1024 * 1024

  /// A path the bridge will forward: `/health` or anything under `/api/`.
  /// Rejects anything that could name another resource once it is joined to the loopback
  /// origin: no dot segments, no backslashes, no control characters, no scheme or
  /// authority smuggled in.
  public static func isAllowedPath(_ path: String) -> Bool {
    guard path.hasPrefix("/"), !path.hasPrefix("//") else { return false }
    if path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return false }
    if path.contains("\\") || path.contains("://") { return false }
    let pathOnly = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
    guard pathOnly == "/health" || pathOnly.hasPrefix("/api/") else { return false }
    for segment in pathOnly.split(separator: "/", omittingEmptySubsequences: false) {
      let decoded = String(segment).removingPercentEncoding ?? String(segment)
      if decoded == ".." || decoded == "." { return false }
      if decoded.contains("/") || decoded.contains("\\") { return false }
    }
    return true
  }

  /// The loopback URL for an allowed path, or nil.
  public static func backendURL(path: String, port: Int) -> URL? {
    guard isAllowedPath(path), port > 0, port < 65536 else { return nil }
    return URL(string: "http://127.0.0.1:\(port)\(path)")
  }

  public static func isAllowedMethod(_ method: String) -> Bool {
    allowedMethods.contains(method.uppercased())
  }

  public static func forwardedHeaders(_ headers: [String: String]) -> [String: String] {
    var out: [String: String] = [:]
    for (key, value) in headers where !blockedHeaders.contains(key.lowercased()) {
      out[key] = value
    }
    return out
  }
}
