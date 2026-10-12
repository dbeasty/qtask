import Foundation

/// The GATT profile and the `info` value, mirrored from src/sync/ble/radio.ts. A device
/// that reads another device's `info` must get the same answer from both languages; the
/// golden vector in the tests is also in tests/sync-ble-tunnel.test.ts.
public enum BleProfile {
  public static let service = "7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a01"
  public static let info = "7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a02"
  public static let c2h = "7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a03"
  public static let h2c = "7d1a5b00-9a3c-4c52-8f4e-51a5c0de7a04"

  /// ATT opcode (1) + attribute handle (2): what one write or notification costs of the MTU.
  public static let attOverhead = 3
  public static let mtuMin = 23
  public static let mtuMax = 517

  /// Payload bytes one write-without-response or notification can carry at `mtu`.
  public static func chunkSize(mtu: Int) -> Int { max(1, min(mtu, mtuMax) - attOverhead) }

  /// The ATT MTU the Node side expects to be told: the stack reports the payload it will take
  /// (`maximumWriteValueLength`, `maximumUpdateValueLength`), so add the header back.
  public static func mtu(fromMaxPayload n: Int) -> Int { min(max(n + attOverhead, mtuMin), mtuMax) }
}

/// info = version(1) | flags(1) | nodeId(16) | keyTag(8) | [name utf8, <= 24 bytes, only while pairing].
public struct BleInfo: Equatable {
  public static let version: UInt8 = 1
  public static let flagPairing: UInt8 = 0x01

  public var nodeId: Data  // 16 bytes
  public var keyTag: Data  // 8 bytes
  public var pairing: Bool
  public var name: String?

  public init(nodeId: Data, keyTag: Data, pairing: Bool, name: String? = nil) {
    self.nodeId = nodeId
    self.keyTag = keyTag
    self.pairing = pairing
    self.name = name
  }

  public func encode() -> Data {
    var out = Data([Self.version, pairing ? Self.flagPairing : 0])
    out.append(nodeId)
    out.append(keyTag)
    if pairing, let name, !name.isEmpty {
      var bytes = Array(name.utf8.prefix(24))
      // Do not cut a multi-byte character in half.
      while !bytes.isEmpty, String(bytes: bytes, encoding: .utf8) == nil { bytes.removeLast() }
      out.append(contentsOf: bytes)
    }
    return out
  }

  /// Nil for anything that is not a well-formed info value.
  public static func decode(_ raw: Data) -> BleInfo? {
    let b = [UInt8](raw)
    guard b.count >= 26, b.count <= 50, b[0] == version else { return nil }
    let flags = b[1]
    guard flags & ~flagPairing == 0 else { return nil }
    let pairing = flags & flagPairing != 0
    if !pairing && b.count != 26 { return nil }
    var name: String?
    if b.count > 26 {
      guard let s = String(bytes: b[26...], encoding: .utf8) else { return nil }
      name = s
    }
    return BleInfo(nodeId: Data(b[2..<18]), keyTag: Data(b[18..<26]), pairing: pairing, name: name)
  }
}
