import Foundation

/// Newline-delimited JSON, the wire format of the app <-> Node Bluetooth bridge
/// (src/sync/ble/bridge.ts documents every message). Binary fields are base64 strings.
public enum BridgeCodec {
  /// Same bound as the Node side: a line longer than this is a protocol error.
  public static let maxLine = 16 * 1024

  public static func encode(_ message: [String: Any]) -> Data? {
    guard JSONSerialization.isValidJSONObject(message),
      var data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
    else { return nil }
    data.append(0x0A)
    return data
  }

  /// A JSON object with a string `t`, else nil.
  public static func decode(_ line: Data) -> [String: Any]? {
    guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any], obj["t"] is String else { return nil }
    return obj
  }
}

public struct BridgeLineDecoder {
  public enum Failure: Error, Equatable { case lineTooLong }

  private var buffer = Data()
  public init() {}

  /// Feed any slicing of the stream; returns the complete lines (without the newline).
  public mutating func push(_ chunk: Data) throws -> [Data] {
    buffer.append(chunk)
    var lines: [Data] = []
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer[buffer.startIndex..<nl]
      buffer = Data(buffer[buffer.index(after: nl)...])
      if line.count > BridgeCodec.maxLine { throw Failure.lineTooLong }
      if !line.isEmpty { lines.append(Data(line)) }
    }
    if buffer.count > BridgeCodec.maxLine { throw Failure.lineTooLong }
    return lines
  }

  public var pendingBytes: Int { buffer.count }
}

/// Chunks waiting for the radio. CoreBluetooth takes a write-without-response or a
/// notification only while its own queue has room (`canSendWriteWithoutResponse`,
/// `updateValue` returning true); this holds the rest and counts what the stack accepted,
/// which is exactly what the bridge's `acked` message reports back to Node.
public struct ChunkQueue {
  private var chunks: [Data] = []
  private var head = 0
  public init() {}

  public var count: Int { chunks.count - head }
  public var isEmpty: Bool { count == 0 }

  public mutating func enqueue(_ chunk: Data) { chunks.append(chunk) }

  /// Offers chunks to `send` in order until it refuses (returns false) or the queue is empty.
  /// Returns how many were accepted. A refused chunk stays at the front.
  @discardableResult
  public mutating func pump(send: (Data) -> Bool) -> Int {
    var accepted = 0
    while head < chunks.count {
      if !send(chunks[head]) { break }
      head += 1
      accepted += 1
    }
    if head > 64 && head * 2 > chunks.count {
      chunks.removeFirst(head)
      head = 0
    }
    return accepted
  }

  public mutating func removeAll() {
    chunks.removeAll()
    head = 0
  }
}
