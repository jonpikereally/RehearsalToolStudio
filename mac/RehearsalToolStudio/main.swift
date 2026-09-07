import Cocoa
@preconcurrency import WebKit

/*
 * Rehearsal Tool Studio, the Mac app.
 *
 * One window, one web view, pointed at the studio's own server on this
 * machine. The app is deliberately dumb: it starts the servers through the
 * repo's launcher (which builds the studio when the source has moved), waits
 * for one of them to answer, and shows the page. Everything the studio does
 * with the disk goes through that server, so there is nothing here to bridge
 * — no file dialogs, no native hooks, no messages between the two sides.
 *
 * Why not a browser: a Chrome --app window belongs to Chrome, wears Chrome's
 * icon, and needs the File System Access API to reach the disk, which the
 * server now does better. What a browser gave for free is filled in below —
 * an Edit menu so copy and paste work, a place for downloads to land, the
 * three JavaScript dialogs, and links out opening in the real browser.
 *
 * Built and installed by scripts/make-studio-app.sh, which bakes the repo's
 * path into Info.plist as RTSRepo so this can find the launcher.
 */

let studioURL = URL(string: "http://localhost:5177/")!
let appName = "Rehearsal Tool Studio"
let repo = Bundle.main.object(forInfoDictionaryKey: "RTSRepo") as? String ?? ""
/*
 * Two kinds of this app. The development one carries the repo's path and runs
 * its launcher, which rebuilds the studio when the source has moved. The
 * packaged one (scripts/package-app.sh) carries no path at all: Node, the
 * build and the servers travel inside it, and its launcher sits beside them.
 * No RTSRepo is how it tells which it is.
 */
let packaged = repo.isEmpty
let resources = Bundle.main.resourcePath ?? ""
let launcherPath = packaged ? "\(resources)/launch.sh" : "\(repo)/scripts/app-launch.sh"
let logPath = packaged ? "~/Library/Logs/Rehearsal Tool Studio/launch.log" : "\(repo)/.studio-build.log"
let ink = NSColor(red: 0x0d / 255, green: 0x0f / 255, blue: 0x13 / 255, alpha: 1)

/// A page of the app's own, for the moments before and instead of the studio.
func page(_ title: String, _ detail: String) -> String {
    """
    <!doctype html><meta charset="utf-8">
    <style>
      html { background: #0d0f13; color: #c9d1dc; height: 100%; display: grid; place-items: center;
             font: 15px/1.5 -apple-system, system-ui, sans-serif; }
      p { max-width: 36em; margin: 0 24px; text-align: center; }
      b { display: block; color: #fff; font-size: 19px; margin-bottom: 8px; }
      code { font: 13px ui-monospace, Menlo, monospace; color: #9fb0c8; }
    </style>
    <p><b>\(title)</b>\(detail)</p>
    """
}

/*
 * The web view, taking a folder or a set dropped on it before WebKit can
 * make a page of the file. Everything else dragged in — text into a field —
 * goes on to WebKit as it always did.
 */
final class StudioWebView: WKWebView {
    var onDrop: (([String]) -> Void)?
    var onDragging: ((Bool) -> Void)?

    /// The folders and Ableton sets among what is being dragged.
    private func openable(_ info: NSDraggingInfo) -> [String] {
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.map(\.path).filter { path in
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { return false }
            return isDir.boolValue || path.lowercased().hasSuffix(".als")
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        if openable(sender).isEmpty { return super.draggingEntered(sender) }
        onDragging?(true)
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        openable(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragging?(false)
        if let sender, !openable(sender).isEmpty { return }
        super.draggingExited(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        openable(sender).isEmpty ? super.prepareForDragOperation(sender) : true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let paths = openable(sender)
        onDragging?(false)
        if paths.isEmpty { return super.performDragOperation(sender) }
        onDrop?(paths)
        return true
    }
}

final class Studio: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: StudioWebView!
    /// The chooser: a small window of its own, in front of the studio.
    var chooserWindow: NSWindow?
    var chooserWeb: WKWebView?
    var titleWatch: NSKeyValueObservation?
    /// The build the page was loaded from, to notice when the server has moved on.
    var loadedBuild: String?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        // The page's way of asking things of the app: for now, to be kept awake.
        config.userContentController.add(self, name: "studio")
        /*
         * The page runs in WebKit's own WebContent process, and WebKit naps
         * that process whenever the window is covered or the app is behind —
         * its timers throttled, its priority dropped — whatever the app
         * itself asserts. A prepare then wrote a part every eight seconds
         * while somebody watched and nothing for minutes while they didn't.
         * These are WebKit's private switches for exactly that, reached the
         * way developerExtrasEnabled is above, and only when this build of
         * WebKit answers to them, so a WebKit that has renamed them costs
         * nothing but the setting.
         */
        for key in ["pageVisibilityBasedProcessSuppressionEnabled", "hiddenPageDOMTimerThrottlingEnabled"] {
            let setter = Selector("_set\(key.prefix(1).uppercased())\(key.dropFirst()):")
            if config.preferences.responds(to: setter) {
                config.preferences.setValue(false, forKey: key)
            }
        }
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // "Inspect Element" in the context menu: the studio is a tool, and tools get opened up.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        web = StudioWebView(frame: .zero, configuration: config)
        web.onDrop = { [weak self] paths in self?.open(paths) }
        web.onDragging = { [weak self] over in self?.tell("studio:drag", ["over": over]) }
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = ink
        if #available(macOS 13.3, *) { web.isInspectable = true }
        titleWatch = web.observe(\.title) { [weak self] web, _ in
            self?.window.title = (web.title?.isEmpty == false) ? web.title! : appName
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = appName
        window.minSize = NSSize(width: 720, height: 480)
        window.backgroundColor = ink
        window.contentView = web
        window.isReleasedWhenClosed = false
        // Where it was last left, or the middle of the screen the first time.
        if !window.setFrameUsingName("studio") { window.center() }
        window.setFrameAutosaveName("studio")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        web.loadHTMLString(page("Starting the studio…",
            packaged ? "Starting its server." : "Building it first if the source has moved on, which takes a moment."), baseURL: nil)
        DispatchQueue.global(qos: .userInitiated).async {
            let build = self.startServers()
            DispatchQueue.main.async {
                if let build {
                    self.loadedBuild = build
                    self.web.load(URLRequest(url: studioURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                                             timeoutInterval: 30))
                } else {
                    self.web.loadHTMLString(page("The studio didn't start",
                        "Nothing answered on port 5177. The launcher's log says why: " +
                        "<code>\(logPath)</code>. Quit and try again once that is sorted."),
                        baseURL: nil)
                }
            }
        }
    }

    /// Run the launcher's server-only mode — build if stale, serve, voice helper — then wait for an answer.
    /// Returns the build the server is serving, or nil when nothing answered.
    func startServers() -> String? {
        let launcher = launcherPath
        if FileManager.default.isReadableFile(atPath: launcher) {
            let sh = Process()
            sh.executableURL = URL(fileURLWithPath: "/bin/sh")
            sh.arguments = [launcher, "studio-servers"]
            try? sh.run()
            sh.waitUntilExit()
        }
        for _ in 0..<40 {
            if let build = studioBuild() { return build }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return nil
    }

    /// The build on 5177 when what answers is the studio and not a stranger on the port.
    func studioBuild() -> String? {
        var request = URLRequest(url: studioURL.appendingPathComponent("__rehearsal-studio"),
                                 cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 2)
        request.httpShouldHandleCookies = false
        var build: String?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               json["serving"] as? String == "rehearsal-tool-studio" {
                build = json["build"] as? String ?? "unstamped"
            }
            done.signal()
        }.resume()
        done.wait()
        return build
    }

    /*
     * The launcher rebuilds on every click, but a window left open keeps the
     * page it loaded. The page checks for a newer build whenever it gains
     * focus and offers a reload — a WebKit window does not reliably send that
     * focus event, so coming back to the app sends one. The page decides; a
     * reload forced from here once landed in the middle of preparing a song.
     */
    func applicationDidBecomeActive(_ notification: Notification) {
        guard loadedBuild != nil else { return }
        web.evaluateJavaScript("window.dispatchEvent(new Event('focus'))", completionHandler: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /*
     * A black window is WebKit's web content process gone — killed for memory,
     * or crashed — with nothing put in its place. The page is reloaded at
     * once, which is what a person does; a second death within a minute gets
     * a page saying so instead of a loop. Either way the launch log records
     * it, so a window that went black at 18:50 can be asked about later.
     */
    var contentDiedAt: Date?

    /** A line in the launch log, dated, beside the launcher's own. */
    func note(_ line: String) {
        let path = (logPath as NSString).expandingTildeInPath
        let stamp = ISO8601DateFormatter().string(from: Date())
        let text = "\(stamp) app: \(line)\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(text.data(using: .utf8) ?? Data())
            handle.closeFile()
        } else {
            try? text.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The chooser is cheap to load again, and losing it costs nothing.
        guard webView === web else {
            webView.reload()
            return
        }
        let now = Date()
        let again = contentDiedAt.map { now.timeIntervalSince($0) < 60 } ?? false
        contentDiedAt = now
        note("web content process terminated" + (again ? " again; not reloading" : "; reloading"))
        pageReady = false
        if again {
            web.loadHTMLString(page("The studio's page stopped twice in a minute",
                "WebKit shut its web content process down, usually for memory. Reload from the menu (⌘R) to try again; if it keeps happening, quit any song runs and rescan."), baseURL: nil)
            return
        }
        web.reload()
    }

    /*
     * Kept awake while the page says so. A prepare runs for many minutes and
     * touches nothing, which is idleness to macOS: the display sleeps, the
     * app is napped, the Mac sleeps, and a run that wrote a part every seven
     * seconds under somebody's eye takes hours on its own. The page holds a
     * screen wake lock for the display; this is for the rest — no App Nap
     * (user-initiated) and no idle sleep — and it ends when the page says,
     * or when the page goes away with the hold still up.
     */
    var awake: NSObjectProtocol?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "studio", let body = message.body as? [String: Any] else { return }
        // The page is up and listening: anything dropped before now can go to it.
        if body["ready"] as? Bool == true {
            pageReady = true
            open([])
        }
        // The chooser: put it up, take what it chose, or take its way past itself.
        if body["chooser"] as? Bool == true { showChooser() }
        if let chose = body["chose"] as? [String: Any] {
            closeChooser()
            window.makeKeyAndOrderFront(nil)
            tell("studio:chose", chose)
        }
        if body["tools"] as? Bool == true {
            closeChooser()
            window.makeKeyAndOrderFront(nil)
            tell("studio:tools", [:])
        }
        if let wanted = body["awake"] as? Bool {
            if wanted, awake == nil {
                let reason = (body["reason"] as? String) ?? "Working"
                awake = ProcessInfo.processInfo.beginActivity(
                    options: [.userInitiated, .idleSystemSleepDisabled], reason: reason)
            } else if !wanted, let held = awake {
                ProcessInfo.processInfo.endActivity(held)
                awake = nil
            }
        }
    }

    // MARK: - Folders and sets handed to the app: dropped on the window or the Dock, or opened from the Finder.

    /// Paths waiting for the page, which takes them up once it says it is listening.
    var pendingOpens: [String] = []
    var pageReady = false

    func open(_ paths: [String]) {
        pendingOpens += paths
        guard pageReady, !pendingOpens.isEmpty else { return }
        let batch = pendingOpens
        pendingOpens = []
        tell("studio:open", ["paths": batch])
    }

    /// An event on the page's window, its detail as JSON.
    func tell(_ event: String, _ detail: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)', {detail: \(json)}))",
                               completionHandler: nil)
    }

    // MARK: - The chooser, in a window of its own.

    /**
     * A small window in front of the studio for choosing what to open.
     *
     * The same page, told by its query which window it is, so there is one
     * chooser rather than two. It is deliberately smaller than the studio's
     * window — it holds two choices, not a set — and what it chooses is sent
     * to the window behind, which is the one that holds the set. Closed
     * without choosing, nothing has changed.
     */
    func showChooser() {
        if let already = chooserWindow {
            already.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        guard loadedBuild != nil, let url = URL(string: "http://localhost:5177/?chooser=1") else { return }

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "studio")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.underPageBackgroundColor = ink
        if #available(macOS 13.3, *) { view.isInspectable = true }

        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 540),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Open a set"
        panel.minSize = NSSize(width: 620, height: 460)
        panel.backgroundColor = ink
        panel.contentView = view
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        // Beside the studio's window rather than over its middle, and where it was last left.
        if !panel.setFrameUsingName("studio-chooser") { panel.center() }
        panel.setFrameAutosaveName("studio-chooser")

        chooserWindow = panel
        chooserWeb = view
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 30))
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func closeChooser() {
        chooserWindow?.close()
    }

    /// Let go of the chooser's web view when its window is closed, so the next one is fresh.
    func windowWillClose(_ note: Notification) {
        guard (note.object as? NSWindow) === chooserWindow else { return }
        chooserWeb?.stopLoading()
        chooserWeb = nil
        chooserWindow = nil
    }

    /// File ▸ Open: the chooser, over whatever the studio is showing.
    @objc func openChooser() {
        showChooser()
    }

    /// A folder or a set dropped on the Dock icon, or opened with the app from the Finder.
    func application(_ application: NSApplication, open urls: [URL]) {
        open(urls.map(\.path))
    }

    // MARK: - The menu bar, without which copy and paste do nothing in a web view.

    func buildMenu() {
        let bar = NSMenu()
        let holding = { (menu: NSMenu) -> NSMenuItem in
            let item = NSMenuItem()
            item.submenu = menu
            return item
        }

        let app = NSMenu()
        app.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        bar.addItem(holding(app))

        // The one thing the app itself opens: the set folder and the session
        // that fills it, chosen together in the page's own window.
        let file = NSMenu(title: "File")
        let openItem = file.addItem(withTitle: "Open…", action: #selector(openChooser), keyEquivalent: "n")
        openItem.target = self
        bar.addItem(holding(file))

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        bar.addItem(holding(edit))

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
        let full = view.addItem(withTitle: "Enter Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        bar.addItem(holding(view))

        let windows = NSMenu(title: "Window")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windows.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        bar.addItem(holding(windows))

        NSApp.mainMenu = bar
        NSApp.windowsMenu = windows
    }

    // MARK: - Navigation: the studio stays here, everything else goes to the browser.

    /// The studio's own origin, and the schemes a page uses to talk to itself.
    func isStudio(_ url: URL) -> Bool {
        if ["about", "blob", "data"].contains(url.scheme ?? "") { return true }
        return (url.host == "localhost" || url.host == "127.0.0.1") && url.port == 5177
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url else { return decisionHandler(.allow) }
        // Lyrics Studio, a link out, anything with target=_blank: the browser's job.
        if action.targetFrame == nil || !isStudio(url) {
            if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    /// window.open — the studio uses it for Lyrics Studio, which is its own app in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    // MARK: - Downloads: a setlist, a zip of slates, a bounce — into Downloads, never overwriting.

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var destination = folder.appendingPathComponent(suggestedFilename)
        let stem = destination.deletingPathExtension().lastPathComponent
        let ext = destination.pathExtension
        var n = 2
        while FileManager.default.fileExists(atPath: destination.path) {
            destination = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
            n += 1
        }
        completionHandler(destination)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.messageText = "The download didn't finish"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: - The three dialogs a page may put up.

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
}

let app = NSApplication.shared
let studio = Studio()
app.delegate = studio
app.setActivationPolicy(.regular)
app.run()
