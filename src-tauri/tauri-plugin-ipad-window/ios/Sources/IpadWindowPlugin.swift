import SwiftRs
import Tauri
import UIKit
import WebKit

// iPad single-file multi-window bridge — Swift side.
//
// Tauri/wry builds the iOS app delegate and the primary window in Rust
// using the LEGACY (non-scene) UIWindow lifecycle — there is no Swift
// app/scene delegate in the generated project, and the only scene manifest
// in Info.plist is the one Hush adds (UIApplicationSupportsMultipleScenes).
//
// Because the app isn't scene-adopted at launch, UIKit decides the
// lifecycle inside UIApplicationMain and never calls
// application(_:configurationForConnecting:) — so swizzling that method
// (in the plugin's load(), well after launch) can't work, and adopting
// scenes via Info.plist would make UIKit ignore wry's legacy primary
// window. Instead we observe `UIScene.willConnectNotification`: when
// `open_single_file_window` fires requestSceneSessionActivation, the scene
// connection lands in our observer and we attach a UIWindow + content
// ourselves. The primary window is a legacy UIWindow (not a scene) so it
// never trips the observer; we also gate on an `expectingNewScene` flag so
// we only ever claim a scene we explicitly requested, and destroy
// unrequested (iOS-restored) scenes so they can't be reused.
//
// The second window must work for ALL file types (doc, notebook, stack),
// which are rendered by the Hush web app's own renderers — so the new
// window will ultimately load the real `dist` bundle and proxy its
// `invoke()` through the primary window (the "satellite relay"). This
// placeholder build just confirms the scene/seed path for any file type;
// it shows the seeded title + type until the satellite webview is wired.
//
// Diagnostics are emitted via NSLog and `trigger("diag", …)` (dispatched to
// the main thread, since trigger drives evaluateJavaScript) so they surface
// in the MAIN window's JS console (Safari Web Inspector) without a terminal.

let HUSH_FILE_ACTIVITY = "com.hushwriter.app.fileWindow"

struct HushSeed {
    let fileId: String
    let fileType: String
    let title: String
}

final class HushWindowBridge {
    static let shared = HushWindowBridge()
    weak var primaryWebview: WKWebView?
    var pendingSeed: HushSeed?
    var expectingNewScene = false
    // Strong refs so the scene windows aren't deallocated — in this
    // observer-based approach no scene delegate owns them.
    var sceneWindows: [UIWindow] = []
}

class IpadWindowPlugin: Plugin {
    @objc public override func load(webview: WKWebView) {
        NSLog("[IpadWindow] load() called")
        HushWindowBridge.shared.primaryWebview = webview
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sceneWillConnect(_:)),
            name: UIScene.willConnectNotification,
            object: nil
        )
        diag("observer installed for UIScene.willConnectNotification")
    }

    // Tauri command: invoke("plugin:ipad-window|open_single_file_window", …)
    @objc public func openWindow(_ invoke: Invoke) throws {
        struct Args: Decodable {
            let fileId: String
            let fileType: String
            let title: String
        }
        let args = try invoke.parseArgs(Args.self)
        diag("openWindow file=\(args.fileId) type=\(args.fileType) title=\(args.title)")

        HushWindowBridge.shared.pendingSeed = HushSeed(
            fileId: args.fileId, fileType: args.fileType, title: args.title
        )
        HushWindowBridge.shared.expectingNewScene = true

        DispatchQueue.main.async {
            let activity = NSUserActivity(activityType: HUSH_FILE_ACTIVITY)
            activity.userInfo = ["fileId": args.fileId, "fileType": args.fileType]
            let options = UIScene.ActivationRequestOptions()
            UIApplication.shared.requestSceneSessionActivation(
                nil,
                userActivity: activity,
                options: options,
                errorHandler: { error in
                    NSLog("[IpadWindow] scene activation failed: \(error)")
                }
            )
        }
        invoke.resolve()
    }

    @objc func sceneWillConnect(_ note: Notification) {
        guard let scene = note.object as? UIWindowScene else {
            diag("willConnect: not a UIWindowScene")
            return
        }
        let expecting = HushWindowBridge.shared.expectingNewScene
        diag("willConnect role=\(scene.session.role.rawValue) expecting=\(expecting)")
        guard scene.session.role == .windowApplication else { return }
        guard expecting else {
            // Unrequested = iOS restoring a leftover session from a prior
            // run. Destroy it so it can't be reused by a later activation
            // (which would foreground a stale, seedless window). Primary is
            // a legacy window scene that connected before this observer
            // existed, so it never reaches here.
            diag("willConnect: unrequested scene; destroying stale session")
            DispatchQueue.main.async {
                UIApplication.shared.requestSceneSessionDestruction(
                    scene.session, options: nil, errorHandler: nil
                )
            }
            return
        }
        HushWindowBridge.shared.expectingNewScene = false

        let seed = HushWindowBridge.shared.pendingSeed
        let win = UIWindow(windowScene: scene)
        win.rootViewController = Self.makeContentVC(seed: seed)
        win.makeKeyAndVisible()
        HushWindowBridge.shared.sceneWindows.append(win)
        diag("scene window attached (requested) file=\(seed?.fileId ?? "(none)")")
    }

    private func diag(_ message: String) {
        NSLog("[IpadWindow] \(message)")
        // trigger() drives evaluateJavaScript, which must run on the main
        // thread. Command handlers (openWindow) run off-main, so dispatch
        // here — otherwise those breadcrumbs are silently dropped and only
        // main-thread callers (the willConnect observer) reach the JS
        // console.
        DispatchQueue.main.async { [weak self] in
            self?.trigger("diag", data: ["msg": message])
        }
    }

    /// Placeholder content confirming the scene/seed path for ANY file
    /// type. Shows the seeded title + type; the next stage replaces this
    /// with the satellite webview (the real dist + a proxied invoke), which
    /// renders doc / notebook / stack with the app's own renderers.
    static func makeContentVC(seed: HushSeed?) -> UIViewController {
        let vc = UIViewController()
        vc.view.backgroundColor = .systemBackground

        let webview = WKWebView(frame: .zero)
        webview.translatesAutoresizingMaskIntoConstraints = false
        vc.view.addSubview(webview)
        NSLayoutConstraint.activate([
            webview.topAnchor.constraint(equalTo: vc.view.topAnchor),
            webview.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            webview.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
            webview.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
        ])

        let title = seed?.title ?? "(no file)"
        let fileType = seed?.fileType ?? "(none)"
        let fileId = seed?.fileId ?? "(none)"

        let html = """
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family:-apple-system; margin:0; padding:2rem 2.5rem;
                 color:#222; background:#fff; -webkit-text-size-adjust:100%; }
          h1 { font-size:1.4rem; margin:0 0 .5rem; }
          .meta { color:#888; font-size:.9rem; }
          .note { margin-top:1.5rem; color:#555; }
        </style></head>
        <body><h1>\(esc(title))</h1>
        <div class="meta">type: \(esc(fileType)) · id: \(esc(fileId))</div>
        <p class="note">Scene + seed path OK ✓ — the live \(esc(fileType)) editor lands once the satellite relay is wired.</p>
        </body></html>
        """
        webview.loadHTMLString(html, baseURL: nil)
        return vc
    }

    /// Minimal HTML escaping for the read-only render. `&` first so we
    /// don't double-escape the entities we introduce.
    static func esc(_ s: String) -> String {
        return s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

@_cdecl("init_plugin_ipad_window")
func initPlugin() -> Plugin {
    return IpadWindowPlugin()
}
