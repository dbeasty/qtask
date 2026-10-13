// swift-tools-version:5.9
//
// The Mac app: a native window around the web client (client/), with the backend
// (Node) and its store (kdb-service) run as supervised children. Built by
// scripts/build-macos.sh, which prepares the web export and the helper programs and
// wraps the binary in an .app.
//
//   QTaskCore   everything that is plain logic and unit-tested (paths, request policy,
//               asset serving rules, launch arguments, the process supervisor)
//   QTask       the AppKit/WebKit shell on top of it
//
// The end-to-end control folder (E2EControl.swift) is compiled only when the build is
// given -Xswiftc -DQTASK_E2E (scripts/build-macos.sh does that for E2E=1); a release
// build has no such code at all.
import PackageDescription

let package = Package(
  name: "QTask",
  platforms: [.macOS(.v13)],
  products: [.executable(name: "QTask", targets: ["QTask"])],
  targets: [
    .target(name: "QTaskCore", path: "Sources/QTaskCore"),
    .executableTarget(
      name: "QTask",
      dependencies: ["QTaskCore"],
      path: "Sources/QTask",
      linkerSettings: [
        .linkedFramework("WebKit"),
        .linkedFramework("AppKit"),
        .linkedFramework("Security"),
        .linkedFramework("CoreBluetooth"),
        .linkedFramework("Network"),
      ]
    ),
    .testTarget(name: "QTaskCoreTests", dependencies: ["QTaskCore"], path: "Tests/QTaskCoreTests"),
  ]
)
