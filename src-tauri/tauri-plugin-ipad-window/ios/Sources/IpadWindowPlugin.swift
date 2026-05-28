import SwiftRs
import Tauri
import UIKit
import WebKit
import ObjectiveC.runtime

// iPad single-file multi-window bridge — Swift side.
//
// Stage 1 goal (see IPAD-MULTI-WINDOW-PLANNING.md): prove that the JS
// command "Open in New Window" can open a *second iPad window* (a real
// UIWindowScene) seeded with the active file's id/type. The window
// currently renders a placeholder WKWebView confirming the bridge and the
// seed crossed over; the real single-file editor is wired in later stages.
//
// How a second scene gets created:
//   1. JS  -> invoke("plugin:ipad-window|open_single_file_window", …)
//   2. Rust -> run_mobile_plugin("openWindow", …)
//   3. `openWindow` builds an NSUserActivity carrying {fileId, fileType}
//      (the iPad analog of the macOS URL hash) and calls
//      `requestSceneSessionActivation`.
//   4. iOS asks the app delegate which scene configuration to use. We
//      *swizzle* `application(_:configurationForConnecting:options:)` onto
//      whatever class Tauri's generated app delegate is, and when the
//      connecting scene carries our activity type we hand back a
//      configuration whose delegate is `HushFileSceneDelegate`. Any other
//      scene (i.e. Tauri's own primary window) is passed through to the
//      original implementation untouched, so the main app is unaffected.
//
// The swizzle approach mirrors the runtime swizzling the pencil plugin
// already does for status-bar chrome, and keeps everything self-contained
// in the plugin — we never edit Tauri's generated AppDelegate. Info.plist
// still needs `UIApplicationSupportsMultipleScenes = true` (provided via
// `src-tauri/Info.ios.plist`); the configuration itself is built in code
// so no `UISceneConfigurations` array is required.
//
// ⚠️ Untested: this file has never been compiled or run on a device — it
// was authored in a Linux container with no Xcode. The first on-device
// check is whether enabling multiple scenes + the config-router swizzle
// leaves Tauri's primary window intact and opens a second scene.

let HUSH_FILE_ACTIVITY = "com.hushwriter.app.fileWindow"
let HUSH_FILE_CONFIG = "Hush File Window"

/// Process-wide shared state for the bridge. Holds a weak reference to the
/// primary (Tauri-managed) webview so later stages can relay satellite
/// requests through it, and stashes the original config-for-connecting IMP
/// when the app delegate already implemented that method.
final class HushWindowBridge {
    static let shared = HushWindowBridge()
    weak var primaryWebview: WKWebView?
    /// Non-nil when the host app delegate already implemented
    /// `configurationForConnecting` and we exchanged with it, so the
    /// pass-through path can chain to the original behaviour.
    var originalConfigIMP: IMP?
}

class IpadWindowPlugin: Plugin {
    @objc public override func load(webview: WKWebView) {
        NSLog("[IpadWindow] load() called")
        HushWindowBridge.shared.primaryWebview = webview
        SceneRouter.installSwizzle()
        NSLog("[IpadWindow] scene router installed")
    }

    // Tauri command: invoke("plugin:ipad-window|open_single_file_window", …)
    // maps (snake_case -> camelCase) to this method via run_mobile_plugin.
    @objc public func openWindow(_ invoke: Invoke) throws {
        struct Args: Decodable {
            let fileId: String
            let fileType: String
        }
        let args = try invoke.parseArgs(Args.self)
        NSLog("[IpadWindow] openWindow file=\(args.fileId) type=\(args.fileType)")

        DispatchQueue.main.async {
            let activity = NSUserActivity(activityType: HUSH_FILE_ACTIVITY)
            activity.userInfo = [
                "fileId": args.fileId,
                "fileType": args.fileType,
            ]
            let options = UIScene.ActivationRequestOptions()
            // No requesting scene — let iOS place the new window per the
            // user's current multitasking layout (full screen / split /
            // Stage Manager).
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
}

@_cdecl("init_plugin_ipad_window")
func initPlugin() -> Plugin {
    return IpadWindowPlugin()
}

// MARK: - Scene config routing via runtime swizzling

private enum SceneRouter {
    static var swizzled = false

    /// Install our `application(_:configurationForConnecting:options:)`
    /// onto the live app-delegate class. If the delegate already
    /// implements it we stash the original IMP and chain to it for any
    /// non-Hush scene; otherwise we simply add ours.
    static func installSwizzle() {
        guard !swizzled else { return }
        guard let delegate = UIApplication.shared.delegate else {
            NSLog("[IpadWindow] no app delegate yet; cannot install scene router")
            return
        }
        let cls: AnyClass = type(of: delegate)
        let sel = #selector(UIApplicationDelegate.application(_:configurationForConnecting:options:))

        // Our replacement IMP lives on the dedicated shim class below.
        let replSel = #selector(HushSceneRouterShim._hush_application(_:configurationForConnecting:options:))
        guard let replMethod = class_getInstanceMethod(HushSceneRouterShim.self, replSel) else {
            NSLog("[IpadWindow] could not locate replacement method")
            return
        }
        let replIMP = method_getImplementation(replMethod)
        let types = method_getTypeEncoding(replMethod)

        if let original = class_getInstanceMethod(cls, sel) {
            // Delegate implements it — keep the original around to chain.
            HushWindowBridge.shared.originalConfigIMP = method_getImplementation(original)
            method_setImplementation(original, replIMP)
            NSLog("[IpadWindow] exchanged existing configurationForConnecting")
        } else {
            let added = class_addMethod(cls, sel, replIMP, types)
            NSLog("[IpadWindow] added configurationForConnecting (added=\(added))")
        }
        swizzled = true
    }
}

/// Carrier for the replacement IMP. Declared on its own NSObject subclass
/// so `class_getInstanceMethod` can fetch the implementation by selector;
/// the IMP only ever touches process-global state, so it behaves
/// correctly when invoked with the app delegate as `self`.
private class HushSceneRouterShim: NSObject {
    @objc func _hush_application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let isHushWindow = options.userActivities.contains {
            $0.activityType == HUSH_FILE_ACTIVITY
        }
        if isHushWindow {
            let config = UISceneConfiguration(
                name: HUSH_FILE_CONFIG,
                sessionRole: connectingSceneSession.role
            )
            config.delegateClass = HushFileSceneDelegate.self
            return config
        }

        // Not ours — preserve the host app's behaviour. Chain to the
        // original IMP when we exchanged with one; otherwise return the
        // platform default configuration for this role.
        if let orig = HushWindowBridge.shared.originalConfigIMP {
            typealias Fn = @convention(c) (
                AnyObject, Selector, UIApplication, UISceneSession, UIScene.ConnectionOptions
            ) -> Unmanaged<UISceneConfiguration>
            let fn = unsafeBitCast(orig, to: Fn.self)
            let sel = #selector(UIApplicationDelegate.application(_:configurationForConnecting:options:))
            return fn(self, sel, application, connectingSceneSession, options).takeUnretainedValue()
        }
        return UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    }
}

// MARK: - Stage 1 placeholder scene

/// The scene delegate for a Hush file window. Stage 1 renders a
/// placeholder WKWebView confirming the bridge and the seeded file
/// crossed over. Later stages replace the placeholder with the satellite
/// editor (loads the bundled dist in single-file mode, proxies its IPC
/// through the primary webview).
///
/// `@objc(HushFileSceneDelegate)` exposes a stable Objective-C runtime
/// name so `config.delegateClass = HushFileSceneDelegate.self` resolves
/// from the statically-linked plugin module without an app-module prefix.
@objc(HushFileSceneDelegate)
class HushFileSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let seed = connectionOptions.userActivities.first {
            $0.activityType == HUSH_FILE_ACTIVITY
        }?.userInfo
        let fileId = (seed?["fileId"] as? String) ?? "(none)"
        let fileType = (seed?["fileType"] as? String) ?? "(none)"
        NSLog("[IpadWindow] scene connecting file=\(fileId) type=\(fileType)")

        let win = UIWindow(windowScene: windowScene)
        let vc = UIViewController()

        // Bright background + a *native* label so we can tell — without
        // relying on the webview rendering — whether this delegate even
        // ran. If the new window shows this colour/label, routing works
        // and any blankness is a webview issue; if the window is still
        // plain white, the scene was never routed to us (swizzle issue).
        vc.view.backgroundColor = .systemYellow

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.numberOfLines = 0
        label.textColor = .black
        label.font = .systemFont(ofSize: 18, weight: .semibold)
        label.text = "Hush — second window\nStage 1 delegate ran ✓\nfileId: \(fileId)\ntype: \(fileType)"
        vc.view.addSubview(label)

        let webview = WKWebView(frame: .zero)
        webview.translatesAutoresizingMaskIntoConstraints = false
        webview.isOpaque = false
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
        NSLog("[IpadWindow] scene content installed")

        win.rootViewController = vc
        self.window = win
        win.makeKeyAndVisible()
    }
}
