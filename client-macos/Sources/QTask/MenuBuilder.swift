import AppKit

/// The menu bar. Targets are nil so every action travels the responder chain to the
/// AppDelegate (or, for the standard Edit items, to the web view).
enum MenuBuilder {
  static func build() -> NSMenu {
    let main = NSMenu()
    main.addItem(submenu(appMenu()))
    main.addItem(submenu(fileMenu()))
    main.addItem(submenu(editMenu()))
    main.addItem(submenu(viewMenu()))
    let windowMenu = windowMenu()
    main.addItem(submenu(windowMenu))
    NSApp.windowsMenu = windowMenu
    main.addItem(submenu(helpMenu()))
    return main
  }

  private static func submenu(_ menu: NSMenu) -> NSMenuItem {
    let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
    item.submenu = menu
    return item
  }

  @discardableResult
  private static func add(
    _ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "",
    _ mods: NSEvent.ModifierFlags = [.command]
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.keyEquivalentModifierMask = mods
    menu.addItem(item)
    return item
  }

  private static func appMenu() -> NSMenu {
    let m = NSMenu(title: "QTask")
    add(m, "About QTask", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", [])
    m.addItem(.separator())
    let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
    let servicesMenu = NSMenu(title: "Services")
    services.submenu = servicesMenu
    NSApp.servicesMenu = servicesMenu
    m.addItem(services)
    m.addItem(.separator())
    add(m, "Hide QTask", #selector(NSApplication.hide(_:)), "h")
    add(m, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
    add(m, "Show All", #selector(NSApplication.unhideAllApplications(_:)), "", [])
    m.addItem(.separator())
    add(m, "Quit QTask", #selector(NSApplication.terminate(_:)), "q")
    return m
  }

  private static func fileMenu() -> NSMenu {
    let m = NSMenu(title: "File")
    add(m, "New Task", Selector(("newTask:")), "n")
    add(m, "New Project", Selector(("newProject:")), "n", [.command, .shift])
    m.addItem(.separator())
    add(m, "Pair Device…", Selector(("pairDevice:")), "", [])
    add(m, "Sync Now", Selector(("syncNow:")), "s", [.command, .option])
    add(m, "Sync over Bluetooth", Selector(("toggleBluetoothSync:")), "", [])
    m.addItem(.separator())
    add(m, "Close Window", #selector(NSWindow.performClose(_:)), "w")
    return m
  }

  private static func editMenu() -> NSMenu {
    let m = NSMenu(title: "Edit")
    add(m, "Undo", Selector(("undo:")), "z")
    add(m, "Redo", Selector(("redo:")), "z", [.command, .shift])
    m.addItem(.separator())
    add(m, "Cut", #selector(NSText.cut(_:)), "x")
    add(m, "Copy", #selector(NSText.copy(_:)), "c")
    add(m, "Paste", #selector(NSText.paste(_:)), "v")
    add(m, "Select All", #selector(NSText.selectAll(_:)), "a")
    m.addItem(.separator())
    add(m, "Find", Selector(("find:")), "f")
    return m
  }

  private static func viewMenu() -> NSMenu {
    let m = NSMenu(title: "View")
    add(m, "Projects", Selector(("showProjects:")), "1")
    add(m, "Tasks", Selector(("showTasks:")), "2")
    add(m, "Devices & Sync", Selector(("showDevices:")), "3")
    m.addItem(.separator())
    add(m, "Actual Size", Selector(("zoomReset:")), "0")
    add(m, "Zoom In", Selector(("zoomIn:")), "+")
    add(m, "Zoom Out", Selector(("zoomOut:")), "-")
    m.addItem(.separator())
    add(m, "Reload", Selector(("reloadPage:")), "r")
    add(m, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
    return m
  }

  private static func windowMenu() -> NSMenu {
    let m = NSMenu(title: "Window")
    add(m, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
    add(m, "Zoom", #selector(NSWindow.performZoom(_:)), "", [])
    m.addItem(.separator())
    add(m, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "", [])
    return m
  }

  private static func helpMenu() -> NSMenu {
    let m = NSMenu(title: "Help")
    add(m, "Show Log Folder", Selector(("revealLogs:")), "", [])
    NSApp.helpMenu = m
    return m
  }
}
