import AppKit
import QTaskCore
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private(set) var window: NSWindow!
  private(set) var web: WebController!
  private(set) var bridge: Bridge!
  private(set) var supervisor: Supervisor!
  private(set) var badge: DockBadge!
  private var http: BackendHTTP!
  private var layout: BundleLayout!
  private var paths: DataPaths!
  private var endpointTask: Task<BackendEndpoint, Error>!
  private var errorView: NSView?
  private var terminating = false
  private var bleBridge: BLEBridgeClient?
  private var signalSources: [DispatchSourceSignal] = []
  /// Wall-clock marks (epoch ms) of the start-up steps, for the e2e/perf suite.
  private(set) var timeline: [(String, Double)] = []
  #if QTASK_E2E
    private var control: E2EControl?
  #endif

  func mark(_ name: String) {
    timeline.append((name, Date().timeIntervalSince1970 * 1000))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    mark("launched")
    let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")
    layout = BundleLayout(resources: resources)
    paths = DataPaths.resolve()
    supervisor = Supervisor(layout: layout, paths: paths)

    // The endpoint is resolved once, lazily, and shared: the page's first request waits
    // for it, so loading the web view overlaps with starting the backend.
    endpointTask = Task { [supervisor] in try await supervisor!.start() }
    http = BackendHTTP(endpoint: { [weak self] in
      guard let self else { throw CancellationError() }
      return try await self.endpointTask.value
    })
    bridge = Bridge(http: http)
    badge = DockBadge(http: http)
    bridge.onChanged = { [weak self] in self?.badge.refreshSoon() }

    #if QTASK_E2E
      let e2eDir = ProcessInfo.processInfo.environment["QTASK_E2E_CONTROL"]
    #else
      let e2eDir: String? = nil
    #endif
    web = WebController(layout: layout, bridge: bridge, interceptConsole: e2eDir != nil)
    web.onPageLoaded = { [weak self] in self?.mark("page-loaded") }

    NSApp.mainMenu = MenuBuilder.build()
    buildWindow()
    installSignalHandlers()

    #if QTASK_E2E
      if let dir = e2eDir {
        control = E2EControl(dir: URL(fileURLWithPath: dir), app: self)
        control?.start()
      }
    #endif

    mark("window-shown")
    web.load()
    Task { [weak self] in
      await self?.watchBackend()
    }
    NSApp.activate(ignoringOtherApps: true)
  }

  private func watchBackend() async {
    do {
      let endpoint = try await endpointTask.value
      mark("backend-ready")
      await supervisor.setExitHandler { [weak self] which, _, detail in
        DispatchQueue.main.async { self?.showFailure(detail, which: which) }
      }
      await MainActor.run {
        self.badge.start()
        self.startBluetoothBridge(endpoint)
      }
    } catch {
      await MainActor.run { self.showFailure("\(error)", which: "start") }
    }
  }

  // MARK: Bluetooth

  /// Opt-in (QTASK_BLE=1): connects the native radio to the backend's bridge. CoreBluetooth
  /// is not touched, and no permission prompt appears, until the backend sends its first
  /// radio command (when Bluetooth sync is switched on).
  private func startBluetoothBridge(_ endpoint: BackendEndpoint) {
    guard let port = endpoint.bleBridgePort else { return }
    bleBridge?.stop()
    bleBridge = BLEBridgeClient(port: port, token: endpoint.deviceToken, radio: CoreBluetoothRadio())
    bleBridge?.start()
  }

  // MARK: window

  private func buildWindow() {
    let frame = NSRect(x: 0, y: 0, width: 1240, height: 820)
    window = NSWindow(
      contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "QTask"
    window.minSize = NSSize(width: 720, height: 520)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setFrameAutosaveName("QTaskMainWindow")
    if !window.setFrameUsingName("QTaskMainWindow") { window.center() }
    web.webView.frame = window.contentView!.bounds
    web.webView.autoresizingMask = [.width, .height]
    window.contentView!.addSubview(web.webView)
    window.makeKeyAndOrderFront(nil)
  }

  /// Closing the window hides it; the app (and the Dock badge) stays until Quit.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // MARK: failure

  private func showFailure(_ message: String, which: String) {
    guard !terminating else { return }
    errorView?.removeFromSuperview()
    let box = NSView(frame: window.contentView!.bounds)
    box.autoresizingMask = [.width, .height]
    box.wantsLayer = true
    box.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

    let title = NSTextField(labelWithString: "QTask could not start its data service")
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    let detail = NSTextField(wrappingLabelWithString: message)
    detail.maximumNumberOfLines = 6
    let logs = NSButton(title: "Show Log Folder", target: self, action: #selector(revealLogs(_:)))
    let retry = NSButton(title: "Try Again", target: self, action: #selector(restartBackend(_:)))
    retry.keyEquivalent = "\r"
    let quit = NSButton(title: "Quit", target: NSApp, action: #selector(NSApplication.terminate(_:)))
    let buttons = NSStackView(views: [logs, quit, retry])
    buttons.spacing = 12
    let stack = NSStackView(views: [title, detail, buttons])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    box.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: box.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: box.centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
    ])
    window.contentView!.addSubview(box)
    errorView = box
  }

  @objc func restartBackend(_ sender: Any?) {
    errorView?.removeFromSuperview()
    errorView = nil
    supervisor = Supervisor(layout: layout, paths: paths)
    endpointTask = Task { [supervisor] in try await supervisor!.start() }
    Task { [weak self] in
      await self?.watchBackend()
      await MainActor.run { self?.web.reload() }
    }
  }

  // MARK: menu actions

  @objc func newTask(_ sender: Any?) { web.sendCommand("new-task") }
  @objc func newProject(_ sender: Any?) { web.sendCommand("new-project") }
  @objc func find(_ sender: Any?) { web.sendCommand("find") }
  @objc func showProjects(_ sender: Any?) { web.sendCommand("view-projects") }
  @objc func showTasks(_ sender: Any?) { web.sendCommand("view-tasks") }
  @objc func reloadPage(_ sender: Any?) { web.reload() }
  @objc func zoomIn(_ sender: Any?) { web.webView.pageZoom = min(web.webView.pageZoom + 0.1, 3) }
  @objc func zoomOut(_ sender: Any?) { web.webView.pageZoom = max(web.webView.pageZoom - 0.1, 0.5) }
  @objc func zoomReset(_ sender: Any?) { web.webView.pageZoom = 1 }
  @objc func revealLogs(_ sender: Any?) {
    NSWorkspace.shared.activateFileViewerSelecting([paths.logs])
  }

  // MARK: shutdown

  /// Stops the children before the app goes. This waits on the main thread rather than
  /// using `.terminateLater`: a quit that arrives from a dispatch-queue block (a signal
  /// handler, the control folder) would hold the main queue while AppKit waits for a reply
  /// that can only be delivered on that same queue.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if terminating { return .terminateNow }
    terminating = true
    badge?.stop()
    bleBridge?.stop()
    let supervisor = self.supervisor!
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      await supervisor.stop()
      done.signal()
    }
    // Node closes the store and kdb-service drains; both are bounded in Supervisor.stop().
    _ = done.wait(timeout: .now() + 60)
    return .terminateNow
  }

  /// SIGTERM/SIGINT quit the app the orderly way, so children are stopped and the store flushed.
  private func installSignalHandlers() {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { NSApp.terminate(nil) }
      source.resume()
      signalSources.append(source)
    }
  }

  /// For the control folder: where the backend is, without exposing it anywhere else.
  func debugState() async -> [String: Any] {
    var out: [String: Any] = [
      "appPid": getpid(),
      "dataDir": paths.root.path,
      "timeline": timeline.map { ["name": $0.0, "t": $0.1] },
      "pageLoads": web.pageLoads,
      "bridgeForwarded": bridge.forwarded,
      "bridgeRefused": bridge.refused,
    ]
    if let e = await supervisor.current {
      out["port"] = e.port
      out["deviceToken"] = e.deviceToken
      out["deviceId"] = e.deviceId
      out["nodePid"] = e.nodePid
      out["kdbPid"] = e.kdbPid
      out["kdbPort"] = e.kdbPort
    }
    out["supervisorTimeline"] = await supervisor.timeline.map { ["name": $0.0, "t": $0.1] }
    return out
  }
}
