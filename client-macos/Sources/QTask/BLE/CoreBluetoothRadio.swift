import CoreBluetooth
import Foundation
import QTaskCore

/// The native half of the Bluetooth radio: CoreBluetooth behind the JSON bridge protocol
/// that src/sync/ble/bridge.ts speaks. It moves bytes and reports the truth about the link;
/// it knows nothing about QTask data, pairing records or encryption (the tunnel in Node
/// does all of that). Every command the Node side may send is handled in `handle(_:)`;
/// everything CoreBluetooth reports leaves through `emit`.
///
/// No OS pairing and no bonding: no characteristic requires encryption, so macOS, iOS and
/// Android never show a pairing dialog and there is no stable address to rely on. Peers are
/// recognised by the node id inside the `info` characteristic, never by the CoreBluetooth
/// identifier.
///
/// Both roles run at once (advertise + scan). Everything runs on one serial queue.
///
/// STATUS: compiled, NOT tested against a radio. A Mac cannot hear its own advertisement, so a
/// second Bluetooth device is needed to exercise any of this; nothing here has been run
/// against real hardware. The behaviours marked "unverified" below are what the code assumes
/// about CoreBluetooth, from Apple's documentation, and need a two-device test.
final class CoreBluetoothRadio: NSObject {
  private let queue = DispatchQueue(label: "com.qtask.ble")
  private let service = CBUUID(string: BleProfile.service)
  private let infoUUID = CBUUID(string: BleProfile.info)
  private let c2hUUID = CBUUID(string: BleProfile.c2h)
  private let h2cUUID = CBUUID(string: BleProfile.h2c)

  /// Set by the owner. Called on the radio queue.
  var emit: (([String: Any]) -> Void)?

  // Managers are created on the first command so the Bluetooth permission prompt appears
  // when the user turns Bluetooth sync on, not when the app launches.
  private var central: CBCentralManager?
  private var peripheralManager: CBPeripheralManager?

  // Desired state: applied whenever the manager is powered on.
  private var desiredInfo: Data?
  private var desiredScan = false
  private var published = false
  private var lastState = ""

  private var infoValue = Data()
  private var infoChar: CBMutableCharacteristic?
  private var c2hChar: CBMutableCharacteristic?
  private var h2cChar: CBMutableCharacteristic?

  // MARK: central-role bookkeeping

  private final class OutLink {
    let id: String
    let peripheral: CBPeripheral
    var info: CBCharacteristic?
    var c2h: CBCharacteristic?
    var h2c: CBCharacteristic?
    var queue = ChunkQueue()
    var pendingInfoReq: [Int] = []
    var connectReq: Int?
    var ready = false
    init(id: String, peripheral: CBPeripheral) {
      self.id = id
      self.peripheral = peripheral
    }
  }

  private var seen: [UUID: CBPeripheral] = [:]
  private var outLinks: [String: OutLink] = [:]
  private var pendingConnects: [Int: OutLink] = [:]
  private var connectTimers: [Int: DispatchWorkItem] = [:]

  // MARK: peripheral-role bookkeeping

  private final class InLink {
    let id: String
    let central: CBCentral
    var queue = ChunkQueue()
    init(id: String, central: CBCentral) {
      self.id = id
      self.central = central
    }
  }

  private var inLinks: [UUID: InLink] = [:]

  // MARK: commands from Node

  func handle(_ cmd: [String: Any]) {
    queue.async { self.handleOnQueue(cmd) }
  }

  /// The bridge connection to Node dropped: every link is gone, desired state is forgotten
  /// (Node re-sends it when it reconnects).
  func reset() {
    queue.async {
      self.desiredInfo = nil
      self.desiredScan = false
      self.central?.stopScan()
      self.peripheralManager?.stopAdvertising()
      for (_, l) in self.outLinks { self.central?.cancelPeripheralConnection(l.peripheral) }
      self.outLinks.removeAll()
      self.pendingConnects.removeAll()
      for (_, w) in self.connectTimers { w.cancel() }
      self.connectTimers.removeAll()
      self.inLinks.removeAll()
    }
  }

  private func ensureManagers() {
    if central == nil {
      // State restoration (CBCentralManagerOptionRestoreIdentifierKey) is an iOS feature for
      // relaunching a terminated background app; a Mac app that is quit does not sync, so
      // it is deliberately not used here. The iOS client should pass restore identifiers.
      central = CBCentralManager(delegate: self, queue: queue)
    }
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(delegate: self, queue: queue)
    }
  }

  private func handleOnQueue(_ cmd: [String: Any]) {
    guard let t = cmd["t"] as? String else { return }
    switch t {
    case "adv.start":
      guard let b64 = cmd["info"] as? String, let d = Data(base64Encoded: b64) else { return }
      desiredInfo = d
      infoValue = d
      ensureManagers()
      applyAdvertising()
    case "adv.info":
      guard let b64 = cmd["info"] as? String, let d = Data(base64Encoded: b64) else { return }
      desiredInfo = d
      infoValue = d  // served on the next read; no new advertisement needed
    case "adv.stop":
      desiredInfo = nil
      peripheralManager?.stopAdvertising()
      peripheralManager?.removeAllServices()
      published = false
    case "scan.start":
      desiredScan = true
      ensureManagers()
      applyScan()
    case "scan.stop":
      desiredScan = false
      central?.stopScan()
    case "connect":
      guard let req = cmd["req"] as? Int, let dev = cmd["device"] as? String else { return }
      let timeoutMs = (cmd["timeoutMs"] as? Int) ?? 10_000
      ensureManagers()
      connect(req: req, device: dev, timeoutMs: timeoutMs)
    case "connect.cancel":
      if let req = cmd["req"] as? Int { cancelConnect(req: req, reason: nil) }
    case "info.read":
      guard let req = cmd["req"] as? Int, let id = cmd["link"] as? String, let l = outLinks[id], let c = l.info else {
        if let req = cmd["req"] as? Int { emit?(["t": "info.failed", "req": req, "error": "no such link"]) }
        return
      }
      l.pendingInfoReq.append(req)
      l.peripheral.readValue(for: c)
    case "write":
      guard let id = cmd["link"] as? String, let b64 = cmd["data"] as? String, let d = Data(base64Encoded: b64) else { return }
      if let l = outLinks[id] {
        l.queue.enqueue(d)
        pump(out: l)
      } else if let l = inLinks.values.first(where: { $0.id == id }) {
        l.queue.enqueue(d)
        pump(in: l)
      }
    case "close":
      guard let id = cmd["link"] as? String else { return }
      if let l = outLinks[id] {
        central?.cancelPeripheralConnection(l.peripheral)
      } else if let (k, l) = inLinks.first(where: { $0.value.id == id }) {
        // A peripheral cannot hang up on a central (CoreBluetooth has no API for it): stop
        // using the link and tell Node it is closed. The central drops the connection when
        // its own tunnel closes, which it does on the same event.
        inLinks.removeValue(forKey: k)
        l.queue.removeAll()
        emit?(["t": "closed", "link": id])
      }
    default:
      break
    }
  }

  // MARK: state

  private func reportState() {
    var s = "unknown"
    switch CBManager.authorization {
    case .denied, .restricted: s = "unauthorized"
    default:
      let states: [CBManagerState] = [central?.state, peripheralManager?.state].compactMap { $0 }
      if states.isEmpty { s = "unknown" }
      else if states.contains(.unauthorized) { s = "unauthorized" }
      else if states.contains(.unsupported) { s = "unsupported" }
      else if states.contains(.poweredOff) { s = "off" }
      else if states.allSatisfy({ $0 == .poweredOn }) { s = "on" }
    }
    if s != lastState {
      lastState = s
      emit?(["t": "state", "state": s])
    }
  }

  private func applyScan() {
    guard desiredScan, let central, central.state == .poweredOn else { return }
    // Each device is reported once per scan session unless duplicates are allowed. Node
    // restarts the scan when it needs to hear a device again (it stops and starts it).
    central.scanForPeripherals(withServices: [service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
  }

  private func applyAdvertising() {
    guard desiredInfo != nil, let pm = peripheralManager, pm.state == .poweredOn else { return }
    if !published {
      published = true
      let info = CBMutableCharacteristic(type: infoUUID, properties: [.read], value: nil, permissions: [.readable])
      let c2h = CBMutableCharacteristic(type: c2hUUID, properties: [.writeWithoutResponse], value: nil, permissions: [.writeable])
      let h2c = CBMutableCharacteristic(type: h2cUUID, properties: [.notify], value: nil, permissions: [.readable])
      infoChar = info
      c2hChar = c2h
      h2cChar = h2c
      let svc = CBMutableService(type: service, primary: true)
      svc.characteristics = [info, c2h, h2c]
      pm.removeAllServices()
      pm.add(svc)
      return  // advertising starts in didAdd
    }
    startAdvertisingNow()
  }

  private func startAdvertisingNow() {
    guard let pm = peripheralManager, pm.state == .poweredOn, !pm.isAdvertising else { return }
    // The service UUID only. No local name: the device name would announce who is nearby.
    pm.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [service]])
  }

  // MARK: central role: connect

  private func connect(req: Int, device: String, timeoutMs: Int) {
    guard let central, let uuid = UUID(uuidString: device) else {
      emit?(["t": "connect.failed", "req": req, "error": "unknown device"])
      return
    }
    let peripheral = seen[uuid] ?? central.retrievePeripherals(withIdentifiers: [uuid]).first
    guard let peripheral else {
      // The identifier is not known to the stack: typically a rotated address.
      emit?(["t": "connect.failed", "req": req, "error": "unknown device"])
      return
    }
    let link = OutLink(id: UUID().uuidString, peripheral: peripheral)
    link.connectReq = req
    pendingConnects[req] = link
    peripheral.delegate = self
    seen[uuid] = peripheral
    // CoreBluetooth never times a connection out by itself; a pending connect to a device
    // that is out of range would wait forever.
    let timer = DispatchWorkItem { [weak self] in self?.cancelConnect(req: req, reason: "connect timeout") }
    connectTimers[req] = timer
    queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timer)
    if central.state == .poweredOn {
      central.connect(peripheral, options: nil)
    } else {
      cancelConnect(req: req, reason: "bluetooth is not on")
    }
  }

  private func cancelConnect(req: Int, reason: String?) {
    connectTimers.removeValue(forKey: req)?.cancel()
    guard let link = pendingConnects.removeValue(forKey: req) else { return }
    central?.cancelPeripheralConnection(link.peripheral)
    if let reason { emit?(["t": "connect.failed", "req": req, "error": reason]) }
  }

  private func finishConnect(_ link: OutLink) {
    guard let req = link.connectReq else { return }
    link.connectReq = nil
    connectTimers.removeValue(forKey: req)?.cancel()
    pendingConnects.removeValue(forKey: req)
    link.ready = true
    outLinks[link.id] = link
    let payload = link.peripheral.maximumWriteValueLength(for: .withoutResponse)
    emit?(["t": "connected", "req": req, "link": link.id, "mtu": BleProfile.mtu(fromMaxPayload: payload)])
  }

  private func failConnect(peripheral: CBPeripheral, error: String) {
    for (req, l) in pendingConnects where l.peripheral === peripheral {
      connectTimers.removeValue(forKey: req)?.cancel()
      pendingConnects.removeValue(forKey: req)
      central?.cancelPeripheralConnection(peripheral)
      emit?(["t": "connect.failed", "req": req, "error": error])
    }
  }

  private func outLink(for peripheral: CBPeripheral) -> OutLink? {
    if let l = outLinks.values.first(where: { $0.peripheral === peripheral }) { return l }
    return pendingConnects.values.first(where: { $0.peripheral === peripheral })
  }

  // MARK: write queues

  private func pump(out l: OutLink) {
    guard l.ready, let c2h = l.c2h else { return }
    let n = l.queue.pump { chunk in
      // Unverified: canSendWriteWithoutResponse turns false when the stack's queue is full and
      // peripheralIsReady(toSendWriteWithoutResponse:) fires when there is room again.
      guard l.peripheral.canSendWriteWithoutResponse else { return false }
      l.peripheral.writeValue(chunk, for: c2h, type: .withoutResponse)
      return true
    }
    if n > 0 { emit?(["t": "acked", "link": l.id, "n": n]) }
  }

  private func pump(in l: InLink) {
    guard let pm = peripheralManager, let h2c = h2cChar else { return }
    let n = l.queue.pump { chunk in
      // updateValue returns false when the transmit queue is full; peripheralManagerIsReady
      // fires when it can take more. The chunk is not consumed in that case.
      pm.updateValue(chunk, for: h2c, onSubscribedCentrals: [l.central])
    }
    if n > 0 { emit?(["t": "acked", "link": l.id, "n": n]) }
  }
}

// MARK: - CBCentralManagerDelegate

extension CoreBluetoothRadio: CBCentralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    reportState()
    if central.state == .poweredOn { applyScan() }
    if central.state != .poweredOn {
      for (id, l) in outLinks {
        outLinks.removeValue(forKey: id)
        emit?(["t": "closed", "link": id, "error": "bluetooth turned off"])
        _ = l
      }
    }
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    seen[peripheral.identifier] = peripheral
    emit?(["t": "discovered", "device": peripheral.identifier.uuidString, "rssi": RSSI.intValue])
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices([service])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    failConnect(peripheral: peripheral, error: error?.localizedDescription ?? "could not connect")
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    if let (id, l) = outLinks.first(where: { $0.value.peripheral === peripheral }) {
      outLinks.removeValue(forKey: id)
      for req in l.pendingInfoReq { emit?(["t": "info.failed", "req": req, "error": "disconnected"]) }
      emit?(["t": "closed", "link": id, "error": error?.localizedDescription ?? "disconnected"])
    } else {
      failConnect(peripheral: peripheral, error: error?.localizedDescription ?? "disconnected")
    }
  }
}

// MARK: - CBPeripheralDelegate (we are the central)

extension CoreBluetoothRadio: CBPeripheralDelegate {
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil, let svc = peripheral.services?.first(where: { $0.uuid == service }) else {
      failConnect(peripheral: peripheral, error: "not a QTask device")
      return
    }
    peripheral.discoverCharacteristics([infoUUID, c2hUUID, h2cUUID], for: svc)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard let link = outLink(for: peripheral) else { return }
    for c in service.characteristics ?? [] {
      if c.uuid == infoUUID { link.info = c }
      if c.uuid == c2hUUID { link.c2h = c }
      if c.uuid == h2cUUID { link.h2c = c }
    }
    guard error == nil, link.info != nil, link.c2h != nil, let h2c = link.h2c else {
      failConnect(peripheral: peripheral, error: "not a QTask device")
      return
    }
    peripheral.setNotifyValue(true, for: h2c)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard let link = outLink(for: peripheral), characteristic.uuid == h2cUUID else { return }
    if let error {
      failConnect(peripheral: peripheral, error: error.localizedDescription)
    } else if characteristic.isNotifying {
      finishConnect(link)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard let link = outLink(for: peripheral) else { return }
    if characteristic.uuid == infoUUID {
      guard !link.pendingInfoReq.isEmpty else { return }
      let req = link.pendingInfoReq.removeFirst()
      if let v = characteristic.value, error == nil {
        emit?(["t": "info", "req": req, "data": v.base64EncodedString()])
      } else {
        emit?(["t": "info.failed", "req": req, "error": error?.localizedDescription ?? "empty"])
      }
      return
    }
    if characteristic.uuid == h2cUUID, let v = characteristic.value, !v.isEmpty {
      emit?(["t": "data", "link": link.id, "data": v.base64EncodedString()])
    }
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    if let l = outLink(for: peripheral) { pump(out: l) }
  }

  /// The remote service went away under a live link (the other app restarted Bluetooth).
  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    if invalidatedServices.contains(where: { $0.uuid == service }) {
      central?.cancelPeripheralConnection(peripheral)
    }
  }
}

// MARK: - CBPeripheralManagerDelegate (we are the peripheral)

extension CoreBluetoothRadio: CBPeripheralManagerDelegate {
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    reportState()
    if peripheral.state == .poweredOn {
      applyAdvertising()
    } else {
      published = false
      for (k, l) in inLinks {
        inLinks.removeValue(forKey: k)
        emit?(["t": "closed", "link": l.id, "error": "bluetooth turned off"])
      }
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if error == nil { startAdvertisingNow() } else { published = false }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard request.characteristic.uuid == infoUUID else {
      peripheral.respond(to: request, withResult: .requestNotSupported)
      return
    }
    guard request.offset <= infoValue.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = infoValue.subdata(in: request.offset..<infoValue.count)
    peripheral.respond(to: request, withResult: .success)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    for r in requests where r.characteristic.uuid == c2hUUID {
      guard let v = r.value, !v.isEmpty, let link = inLinks[r.central.identifier] else { continue }
      emit?(["t": "data", "link": link.id, "data": v.base64EncodedString()])
    }
    // Unverified: for a characteristic that only declares write-without-response the central
    // expects no reply and CoreBluetooth ignores this call; if it does not, it is still harmless.
    if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
    guard characteristic.uuid == h2cUUID, inLinks[central.identifier] == nil else { return }
    let link = InLink(id: UUID().uuidString, central: central)
    inLinks[central.identifier] = link
    emit?(["t": "incoming", "link": link.id, "mtu": BleProfile.mtu(fromMaxPayload: central.maximumUpdateValueLength)])
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
    // Unsubscribing is how a central that disconnected shows up here.
    guard characteristic.uuid == h2cUUID, let link = inLinks.removeValue(forKey: central.identifier) else { return }
    emit?(["t": "closed", "link": link.id])
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    for l in inLinks.values { pump(in: l) }
  }
}
