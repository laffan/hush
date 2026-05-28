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
// application(_:configurationForConnecting:). An earlier attempt to swizzle
// that method could not work: the swizzle runs in the plugin's load(),
// which is well after launch, so the hook is never invoked. We also can't
// adopt scenes via Info.plist without UIKit ignoring wry's legacy primary
// window (which would break the main app).
//
// Instead we observe `UIScene.willConnectNotification` on NotificationCenter.
// When `open_single_file_window` fires requestSceneSessionActivation, the
// resulting scene connection lands in our observer and we attach a UIWindow
// + content ourselves. The primary window is a legacy UIWindow (not a
// scene) so it never trips the observer; we additionally gate on an
// `expectingNewScene` flag set by the command, so we only ever claim a
// scene we explicitly requested.
//
// Stage 1 fills the new window with a placeholder (yellow background +
// native label + a WKWebView) to confirm the bridge end to end. Diagnostic
// breadcrumbs are emitted BOTH via NSLog and via `trigger("diag", …)`, so
// they surface in the MAIN window's JS console (Safari Web Inspector) when
// no terminal / Console.app feedback is available.

let HUSH_FILE_ACTIVITY = "com.hushwriter.app.fileWindow"

final class HushWindowBridge {
    static let shared = HushWindowBridge()
    weak var primaryWebview: WKWebView?
    var pendingSeed: (fileId: String, fileType: String)?
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
        }
        let args = try invoke.parseArgs(Args.self)
        diag("openWindow file=\(args.fileId) type=\(args.fileType)")

        HushWindowBridge.shared.pendingSeed = (args.fileId, args.fileType)
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

        // Debugging stance: attach visible content to EVERY application-role
        // scene (requested or restored) rather than destroying unrequested
        // ones — so nothing silently closes and we can see what we get. The
        // primary window is a legacy UIWindow, not a scene, so it never
        // reaches here. (Zombie-session cleanup comes back once the happy
        // path is confirmed.)
        HushWindowBridge.shared.expectingNewScene = false
        let seed = HushWindowBridge.shared.pendingSeed
        let fileId = seed?.fileId ?? "(none)"
        let fileType = seed?.fileType ?? "(none)"
        let origin = expecting ? "requested" : "restored/unrequested"

        let win = UIWindow(windowScene: scene)
        win.rootViewController = Self.makeContentVC(fileId: fileId, fileType: fileType, origin: origin)
        win.makeKeyAndVisible()
        HushWindowBridge.shared.sceneWindows.append(win)
        diag("scene window attached (\(origin)) file=\(fileId) type=\(fileType)")
    }

    private func diag(_ message: String) {
        NSLog("[IpadWindow] \(message)")
        self.trigger("diag", data: ["msg": message])
    }

    /// Stage 1 placeholder content. A native yellow background + label
    /// (paint regardless of the webview) plus a constrained WKWebView, so
    /// the result is unambiguous: a coloured window with the label means
    /// the scene was claimed and content attached. Later stages replace
    /// this with the satellite editor.
    static func makeContentVC(fileId: String, fileType: String, origin: String) -> UIViewController {
        let vc = UIViewController()
        vc.view.backgroundColor = .systemYellow

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.numberOfLines = 0
        label.textColor = .black
        label.font = .systemFont(ofSize: 18, weight: .semibold)
        label.text = "Hush — second window\nStage 1 scene attached ✓\norigin: \(origin)\nfileId: \(fileId)\ntype: \(fileType)"
        vc.view.addSubview(label)

        let webview = WKWebView(frame: .zero)
        webview.translatesAutoresizingMaskIntoConstraints = false
        vc.view.addSubview(webview)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor, constant: 24),
            label.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor, constant: -24),
            webview.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 16),
            webview.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            webview.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
            webview.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
        ])

        let html = """
        <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        </head><body style="font-family:-apple-system;padding:1.5rem;color:#222;background:#fff">
        <h2>WKWebView rendered ✓</h2>
        <p>fileId: <code>\(fileId)</code><br>fileType: <code>\(fileType)</code></p>
        </body></html>
        """
        webview.loadHTMLString(html, baseURL: nil)
        return vc
    }
}

@_cdecl("init_plugin_ipad_window")
func initPlugin() -> Plugin {
    return IpadWindowPlugin()
}
