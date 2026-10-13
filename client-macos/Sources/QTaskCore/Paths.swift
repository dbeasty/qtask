import Foundation

/// Where the app keeps a device's data, and what is inside it. The layout is a contract
/// with the backend (`src/local/device.ts` `dataPaths`, documented in `src/local/README.md`).
public struct DataPaths {
  public let root: URL
  public var kdb: URL { root.appendingPathComponent("kdb", isDirectory: true) }
  public var logs: URL { root.appendingPathComponent("logs", isDirectory: true) }
  public var run: URL { root.appendingPathComponent("run", isDirectory: true) }
  public var pidFile: URL { run.appendingPathComponent("children.json") }
  public var nodeLog: URL { logs.appendingPathComponent("node.log") }
  public var kdbLog: URL { logs.appendingPathComponent("kdb.log") }

  public init(root: URL) { self.root = root }

  /// `QTASK_DATA_DIR` if set (tests and the e2e harness always set it), otherwise
  /// `~/Library/Application Support/QTask`.
  public static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) -> DataPaths {
    if let override = environment["QTASK_DATA_DIR"]?.trimmingCharacters(in: .whitespaces), !override.isEmpty {
      return DataPaths(root: URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true).standardizedFileURL)
    }
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return DataPaths(root: support.appendingPathComponent("QTask", isDirectory: true))
  }

  /// Creates the directories the shell itself writes to, owner-only.
  public func prepare() throws {
    let fm = FileManager.default
    for dir in [root, kdb, logs, run] {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
  }
}

/// Where the helper programs and web assets live inside (or, in tests, beside) the app.
public struct BundleLayout {
  public let resources: URL
  public init(resources: URL) { self.resources = resources }

  public var web: URL { resources.appendingPathComponent("web", isDirectory: true) }
  public var bridgeScript: URL { resources.appendingPathComponent("bridge.js") }
  public var helpers: URL { resources.appendingPathComponent("backend", isDirectory: true) }
  public var node: URL { helpers.appendingPathComponent("node") }
  /// Laid out like the repo (`dist/` beside `package.json`) because the backend reads its
  /// version and revision relative to itself.
  public var serverScript: URL { helpers.appendingPathComponent("dist/server.mjs") }
  public var kdbClientModule: URL { helpers.appendingPathComponent("kdb-client.mjs") }
  public var kdbService: URL { helpers.appendingPathComponent("kdb-service") }
  public var versionFile: URL { helpers.appendingPathComponent("VERSIONS.txt") }

  /// The first problem found, or nil when everything the app needs is present.
  public func missingPiece() -> String? {
    let fm = FileManager.default
    for (name, url) in [
      ("web/index.html", web.appendingPathComponent("index.html")),
      ("bridge.js", bridgeScript),
      ("backend/node", node),
      ("backend/dist/server.mjs", serverScript),
      ("backend/kdb-client.mjs", kdbClientModule),
      ("backend/kdb-service", kdbService),
    ] where !fm.fileExists(atPath: url.path) {
      return "\(name) is missing from the app"
    }
    return nil
  }
}
