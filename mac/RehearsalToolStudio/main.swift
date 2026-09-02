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

final class Studio: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var titleWatch: NSKeyValueObservation?
    /// The build the page was loaded from, to notice when the server has moved on.
    var loadedBuild: String?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        // "Inspect Element" in the context menu: the studio is a tool, and tools get opened up.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        web = WKWebView(frame: .zero, configuration: config)
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
            "Building it first if the source has moved on, which takes a moment."), baseURL: nil)
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
                        "<code>\(repo)/.studio-build.log</code>. Quit and try again once that is sorted."),
                        baseURL: nil)
                }
            }
        }
    }

    /// Run the launcher's server-only mode — build if stale, serve, voice helper — then wait for an answer.
    /// Returns the build the server is serving, or nil when nothing answered.
    func startServers() -> String? {
        let launcher = "\(repo)/scripts/app-launch.sh"
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
     * page it loaded. Coming back to the app is the moment to check: when the
     * server now holds a newer build than the page came from, the page is
     * reloaded rather than left to offer a banner it may never show. The
     * studio writes edits within a couple of seconds, so nothing is lost.
     */
    func applicationDidBecomeActive(_ notification: Notification) {
        guard loadedBuild != nil else { return }
        DispatchQueue.global(qos: .utility).async {
            guard let build = self.studioBuild() else { return }
            DispatchQueue.main.async {
                if build != self.loadedBuild {
                    self.loadedBuild = build
                    self.web.reloadFromOrigin()
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

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
