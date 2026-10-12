import Foundation
import Security

/// How the two child programs are started. Pure functions, so tests can pin the exact
/// command lines without starting anything.
///
/// This is the only place that knows kdb-service's flags (see src/local/README.md). When
/// peer sync is switched on in a later phase, it is done here.
public enum Launch {
  /// kdb-service's namespace. Must equal the backend's `KDB_NAMESPACE_PREFIX`.
  public static let kdbNamespace = "qtask/docs"

  public static func kdbArguments(dataDir: URL, sqlPort: Int) -> [String] {
    [
      "--data-dir", dataDir.path,
      "--namespace", kdbNamespace,
      // Loopback only, on a port chosen per launch.
      "--sql-addr", "tcp://127.0.0.1:\(sqlPort)?bind=true",
      // The defaults open peer-sync (9091) and stream (9092) listeners. Phase 1 is a
      // single device: nothing else may connect, so both are switched off.
      "--peer-addr", "",
      "--stream-addr", "",
      "--log-level", "warn",
    ]
  }

  /// The backend's environment. Built from scratch rather than inherited, so nothing from
  /// the user's shell (proxies, NODE_OPTIONS, a stray DATABASE_URL, dotenv overrides) can
  /// change what a local device does.
  public static func nodeEnvironment(
    dataDir: URL,
    deviceToken: String,
    kdbPort: Int,
    kdbClientModule: URL,
    bleBridge: Bool = false,
    deviceName: String? = nil,
    inherit: [String: String] = ProcessInfo.processInfo.environment
  ) -> [String: String] {
    var env: [String: String] = [
      "PATH": "/usr/bin:/bin",
      "HOME": inherit["HOME"] ?? NSHomeDirectory(),
      "TMPDIR": inherit["TMPDIR"] ?? NSTemporaryDirectory(),
      "LANG": inherit["LANG"] ?? "en_US.UTF-8",
      "NODE_ENV": "production",
      "QTASK_LOCAL": "1",
      "QTASK_DEVICE_TOKEN": deviceToken,
      "QTASK_DATA_DIR": dataDir.path,
      "QTASK_EXIT_ON_STDIN_CLOSE": "1",
      "KDB_ADDR": "tcp://127.0.0.1:\(kdbPort)",
      "KDB_NAMESPACE_PREFIX": kdbNamespace,
      "KDB_CLIENT_MODULE": kdbClientModule.path,
    ]
    // The backend opens a loopback socket for the app's Bluetooth radio (src/sync/ble/bridge.ts).
    // Whether the radio is used is the user's choice in Devices & Sync (POST /api/local-sync/bluetooth),
    // and CoreBluetooth is not touched until then; see bleBridgeWanted.
    if bleBridge { env["QTASK_BLE_BRIDGE"] = "1" }
    // Shown to paired devices ("Last synced from Dana's MacBook").
    if let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
      env["QTASK_DEVICE_NAME"] = String(name.prefix(60))
    }
    // Test hooks the e2e harness uses to point the backend elsewhere are not forwarded.
    env["NODE_NO_WARNINGS"] = "1"
    return env
  }

  /// Whether to open the Bluetooth bridge. On by default: the bridge alone does nothing (no
  /// radio command, so no permission prompt) until the user turns Bluetooth sync on in
  /// Devices & Sync. `QTASK_BLE=0` leaves it out entirely (a build or test without Bluetooth).
  public static func bleBridgeWanted(environment: [String: String]) -> Bool {
    environment["QTASK_BLE"] != "0"
  }

  /// Lowercase hex of `count` random bytes.
  public static func randomToken(bytes count: Int = 32) -> String {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    precondition(status == errSecSuccess, "no system randomness")
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
}
