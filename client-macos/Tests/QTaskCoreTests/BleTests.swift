import Foundation
import XCTest

@testable import QTaskCore

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
private func bytes(_ h: String) -> Data {
  var out = Data()
  var i = h.startIndex
  while i < h.endIndex {
    let j = h.index(i, offsetBy: 2)
    out.append(UInt8(h[i..<j], radix: 16)!)
    i = j
  }
  return out
}

/// These golden values are also asserted in tests/sync-ble-tunnel.test.ts: the two languages must agree
/// on the bytes of `info`, since devices running either read each other's.
final class BleInfoTests: XCTestCase {
  let nodeId = bytes("000102030405060708090a0b0c0d0e0f")
  let keyTag = bytes("a0a1a2a3a4a5a6a7")

  func testGoldenEncodingMatchesTheNodeSide() {
    let plain = BleInfo(nodeId: nodeId, keyTag: keyTag, pairing: false, name: "ignored")
    XCTAssertEqual(hex(plain.encode()), "0100000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7")
    let pairing = BleInfo(nodeId: nodeId, keyTag: keyTag, pairing: true, name: "Mac")
    XCTAssertEqual(hex(pairing.encode()), "0101000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a74d6163")
  }

  func testRoundTripAndNameTruncationKeepsCharactersWhole() {
    let long = String(repeating: "é", count: 20)  // 40 bytes
    let enc = BleInfo(nodeId: nodeId, keyTag: keyTag, pairing: true, name: long).encode()
    let back = BleInfo.decode(enc)
    XCTAssertNotNil(back)
    XCTAssertEqual(back?.name, String(repeating: "é", count: 12))  // 24 bytes, no half character
    XCTAssertEqual(back?.nodeId, nodeId)
  }

  func testRejectsMalformedValues() {
    XCTAssertNil(BleInfo.decode(Data()))
    XCTAssertNil(BleInfo.decode(Data(count: 25)))
    var bad = BleInfo(nodeId: nodeId, keyTag: keyTag, pairing: false).encode()
    bad[0] = 9
    XCTAssertNil(BleInfo.decode(bad))
    var flags = BleInfo(nodeId: nodeId, keyTag: keyTag, pairing: false).encode()
    flags[1] = 0x80
    XCTAssertNil(BleInfo.decode(flags))
    var named = BleInfo(nodeId: nodeId, keyTag: keyTag, pairing: false).encode()
    named.append(0x41)  // a name without the pairing flag
    XCTAssertNil(BleInfo.decode(named))
    var generator = SystemRandomNumberGenerator()
    for _ in 0..<3000 {
      let n = Int.random(in: 0..<60, using: &generator)
      let junk = Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &generator) })
      _ = BleInfo.decode(junk)  // must not crash
    }
  }

  func testChunkSizeAndMtu() {
    XCTAssertEqual(BleProfile.chunkSize(mtu: 23), 20)
    XCTAssertEqual(BleProfile.chunkSize(mtu: 185), 182)
    XCTAssertEqual(BleProfile.chunkSize(mtu: 517), 514)
    XCTAssertEqual(BleProfile.chunkSize(mtu: 9999), 514)
    XCTAssertEqual(BleProfile.mtu(fromMaxPayload: 20), 23)
    XCTAssertEqual(BleProfile.mtu(fromMaxPayload: 512), 515)
    XCTAssertEqual(BleProfile.mtu(fromMaxPayload: 1), 23)
  }
}

final class BridgeCodecTests: XCTestCase {
  func testEncodeDecodeRoundTrip() throws {
    let msg: [String: Any] = ["t": "write", "link": "L1", "data": Data([1, 2, 3]).base64EncodedString()]
    let line = try XCTUnwrap(BridgeCodec.encode(msg))
    XCTAssertEqual(line.last, 0x0A)
    let back = try XCTUnwrap(BridgeCodec.decode(line.dropLast()))
    XCTAssertEqual(back["t"] as? String, "write")
    XCTAssertEqual(back["data"] as? String, "AQID")
  }

  func testDecodeRejectsNonObjectsAndMissingType() {
    for s in ["[1,2]", "null", "{\"x\":1}", "{\"t\":5}", "garbage", ""] {
      XCTAssertNil(BridgeCodec.decode(Data(s.utf8)), s)
    }
  }

  func testLinesSurviveAnySlicing() throws {
    let lines = ["{\"t\":\"a\"}", "{\"t\":\"b\",\"x\":1}", "{\"t\":\"c\",\"d\":\"" + String(repeating: "z", count: 500) + "\"}"]
    let stream = Data((lines.joined(separator: "\n") + "\n").utf8)
    for _ in 0..<50 {
      var d = BridgeLineDecoder()
      var out: [String] = []
      var off = 0
      while off < stream.count {
        let n = min(Int.random(in: 1...30), stream.count - off)
        out += try d.push(stream[off..<off + n]).map { String(decoding: $0, as: UTF8.self) }
        off += n
      }
      XCTAssertEqual(out, lines)
      XCTAssertEqual(d.pendingBytes, 0)
    }
  }

  func testOversizedLineIsAnError() {
    var d = BridgeLineDecoder()
    XCTAssertThrowsError(try d.push(Data(repeating: 0x78, count: BridgeCodec.maxLine + 1))) { e in
      XCTAssertEqual(e as? BridgeLineDecoder.Failure, .lineTooLong)
    }
    var e = BridgeLineDecoder()
    XCTAssertThrowsError(try e.push(Data(repeating: 0x78, count: BridgeCodec.maxLine + 10) + Data([0x0A])))
  }

  func testFuzzNeverCrashes() {
    var g = SystemRandomNumberGenerator()
    for _ in 0..<2000 {
      var d = BridgeLineDecoder()
      let n = Int.random(in: 0..<200, using: &g)
      let junk = Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
      if let lines = try? d.push(junk) { for l in lines { _ = BridgeCodec.decode(l) } }
    }
  }
}

final class ChunkQueueTests: XCTestCase {
  func testAcceptsInOrderUntilTheRadioRefuses() {
    var q = ChunkQueue()
    for i in 0..<10 { q.enqueue(Data([UInt8(i)])) }
    var sent: [UInt8] = []
    var budget = 4
    let n = q.pump { chunk in
      guard budget > 0 else { return false }
      budget -= 1
      sent.append(chunk[0])
      return true
    }
    XCTAssertEqual(n, 4)
    XCTAssertEqual(sent, [0, 1, 2, 3])
    XCTAssertEqual(q.count, 6)
    // The refused chunk stayed at the front and is offered first next time.
    var next: [UInt8] = []
    XCTAssertEqual(q.pump { next.append($0[0]); return true }, 6)
    XCTAssertEqual(next, [4, 5, 6, 7, 8, 9])
    XCTAssertTrue(q.isEmpty)
  }

  func testRefusalLeavesEverythingQueued() {
    var q = ChunkQueue()
    q.enqueue(Data([1]))
    XCTAssertEqual(q.pump { _ in false }, 0)
    XCTAssertEqual(q.count, 1)
    q.removeAll()
    XCTAssertTrue(q.isEmpty)
  }

  func testLongRunsDoNotGrowWithoutBound() {
    var q = ChunkQueue()
    var total = 0
    for round in 0..<200 {
      for i in 0..<50 { q.enqueue(Data([UInt8((round + i) % 256)])) }
      total += q.pump { _ in true }
    }
    XCTAssertEqual(total, 10_000)
    XCTAssertTrue(q.isEmpty)
  }
}

final class BleLaunchTests: XCTestCase {
  func testBridgeIsOpenUnlessSwitchedOffAndTheToggleDecidesUse() {
    XCTAssertTrue(Launch.bleBridgeWanted(environment: [:]))
    XCTAssertTrue(Launch.bleBridgeWanted(environment: ["QTASK_BLE": "1"]))
    XCTAssertFalse(Launch.bleBridgeWanted(environment: ["QTASK_BLE": "0"]))
  }

  func testOnlyTheSyncOffSwitchIsPassedThrough() {
    let off = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"),
      inherit: ["QTASK_LOCAL_SYNC": "0", "QTASK_SYNC_MDNS_PORT": "1"])
    XCTAssertEqual(off["QTASK_LOCAL_SYNC"], "0")
    XCTAssertNil(off["QTASK_SYNC_MDNS_PORT"])
    let on = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"),
      inherit: ["QTASK_LOCAL_SYNC": "yes"])
    XCTAssertNil(on["QTASK_LOCAL_SYNC"])
  }

  func testDeviceNameIsPassedTrimmedAndBounded() {
    let env = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"),
      deviceName: "  Dana's MacBook  ", inherit: [:])
    XCTAssertEqual(env["QTASK_DEVICE_NAME"], "Dana's MacBook")
    let long = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"),
      deviceName: String(repeating: "x", count: 200), inherit: [:])
    XCTAssertEqual(long["QTASK_DEVICE_NAME"]?.count, 60)
    let none = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"), inherit: [:])
    XCTAssertNil(none["QTASK_DEVICE_NAME"])
  }

  /// Without both keys macOS blocks Bonjour and LAN connections after the first prompt.
  func testInfoPlistDeclaresLocalNetworkAndBonjour() throws {
    let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources/Info.plist")
    let obj = try PropertyListSerialization.propertyList(from: Data(contentsOf: plist), format: nil) as? [String: Any]
    XCTAssertFalse((obj?["NSLocalNetworkUsageDescription"] as? String ?? "").isEmpty)
    XCTAssertEqual(obj?["NSBonjourServices"] as? [String], ["_qtask._tcp"])
    XCTAssertFalse((obj?["NSBluetoothAlwaysUsageDescription"] as? String ?? "").isEmpty)
    let schemes = (obj?["CFBundleURLTypes"] as? [[String: Any]])?.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
    XCTAssertEqual(schemes, ["qtask"])
    let ent = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources/QTask.entitlements")
    let e = try PropertyListSerialization.propertyList(from: Data(contentsOf: ent), format: nil) as? [String: Any]
    XCTAssertEqual(e?["com.apple.security.network.client"] as? Bool, true)
    XCTAssertEqual(e?["com.apple.security.network.server"] as? Bool, true)
  }

  func testBridgeIsOptInAndNeverInherited() {
    let base = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"),
      inherit: ["QTASK_BLE_BRIDGE": "1"])
    XCTAssertNil(base["QTASK_BLE_BRIDGE"])
    let on = Launch.nodeEnvironment(
      dataDir: URL(fileURLWithPath: "/d"), deviceToken: "t", kdbPort: 1, kdbClientModule: URL(fileURLWithPath: "/k.mjs"), bleBridge: true,
      inherit: [:])
    XCTAssertEqual(on["QTASK_BLE_BRIDGE"], "1")
  }
}
