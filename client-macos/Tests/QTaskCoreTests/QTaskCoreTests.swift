import Foundation
import XCTest

@testable import QTaskCore

final class RequestPolicyTests: XCTestCase {
  func testAllowsTheAppsOwnApiAndHealth() {
    for p in ["/api/tasks", "/api/tasks?limit=10&offset=20", "/api/auth/local-session", "/health", "/api/search?q=a%20b"] {
      XCTAssertTrue(RequestPolicy.isAllowedPath(p), p)
    }
  }

  func testRefusesEverythingElse() {
    let bad = [
      "", "api/tasks", "/", "/index.html", "/apix", "/healthz", "//evil.example/api/x",
      "/api/../etc/passwd", "/api/%2e%2e/x", "/api/./x", "/api/tasks\\x", "http://evil.example/api/x",
      "/api/x://y", "/api/a\u{0}b", "/api/a\nb", "/health/../../x",
    ]
    for p in bad { XCTAssertFalse(RequestPolicy.isAllowedPath(p), "should refuse \(p.debugDescription)") }
  }

  func testBackendURLIsAlwaysLoopback() {
    let url = RequestPolicy.backendURL(path: "/api/tasks?x=1", port: 5123)
    XCTAssertEqual(url?.absoluteString, "http://127.0.0.1:5123/api/tasks?x=1")
    XCTAssertEqual(url?.host, "127.0.0.1")
    // A path cannot change the authority.
    XCTAssertEqual(RequestPolicy.backendURL(path: "/api/x@evil.example:80", port: 1)?.host, "127.0.0.1")
    XCTAssertNil(RequestPolicy.backendURL(path: "/other", port: 5123))
    XCTAssertNil(RequestPolicy.backendURL(path: "/api/x", port: 0))
    XCTAssertNil(RequestPolicy.backendURL(path: "/api/x", port: 70000))
  }

  func testMethods() {
    XCTAssertTrue(RequestPolicy.isAllowedMethod("get"))
    XCTAssertTrue(RequestPolicy.isAllowedMethod("PATCH"))
    XCTAssertFalse(RequestPolicy.isAllowedMethod("CONNECT"))
    XCTAssertFalse(RequestPolicy.isAllowedMethod("TRACE"))
  }

  func testPageCannotSetTheDeviceTokenOrHostHeaders() {
    let out = RequestPolicy.forwardedHeaders([
      "Content-Type": "application/json", "Authorization": "Bearer x", "X-QTask-Device-Token": "stolen",
      "Host": "evil", "Origin": "evil", "Cookie": "a=b",
    ])
    XCTAssertEqual(Set(out.keys), ["Content-Type", "Authorization"])
  }
}

final class WebAssetsTests: XCTestCase {
  var root: URL!

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("qtask-assets-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
    try "<html><head></head></html>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
    try "console.log(1)".write(to: root.appendingPathComponent("assets/app.js"), atomically: true, encoding: .utf8)
    try "secret".write(to: root.deletingLastPathComponent().appendingPathComponent("qtask-outside-\(root.lastPathComponent).txt"), atomically: true, encoding: .utf8)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
    try? FileManager.default.removeItem(at: root.deletingLastPathComponent().appendingPathComponent("qtask-outside-\(root.lastPathComponent).txt"))
  }

  func resolve(_ s: String) -> WebAssets.Resolved? { WebAssets(root: root).resolve(url: URL(string: s)!) }

  func testServesFilesAndClientRoutes() {
    XCTAssertEqual(resolve("app://qtask/")?.file.lastPathComponent, "index.html")
    XCTAssertEqual(resolve("app://qtask/assets/app.js")?.mimeType, "text/javascript; charset=utf-8")
    // A route without an extension is the SPA's, as on the hosted site.
    XCTAssertEqual(resolve("app://qtask/projects")?.file.lastPathComponent, "index.html")
  }

  func testRefusesTraversalOtherHostsAndTheApi() {
    XCTAssertNil(resolve("app://qtask/../qtask-outside-\(root.lastPathComponent).txt"))
    XCTAssertNil(resolve("app://qtask/%2e%2e/qtask-outside-\(root.lastPathComponent).txt"))
    XCTAssertNil(resolve("app://qtask/assets/../../x.txt"))
    XCTAssertNil(resolve("app://other/index.html"))
    XCTAssertNil(resolve("https://qtask/index.html"))
    XCTAssertNil(resolve("app://qtask/api/tasks"))
    XCTAssertNil(resolve("app://qtask/assets/missing.js"))
  }

  func testPolicyBlocksConnectionsAndNamesNoRemoteOrigin() {
    let csp = WebAssets.contentSecurityPolicy
    XCTAssertTrue(csp.contains("connect-src 'none'"))
    XCTAssertTrue(csp.contains("default-src 'none'"))
    XCTAssertFalse(csp.contains("http"), "the policy must not allow any remote origin")
    XCTAssertFalse(csp.contains("*"))
  }
}

final class LaunchTests: XCTestCase {
  func testKdbListensOnLoopbackOnlyAndOpensNoOtherListener() {
    let args = Launch.kdbArguments(dataDir: URL(fileURLWithPath: "/data/kdb"), sqlPort: 4242)
    func value(_ flag: String) -> String? { args.firstIndex(of: flag).map { args[$0 + 1] } }
    XCTAssertEqual(value("--sql-addr"), "tcp://127.0.0.1:4242?bind=true")
    XCTAssertEqual(value("--peer-addr"), "")
    XCTAssertEqual(value("--stream-addr"), "")
    XCTAssertEqual(value("--data-dir"), "/data/kdb")
    XCTAssertEqual(value("--namespace"), Launch.kdbNamespace)
    XCTAssertFalse(args.contains("--memory"), "the store must be on disk")
  }

  func testNodeEnvironmentIsBuiltNotInherited() {
    let env = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/data"), deviceToken: "tok", kdbPort: 4242,
      kdbClientModule: URL(fileURLWithPath: "/app/kdb-client.mjs"),
      inherit: ["HOME": "/Users/x", "NODE_OPTIONS": "--inspect", "HTTPS_PROXY": "http://p", "DATA_MONGO": "true", "MONGODB_URI": "mongodb://x"])
    XCTAssertEqual(env["QTASK_LOCAL"], "1")
    XCTAssertEqual(env["QTASK_DEVICE_TOKEN"], "tok")
    XCTAssertEqual(env["KDB_ADDR"], "tcp://127.0.0.1:4242")
    XCTAssertEqual(env["HOME"], "/Users/x")
    for leaked in ["NODE_OPTIONS", "HTTPS_PROXY", "DATA_MONGO", "MONGODB_URI"] {
      XCTAssertNil(env[leaked], "\(leaked) must not reach the backend")
    }
  }

  func testTokensAreRandomAndLongEnough() {
    let a = Launch.randomToken(), b = Launch.randomToken()
    XCTAssertEqual(a.count, 64)
    XCTAssertNotEqual(a, b)
  }
}

final class PathsTests: XCTestCase {
  func testDataDirOverrideAndDefault() {
    XCTAssertEqual(DataPaths.resolve(environment: ["QTASK_DATA_DIR": "/tmp/qt-x"]).root.path, "/tmp/qt-x")
    XCTAssertTrue(DataPaths.resolve(environment: [:]).root.path.hasSuffix("/Library/Application Support/QTask"))
    XCTAssertTrue(DataPaths.resolve(environment: ["QTASK_DATA_DIR": "  "]).root.path.hasSuffix("/Application Support/QTask"))
  }

  func testPrepareMakesOwnerOnlyDirectories() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("qtask-paths-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = DataPaths(root: root)
    try paths.prepare()
    for dir in [paths.root, paths.kdb, paths.logs, paths.run] {
      let mode = (try FileManager.default.attributesOfItem(atPath: dir.path)[.posixPermissions] as? Int) ?? 0
      XCTAssertEqual(mode & 0o077, 0, dir.path)
    }
  }
}

final class SupervisorHelperTests: XCTestCase {
  func testFreePortIsLoopbackAndUsable() throws {
    let port = try Supervisor.freeLoopbackPort()
    XCTAssertGreaterThan(port, 1023)
    XCTAssertFalse(Supervisor.canConnect(port: port), "nothing listens on a port that was just freed")
  }

  func testStalePidFileOfADeadAppIsIgnoredByLiveOwnerCheck() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("qtask-pids-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    try JSONSerialization.data(withJSONObject: ["app": 999_999, "node": 999_998, "kdb": 999_997]).write(to: file)
    XCTAssertNil(Supervisor.liveOwner(pidFile: file))
    // Unrelated live processes are never signalled: a pid whose executable is not ours is skipped.
    Supervisor.endStaleChildren(pidFile: file, helpers: URL(fileURLWithPath: "/nonexistent/backend"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
  }

  func testDoesNotKillAnUnrelatedProcessNamedInThePidFile() throws {
    let sleeper = Process()
    sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep")
    sleeper.arguments = ["30"]
    try sleeper.run()
    defer { sleeper.terminate() }
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("qtask-pids-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    try JSONSerialization.data(withJSONObject: ["node": sleeper.processIdentifier]).write(to: file)
    Supervisor.endStaleChildren(pidFile: file, helpers: URL(fileURLWithPath: "/Applications/QTask.app/Contents/Resources/backend"))
    XCTAssertTrue(sleeper.isRunning, "a pid that is not one of our helpers must be left alone")
  }

  func testMissingPiecesAreReported() {
    let layout = BundleLayout(resources: FileManager.default.temporaryDirectory.appendingPathComponent("nope-\(UUID().uuidString)"))
    XCTAssertNotNil(layout.missingPiece())
  }
}
