import Foundation
import Network
import QTaskCore

/// The app's end of the Bluetooth bridge: a loopback TCP connection to the Node backend,
/// authenticated with the same per-launch device token the app uses for HTTP. It carries the
/// JSON lines that src/sync/ble/bridge.ts defines between Node and `CoreBluetoothRadio`.
///
/// Reconnects if the connection drops while the backend is still running (Node keeps its
/// transport and re-sends its desired radio state when the bridge comes back). When it
/// drops, every Bluetooth link is torn down, since Node has forgotten them too.
final class BLEBridgeClient: @unchecked Sendable {
  private let port: NWEndpoint.Port
  private let token: String
  private let radio: CoreBluetoothRadio
  private let queue = DispatchQueue(label: "com.qtask.ble.bridge")
  private var connection: NWConnection?
  private var decoder = BridgeLineDecoder()
  private var stopped = false

  init?(port: Int, token: String, radio: CoreBluetoothRadio) {
    guard let p = NWEndpoint.Port(rawValue: UInt16(truncatingIfNeeded: port)), port > 0, port < 65536 else { return nil }
    self.port = p
    self.token = token
    self.radio = radio
    radio.emit = { [weak self] message in self?.send(message) }
  }

  func start() {
    queue.async { self.connect() }
  }

  func stop() {
    queue.async {
      self.stopped = true
      self.connection?.cancel()
      self.connection = nil
      self.radio.reset()
    }
  }

  private func connect() {
    guard !stopped else { return }
    decoder = BridgeLineDecoder()
    // Loopback only, never a hostname: the port came from the backend we started.
    let c = NWConnection(host: NWEndpoint.Host("127.0.0.1"), port: port, using: .tcp)
    connection = c
    c.stateUpdateHandler = { [weak self, weak c] state in
      guard let self, let c else { return }
      switch state {
      case .ready:
        self.writeLine(["t": "auth", "token": self.token], on: c)
        self.receive(on: c)
      case .failed, .cancelled:
        self.dropped(c)
      default:
        break
      }
    }
    c.start(queue: queue)
  }

  private func dropped(_ c: NWConnection) {
    guard connection === c else { return }
    connection = nil
    radio.reset()
    guard !stopped else { return }
    queue.asyncAfter(deadline: .now() + 1) { self.connect() }
  }

  private func receive(on c: NWConnection) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak c] data, _, isComplete, error in
      guard let self, let c, self.connection === c else { return }
      if let data, !data.isEmpty {
        do {
          for line in try self.decoder.push(data) {
            if let message = BridgeCodec.decode(line) { self.radio.handle(message) }
          }
        } catch {
          // Oversized line: the peer is not speaking the protocol. Drop and reconnect.
          c.cancel()
          return
        }
      }
      if isComplete || error != nil {
        c.cancel()
        return
      }
      self.receive(on: c)
    }
  }

  private func send(_ message: [String: Any]) {
    queue.async {
      guard let c = self.connection else { return }
      self.writeLine(message, on: c)
    }
  }

  private func writeLine(_ message: [String: Any], on c: NWConnection) {
    guard let data = BridgeCodec.encode(message) else { return }
    c.send(content: data, completion: .contentProcessed { _ in })
  }
}
