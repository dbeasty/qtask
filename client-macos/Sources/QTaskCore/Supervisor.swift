import Darwin
import Foundation

public struct BackendEndpoint: Sendable {
  public let port: Int
  public let deviceToken: String
  public let deviceId: String
  public let nodePid: Int32
  public let kdbPid: Int32
  public let kdbPort: Int
}

public enum SupervisorError: Error, CustomStringConvertible {
  case missing(String)
  case kdbFailed(String)
  case nodeFailed(String)

  public var description: String {
    switch self {
    case .missing(let m): return m
    case .kdbFailed(let m): return "The data store did not start: \(m)"
    case .nodeFailed(let m): return "The task service did not start: \(m)"
    }
  }
}

/// Starts, watches and stops the two child programs: `kdb-service` (the store) and Node
/// (the Express backend in local mode).
///
/// Properties it guarantees, each covered by the e2e suite:
///  * kdb-service is up and accepting before Node starts; Node reports its own port;
///  * both listen on loopback only, on ports chosen per launch;
///  * `stop()` asks Node to close the store, then asks kdb-service to drain, and only
///    force-kills when they do not leave in time;
///  * children left behind by a crashed earlier run (the app was force-quit) are found
///    through the pid file and ended before a new launch, so the data directory is never
///    opened by two stores.
public actor Supervisor {
  public typealias ExitHandler = @Sendable (_ which: String, _ status: Int32, _ detail: String) -> Void

  private let layout: BundleLayout
  private let paths: DataPaths
  private let environment: [String: String]
  private var kdb: Process?
  private var node: Process?
  private var stopping = false
  private var endpoint: BackendEndpoint?
  private var onUnexpectedExit: ExitHandler?
  /// Wall-clock marks (epoch ms) of each start-up step, for measuring cold start.
  public private(set) var timeline: [(String, Double)] = []

  private func mark(_ name: String) { timeline.append((name, Date().timeIntervalSince1970 * 1000)) }

  public init(layout: BundleLayout, paths: DataPaths, environment: [String: String] = ProcessInfo.processInfo.environment) {
    self.layout = layout
    self.paths = paths
    self.environment = environment
  }

  public func setExitHandler(_ handler: @escaping ExitHandler) { onUnexpectedExit = handler }
  public var current: BackendEndpoint? { endpoint }

  // MARK: start

  public func start() async throws -> BackendEndpoint {
    if let endpoint { return endpoint }
    if let problem = layout.missingPiece() { throw SupervisorError.missing(problem) }
    try paths.prepare()
    if let owner = Self.liveOwner(pidFile: paths.pidFile) {
      throw SupervisorError.missing("QTask (pid \(owner)) is already using \(paths.root.path)")
    }
    Self.endStaleChildren(pidFile: paths.pidFile, helpers: layout.helpers)
    rotateLogIfLarge(paths.nodeLog)
    rotateLogIfLarge(paths.kdbLog)
    stopping = false
    mark("supervisor-start")

    // kdb-service. A port picked by asking the OS and then releasing it can be taken
    // by someone else before the child binds it; a few attempts make that harmless.
    var kdbPort = 0
    var lastError = "unknown"
    for attempt in 1...3 {
      kdbPort = try Self.freeLoopbackPort()
      do {
        try launchKdb(port: kdbPort)
        try await waitForPort(kdbPort, process: kdb!, what: "kdb-service", timeout: 30)
        mark("kdb-listening")
        lastError = ""
        break
      } catch {
        lastError = "\(error)"
        await terminate(kdb, name: "kdb-service", grace: 2)
        kdb = nil
        if attempt == 3 { throw SupervisorError.kdbFailed(lastError) }
      }
    }

    // Node.
    mark("node-spawn")
    let token = Launch.randomToken()
    let ready: (port: Int, deviceId: String)
    do {
      ready = try await launchNode(deviceToken: token, kdbPort: kdbPort)
    } catch {
      await stop()
      throw error
    }
    let result = BackendEndpoint(
      port: ready.port, deviceToken: token, deviceId: ready.deviceId,
      nodePid: node!.processIdentifier, kdbPid: kdb!.processIdentifier, kdbPort: kdbPort)
    mark("node-ready")
    endpoint = result
    writePidFile(result)
    return result
  }

  private func launchKdb(port: Int) throws {
    let p = Process()
    p.executableURL = layout.kdbService
    p.arguments = Launch.kdbArguments(dataDir: paths.kdb, sqlPort: port)
    p.environment = ["PATH": "/usr/bin:/bin", "HOME": environment["HOME"] ?? NSHomeDirectory()]
    p.currentDirectoryURL = paths.root
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = try Self.appendHandle(paths.kdbLog)
    p.standardError = p.standardOutput
    p.terminationHandler = { [weak self] proc in
      Task { await self?.childExited("kdb-service", proc) }
    }
    try p.run()
    kdb = p
  }

  private func launchNode(deviceToken: String, kdbPort: Int) async throws -> (port: Int, deviceId: String) {
    let p = Process()
    p.executableURL = layout.node
    p.arguments = [layout.serverScript.path]
    p.environment = Launch.nodeEnvironment(
      dataDir: paths.root, deviceToken: deviceToken, kdbPort: kdbPort,
      kdbClientModule: layout.kdbClientModule, inherit: environment)
    p.currentDirectoryURL = paths.root
    // The pipe is node's lifeline: it exits when this end closes (we died).
    let stdin = Pipe()
    p.standardInput = stdin
    let stdout = Pipe()
    p.standardOutput = stdout
    p.standardError = try Self.appendHandle(paths.nodeLog)
    p.terminationHandler = { [weak self] proc in
      Task { await self?.childExited("node", proc) }
    }

    let reader = ReadyReader(log: try Self.appendHandle(paths.nodeLog))
    stdout.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      reader.feed(data)
    }
    try p.run()
    node = p
    nodeLifeline = stdin

    let deadline = Date().addingTimeInterval(60)
    while Date() < deadline {
      if let info = reader.ready { return info }
      if !p.isRunning {
        throw SupervisorError.nodeFailed("exited with status \(p.terminationStatus); see \(paths.nodeLog.path)")
      }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    throw SupervisorError.nodeFailed("no ready signal within 60 s; see \(paths.nodeLog.path)")
  }

  private var nodeLifeline: Pipe?

  // MARK: stop

  public func stop() async {
    stopping = true
    try? nodeLifeline?.fileHandleForWriting.close()
    nodeLifeline = nil
    // Node first: its shutdown closes the store client. Then the store drains.
    await terminate(node, name: "node", grace: 10)
    await terminate(kdb, name: "kdb-service", grace: 30)
    node = nil
    kdb = nil
    endpoint = nil
    try? FileManager.default.removeItem(at: paths.pidFile)
  }

  /// SIGTERM, wait up to `grace` seconds, then SIGKILL.
  private func terminate(_ proc: Process?, name: String, grace: TimeInterval) async {
    guard let proc, proc.isRunning else { return }
    proc.terminate()
    let deadline = Date().addingTimeInterval(grace)
    while proc.isRunning && Date() < deadline {
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    if proc.isRunning {
      kill(proc.processIdentifier, SIGKILL)
      proc.waitUntilExit()
    }
  }

  private func childExited(_ name: String, _ proc: Process) {
    if stopping { return }
    let status = proc.terminationStatus
    // One child going down takes the pair down: a task service without its store (or
    // the reverse) is worse than a visible failure.
    stopping = true
    let handler = onUnexpectedExit
    let detail = "\(name) exited unexpectedly (status \(status)); see \(paths.logs.path)"
    Task {
      await self.stop()
      handler?(name, status, detail)
    }
  }

  // MARK: helpers

  private func waitForPort(_ port: Int, process: Process, what: String, timeout: TimeInterval) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if Self.canConnect(port: port) { return }
      if !process.isRunning {
        throw SupervisorError.kdbFailed("\(what) exited with status \(process.terminationStatus); see \(paths.kdbLog.path)")
      }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    throw SupervisorError.kdbFailed("\(what) did not open port \(port) within \(Int(timeout)) s")
  }

  private func writePidFile(_ e: BackendEndpoint) {
    let body: [String: Any] = [
      "app": getpid(), "node": e.nodePid, "kdb": e.kdbPid, "kdbPort": e.kdbPort, "port": e.port,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: body) {
      try? data.write(to: paths.pidFile, options: .atomic)
    }
  }

  private func rotateLogIfLarge(_ url: URL) {
    let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
    if size > 5 * 1024 * 1024 {
      let old = url.appendingPathExtension("1")
      try? FileManager.default.removeItem(at: old)
      try? FileManager.default.moveItem(at: url, to: old)
    }
  }

  // MARK: static helpers (also used by tests)

  static func appendHandle(_ url: URL) throws -> FileHandle {
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let h = try FileHandle(forWritingTo: url)
    try h.seekToEnd()
    return h
  }

  /// Asks the OS for an unused loopback TCP port.
  public static func freeLoopbackPort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw SupervisorError.kdbFailed("socket(): \(String(cString: strerror(errno)))") }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard bound == 0 else { throw SupervisorError.kdbFailed("bind(): \(String(cString: strerror(errno)))") }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let got = withUnsafeMutablePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    guard got == 0 else { throw SupervisorError.kdbFailed("getsockname(): \(String(cString: strerror(errno)))") }
    return Int(UInt16(bigEndian: addr.sin_port))
  }

  public static func canConnect(port: Int) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(port).bigEndian
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let rc = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return rc == 0
  }

  /// The pid of a live app that wrote the pid file, if any. A running instance owns its
  /// children; a second one must not kill them as "stale".
  static func liveOwner(pidFile: URL) -> Int32? {
    guard let data = try? Data(contentsOf: pidFile),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let pid = (obj["app"] as? NSNumber)?.int32Value, pid > 1, pid != getpid(), kill(pid, 0) == 0
    else { return nil }
    let mine = executablePath(of: getpid())
    return executablePath(of: pid) == mine ? pid : nil
  }

  /// Ends children recorded by a previous run that did not shut down (a force quit or a
  /// crash). Only processes whose executable lives in `helpers` are touched, so a recycled
  /// pid belonging to something else is never signalled.
  static func endStaleChildren(pidFile: URL, helpers: URL) {
    guard let data = try? Data(contentsOf: pidFile),
      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    let helperPath = helpers.resolvingSymlinksInPath().path
    for key in ["node", "kdb"] {
      guard let pid = (obj[key] as? NSNumber)?.int32Value, pid > 1 else { continue }
      guard let exe = executablePath(of: pid), exe.hasPrefix(helperPath) || exe.contains("/Contents/Resources/backend/") else {
        continue
      }
      kill(pid, SIGTERM)
      var waited = 0
      while kill(pid, 0) == 0 && waited < 300 {
        usleep(100_000)
        waited += 1
      }
      if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
    }
    try? FileManager.default.removeItem(at: pidFile)
  }

  static func executablePath(of pid: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * 1024)
    let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return n > 0 ? String(cString: buffer) : nil
  }
}

/// Collects node's stdout: the ready line is parsed out, everything is also written to the log.
final class ReadyReader: @unchecked Sendable {
  private let lock = NSLock()
  private var buffer = Data()
  private var _ready: (port: Int, deviceId: String)?
  private let log: FileHandle

  init(log: FileHandle) { self.log = log }

  var ready: (port: Int, deviceId: String)? {
    lock.lock()
    defer { lock.unlock() }
    return _ready
  }

  func feed(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    try? log.write(contentsOf: data)
    guard _ready == nil else { return }
    buffer.append(data)
    guard let text = String(data: buffer, encoding: .utf8) else { return }
    for line in text.split(separator: "\n") where line.hasPrefix("QTASK_READY ") {
      let json = line.dropFirst("QTASK_READY ".count)
      if let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
        let port = obj["port"] as? Int, let id = obj["deviceId"] as? String
      {
        _ready = (port, id)
      }
    }
  }
}
