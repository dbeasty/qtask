import Foundation
import QTaskCore

/// The app's one door to the local server: loopback HTTP with this launch's device token.
/// The web view's bridge and the app's own calls (Dock badge) both go through it.
final class BackendHTTP: @unchecked Sendable {
  struct Response {
    let status: Int
    let headers: [String: String]
    let body: Data
  }

  enum Failure: Error, CustomStringConvertible {
    case notAllowed(String)
    case unavailable(String)
    var description: String {
      switch self {
      case .notAllowed(let m): return m
      case .unavailable(let m): return m
      }
    }
  }

  /// Resolves once the backend is up, and throws if it never will be.
  private let endpoint: @Sendable () async throws -> BackendEndpoint
  private let session: URLSession
  private let lock = NSLock()
  private var sessionToken: String?

  init(endpoint: @escaping @Sendable () async throws -> BackendEndpoint) {
    self.endpoint = endpoint
    let config = URLSessionConfiguration.ephemeral
    // Loopback must never go through a system proxy, and nothing is cached or cookied.
    config.connectionProxyDictionary = [
      kCFNetworkProxiesHTTPEnable as String: false,
      kCFNetworkProxiesHTTPSEnable as String: false,
      kCFNetworkProxiesSOCKSEnable as String: false,
    ]
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    // Generous on purpose: the first request after opening a large store can wait while
    // kdb-service recovers (minutes at tens of thousands of tasks); failing it early would
    // turn a slow launch into a broken one.
    config.timeoutIntervalForRequest = 1800
    config.timeoutIntervalForResource = 3600
    config.httpMaximumConnectionsPerHost = 8
    session = URLSession(configuration: config)
  }

  func send(method: String, path: String, headers: [String: String], body: Data?) async throws -> Response {
    guard RequestPolicy.isAllowedMethod(method) else { throw Failure.notAllowed("method \(method) is not allowed") }
    let ep = try await endpoint()
    guard let url = RequestPolicy.backendURL(path: path, port: ep.port) else {
      throw Failure.notAllowed("path is not part of the app's API")
    }
    if let body, body.count > RequestPolicy.maxBodyBytes { throw Failure.notAllowed("request body too large") }
    var request = URLRequest(url: url)
    request.httpMethod = method.uppercased()
    for (k, v) in RequestPolicy.forwardedHeaders(headers) { request.setValue(v, forHTTPHeaderField: k) }
    request.setValue(ep.deviceToken, forHTTPHeaderField: "x-qtask-device-token")
    request.httpBody = body
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw Failure.unavailable("not an HTTP response") }
      var out: [String: String] = [:]
      for (k, v) in http.allHeaderFields {
        guard let key = (k as? String)?.lowercased(), let value = v as? String else { continue }
        if ["content-type", "etag", "location", "content-disposition"].contains(key) { out[key] = value }
      }
      return Response(status: http.statusCode, headers: out, body: data)
    } catch let e as Failure {
      throw e
    } catch {
      throw Failure.unavailable("the local service did not answer: \((error as NSError).localizedDescription)")
    }
  }

  /// A session token for the app's own calls, minted by the same endpoint the page uses.
  func authorizedToken(refresh: Bool = false) async throws -> String {
    if let cached = cachedToken(), !refresh { return cached }
    let r = try await send(method: "POST", path: "/api/auth/local-session", headers: [:], body: nil)
    guard r.status == 200,
      let obj = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any],
      let token = obj["token"] as? String
    else { throw Failure.unavailable("could not start a local session (status \(r.status))") }
    store(token)
    return token
  }

  private func cachedToken() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return sessionToken
  }

  private func store(_ token: String) {
    lock.lock()
    sessionToken = token
    lock.unlock()
  }

  /// GET with the app's own session; retries once with a new session on 401.
  func authorizedGet(_ path: String) async throws -> Response {
    for attempt in 0..<2 {
      let token = try await authorizedToken(refresh: attempt == 1)
      let r = try await send(method: "GET", path: path, headers: ["authorization": "Bearer \(token)"], body: nil)
      if r.status != 401 { return r }
    }
    throw Failure.unavailable("the local session was refused")
  }
}
