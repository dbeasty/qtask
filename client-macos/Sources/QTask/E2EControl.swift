import AppKit
import QTaskCore
import WebKit

#if QTASK_E2E

  /// The end-to-end runner's hold on the app, in a build made with QTASK_E2E (E2E=1
  /// scripts/build-macos.sh) and started with QTASK_E2E_CONTROL=<dir>. There is no network
  /// in it, deliberately: the runner drops numbered command files into the folder and the
  /// app answers each with a result file. A release build contains none of this code.
  ///
  ///   cmd-<n>.js      JavaScript run in the page; its value (awaited) is the result
  ///   cmd-<n>.native  one line: "state", "menu <title>", "screenshot <path>", "badge",
  ///                   "windowinfo", "hide", "show", "quit"
  ///   res-<n>.json    {"ok": true, "value": …} or {"ok": false, "error": "…"}
  ///   console.log     the page's console output and security policy violations
  @MainActor
  final class E2EControl {
    private let dir: URL
    private weak var app: AppDelegate?
    private var timer: Timer?
    private var busy = false
    private var next = 1
    private var answered = Set<Int>()

    init(dir: URL, app: AppDelegate) {
      self.dir = dir
      self.app = app
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: dir.appendingPathComponent("console.log").path, contents: nil)
    }

    func start() {
      timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
      guard !busy else { return }
      let js = dir.appendingPathComponent("cmd-\(next).js")
      let native = dir.appendingPathComponent("cmd-\(next).native")
      let n = next
      if let source = try? String(contentsOf: js, encoding: .utf8) {
        busy = true
        next += 1
        watchdog(n)
        runJS(source) { self.answer(n, $0) }
      } else if let line = try? String(contentsOf: native, encoding: .utf8) {
        busy = true
        next += 1
        watchdog(n)
        runNative(line.trimmingCharacters(in: .whitespacesAndNewlines)) { self.answer(n, $0) }
      }
    }

    private func answer(_ n: Int, _ result: Result<Any?, Error>) {
      guard answered.insert(n).inserted else { return }
      var out: [String: Any]
      switch result {
      case .success(let value): out = ["ok": true, "value": value ?? NSNull()]
      case .failure(let error): out = ["ok": false, "error": "\(error)"]
      }
      if !JSONSerialization.isValidJSONObject(out) { out = ["ok": true, "value": "\(out["value"] ?? "")"] }
      let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("{\"ok\":false}".utf8)
      let tmp = dir.appendingPathComponent("res-\(n).json.tmp")
      try? data.write(to: tmp)
      try? FileManager.default.moveItem(at: tmp, to: dir.appendingPathComponent("res-\(n).json"))
      busy = false
    }

    private func watchdog(_ n: Int) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 3600) {
        self.answer(n, .failure(E2EError("no answer in 3600 s")))
      }
    }

    private func runJS(
      _ source: String, waited: TimeInterval = 0, done: @escaping (Result<Any?, Error>) -> Void
    ) {
      guard let webView = app?.web?.webView else { return done(.failure(E2EError("no web view"))) }
      if webView.isLoading || webView.url?.scheme != WebAssets.scheme {
        guard waited < 60 else { return done(.failure(E2EError("the page did not finish loading"))) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
          self.runJS(source, waited: waited + 0.05, done: done)
        }
        return
      }
      let body = "const __v = await (async () => {\n\(source)\n})(); return JSON.stringify(__v === undefined ? null : __v);"
      webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
        switch result {
        case .success(let raw):
          if let s = raw as? String, let d = s.data(using: .utf8),
            let v = try? JSONSerialization.jsonObject(with: d, options: [.fragmentsAllowed])
          {
            done(.success(v))
          } else {
            done(.success(raw))
          }
        case .failure(let error):
          let info = (error as NSError).userInfo
          let message = info["WKJavaScriptExceptionMessage"] as? String ?? error.localizedDescription
          done(.failure(E2EError(message)))
        }
      }
    }

    private func runNative(_ line: String, done: @escaping (Result<Any?, Error>) -> Void) {
      let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
      let arg = parts.count > 1 ? parts[1] : ""
      switch parts.first ?? "" {
      case "state":
        guard let app else { return done(.failure(E2EError("no app"))) }
        Task { done(.success(await app.debugState())) }
      case "menu":
        done(performMenuItem(titled: arg) ? .success(true) : .failure(E2EError("no menu item \(arg)")))
      case "menuitems":
        done(.success(menuTitles(arg)))
      case "badge":
        done(.success(NSApp.dockTile.badgeLabel ?? ""))
      case "hide":
        app?.window.orderOut(nil)
        done(.success(true))
      case "show":
        _ = app?.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
        done(.success(true))
      case "windowinfo":
        guard let w = app?.window else { return done(.failure(E2EError("no window"))) }
        done(.success([
          "title": w.title, "visible": w.isVisible, "width": w.frame.width, "height": w.frame.height,
          "zoom": app?.web.webView.pageZoom ?? 1,
        ]))
      case "screenshot":
        guard let webView = app?.web?.webView else { return done(.failure(E2EError("no web view"))) }
        webView.takeSnapshot(with: nil) { image, error in
          guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:])
          else { return done(.failure(error ?? E2EError("no snapshot"))) }
          do {
            try png.write(to: URL(fileURLWithPath: arg))
            done(.success(arg))
          } catch { done(.failure(error)) }
        }
      case "quit":
        done(.success(true))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
      default:
        done(.failure(E2EError("unknown native command \(line)")))
      }
    }

    /// Finds a menu item by its title ("File > New Task" or just "New Task") and performs it.
    private func performMenuItem(titled path: String) -> Bool {
      let wanted = path.split(separator: ">").map { $0.trimmingCharacters(in: .whitespaces) }
      guard let last = wanted.last, let main = NSApp.mainMenu else { return false }
      func search(_ menu: NSMenu, trail: [String]) -> NSMenuItem? {
        for item in menu.items {
          if item.title == last, wanted.count == 1 || trail.last == wanted[wanted.count - 2] { return item }
          if let sub = item.submenu, let found = search(sub, trail: trail + [item.title]) { return found }
        }
        return nil
      }
      guard let item = search(main, trail: []), item.isEnabled, let action = item.action else { return false }
      return NSApp.sendAction(action, to: item.target, from: item)
    }

    private func menuTitles(_ top: String) -> [String] {
      guard let main = NSApp.mainMenu else { return [] }
      if top.isEmpty { return main.items.map(\.title) }
      return main.items.first { $0.title == top }?.submenu?.items.filter { !$0.isSeparatorItem }.map(\.title) ?? []
    }
  }

  struct E2EError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
  }
#endif
