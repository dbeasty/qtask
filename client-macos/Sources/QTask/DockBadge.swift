import AppKit

/// The Dock badge: how many open tasks are due today.
///
/// Counts come from the local server's own list endpoint (`total` with limit 1), so the
/// badge agrees with the app. Refreshed on a timer, when the page reports a change, and
/// when the app becomes active (the day may have rolled over).
@MainActor
final class DockBadge {
  private let http: BackendHTTP
  private var timer: Timer?
  private var pending: DispatchWorkItem?
  private(set) var lastCount = 0

  init(http: BackendHTTP) { self.http = http }

  func start() {
    refreshSoon(after: 0)
    timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in self?.refreshSoon(after: 0) }
  }

  func stop() {
    timer?.invalidate()
    pending?.cancel()
    NSApp.dockTile.badgeLabel = nil
  }

  /// Coalesces bursts (every save is a write) into one refresh.
  func refreshSoon(after delay: TimeInterval = 0.6) {
    pending?.cancel()
    let work = DispatchWorkItem { [weak self] in
      Task { await self?.refresh() }
    }
    pending = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  func refresh() async {
    let cal = Calendar.current
    let start = cal.startOfDay(for: Date())
    guard let end = cal.date(byAdding: .day, value: 1, to: start)?.addingTimeInterval(-0.001) else { return }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let range = "dueAfter=\(f.string(from: start))&dueBefore=\(f.string(from: end))&limit=1"
    var sum = 0
    do {
      for status in ["todo", "in_progress"] {
        let r = try await http.authorizedGet("/api/tasks?status=\(status)&\(range)")
        guard r.status == 200, let obj = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any],
          let n = obj["total"] as? Int
        else { return }
        sum += n
      }
    } catch {
      return
    }
    let total = sum
    await MainActor.run {
      lastCount = total
      NSApp.dockTile.badgeLabel = total > 0 ? String(total) : nil
    }
  }
}
