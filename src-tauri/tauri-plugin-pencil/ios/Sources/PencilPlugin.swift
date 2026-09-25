import SwiftRs
import Tauri
import UIKit
import WebKit
import ObjectiveC.runtime

// Pencil plugin — two responsibilities:
//
//  1. (iPad) Forward the Apple Pencil 2nd-gen / Pencil Pro hardware double-tap
//     into a Tauri plugin event. We attach `UIPencilInteraction`
//     directly to the WKWebView; this interaction fires on the squeeze
//     sensor and never touches the WKWebView's scrollView gesture
//     chain, so it does not interfere with how the page receives
//     touches. (An earlier iteration also installed a passive
//     `UIGestureRecognizer` on the scrollView for finger-vs-pencil
//     detection — that one *did* break iPad drawing on this WKWebView
//     build, so it has been removed. Touch-type gating now lives
//     entirely in JS via `PointerEvent.pointerType`.)
//
//  2. Hide / show the top status bar (time, battery, wifi) while a
//     window fills the screen. iOS has no app-wide runtime toggle —
//     `UIApplication.statusBarHidden` does nothing at all for apps
//     linked against the iOS 27 SDK — so the only lever is the view
//     controller's `prefersStatusBarHidden` plus
//     `setNeedsStatusBarAppearanceUpdate()`, which also needs
//     `UIViewControllerBasedStatusBarAppearance` left at YES (pinned in
//     Info.ios.plist). Every window's root is tao's
//     `TaoUIViewController`, which *overrides* that getter to return an
//     ivar of its own, so it is set through tao's setter on each root
//     (see `ChromeControl.refresh`); the swizzle on the
//     `UIViewController` base class only reaches everything else, i.e.
//     view controllers presented over the webview. A windowed scene
//     (Split View, Stage Manager, iPadOS 26+ windowing) keeps its
//     status bar: that is where the system puts the window controls.
//     The window is left freely resizable in every chrome state (only
//     a 320×320 floor) so iPad multitasking keeps working — an earlier
//     build pinned the scene size restrictions to suppress the
//     Stage-Manager resize handle, but that locked the window and
//     blocked multitasking resize entirely.

private var chromeHidden = false

class PencilPlugin: Plugin {
    private var pencilInteraction: UIPencilInteraction?

    @objc public override func load(webview: WKWebView) {
        NSLog("[PencilPlugin] load() called")

        let interaction = UIPencilInteraction()
        interaction.delegate = self
        webview.addInteraction(interaction)
        self.pencilInteraction = interaction

        ChromeControl.install()

        NSLog("[PencilPlugin] handlers installed")

        // Emit a "loaded" event so JS can confirm the bridge is alive.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            NSLog("[PencilPlugin] firing loaded event")
            self?.trigger("loaded", data: [:])
        }
    }

    // Tauri command — JS calls
    //   invoke("plugin:pencil|set_chrome_hidden", { hidden: true })
    // which Tauri's runtime maps (snake_case → camelCase) to this
    // method. The Rust side proxies via `run_mobile_plugin`.
    @objc public func setChromeHidden(_ invoke: Invoke) throws {
        struct Args: Decodable { let hidden: Bool }
        let args = try invoke.parseArgs(Args.self)
        DispatchQueue.main.async {
            chromeHidden = args.hidden
            ChromeControl.apply()
        }
        invoke.resolve()
    }
}

extension PencilPlugin: UIPencilInteractionDelegate {
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        NSLog("[PencilPlugin] pencil double-tap")
        self.trigger("double-tap", data: [:])
    }
}

@_cdecl("init_plugin_pencil")
func initPlugin() -> Plugin {
    return PencilPlugin()
}

// MARK: - Chrome control

private enum ChromeControl {
    static var installed = false
    /// One `effectiveGeometry` observation per connected scene, so a
    /// window dragged between full screen and windowed re-evaluates.
    static var geometryObservers: [ObjectIdentifier: NSKeyValueObservation] = [:]

    static func install() {
        guard !installed else { return }
        installed = true
        swap(#selector(getter: UIViewController.prefersStatusBarHidden),
             with: #selector(UIViewController._hush_prefersStatusBarHidden))
        swap(#selector(getter: UIViewController.prefersHomeIndicatorAutoHidden),
             with: #selector(UIViewController._hush_prefersHomeIndicatorAutoHidden))

        // A new window (a scene the user opened, or tao's window for it
        // appearing) and a return to the foreground both get a pass.
        // Each window's own boot also pushes the setting, so these are
        // the backstop, not the primary path.
        let center = NotificationCenter.default
        for name in [UIScene.didActivateNotification, UIWindow.didBecomeVisibleNotification] {
            center.addObserver(forName: name, object: nil, queue: .main) { _ in ChromeControl.refresh() }
        }
        center.addObserver(forName: UIScene.didDisconnectNotification, object: nil, queue: .main) { note in
            if let scene = note.object as? UIScene {
                ChromeControl.geometryObservers.removeValue(forKey: ObjectIdentifier(scene))
            }
        }
    }

    /// Whether `window` covers its whole screen — what "full screen"
    /// means on iPad. `UIWindowScene.isFullScreen` would say so directly
    /// but is documented as supported only under Mac Catalyst. An
    /// iPhone window always fills its screen.
    static func fillsScreen(_ window: UIWindow) -> Bool {
        guard let screen = window.windowScene?.screen.bounds.size else { return true }
        let size = window.bounds.size
        return abs(size.width - screen.width) < 1 && abs(size.height - screen.height) < 1
    }

    static func statusBarHidden(for window: UIWindow?) -> Bool {
        guard chromeHidden, let window = window else { return false }
        return fillsScreen(window)
    }

    /// A settings push. Main thread.
    static func apply() {
        // Keep every window freely resizable in every chrome state so
        // iPad Split View / Slide Over still work — only enforce a sane
        // 320×320 floor. Hiding chrome used to pin
        // minimumSize == maximumSize == the current scene size to
        // suppress the Stage-Manager resize handle, but that locked the
        // window and blocked multitasking resize entirely.
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.sizeRestrictions?.minimumSize = CGSize(width: 320, height: 320)
            scene.sizeRestrictions?.maximumSize = CGSize(width: CGFloat.greatestFiniteMagnitude,
                                                          height: CGFloat.greatestFiniteMagnitude)
        }
        refresh()
    }

    /// Re-evaluate every window of every connected scene. Main thread;
    /// runs on every geometry tick of a live resize, so tao's flags are
    /// written only when they flip (the `setNeeds…` calls are coalesced
    /// by UIKit).
    static func refresh() {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            observeGeometry(of: scene)
            for window in scene.windows {
                guard let root = window.rootViewController else { continue }
                setTaoFlag(root, "setPrefersStatusBarHidden:",
                           statusBarHidden(for: window),
                           current: #selector(getter: UIViewController.prefersStatusBarHidden))
                setTaoFlag(root, "setPrefersHomeIndicatorAutoHidden:", chromeHidden,
                           current: #selector(getter: UIViewController.prefersHomeIndicatorAutoHidden))
                // Anything presented over the root answers through the
                // swizzle; ask it again too.
                root.setNeedsStatusBarAppearanceUpdate()
                root.setNeedsUpdateOfHomeIndicatorAutoHidden()
            }
        }
    }

    /// Apple's recommended signal for a scene's size changing (iOS 16+).
    /// Fires continuously through an interactive resize; `setTaoFlag`
    /// only writes when the answer actually flips. On iOS 15 a resize is
    /// picked up at the next activation or settings push instead.
    static func observeGeometry(of scene: UIWindowScene) {
        guard #available(iOS 16.0, *) else { return }
        let key = ObjectIdentifier(scene)
        guard geometryObservers[key] == nil else { return }
        geometryObservers[key] = scene.observe(\.effectiveGeometry, options: [.new]) { _, _ in
            DispatchQueue.main.async { ChromeControl.refresh() }
        }
    }

    /// tao's root view controller keeps each preference in an ivar
    /// behind a setter that also calls the matching `setNeeds…Update`.
    /// A root that isn't tao's has no such setter; it answers through
    /// the swizzle instead.
    private static func setTaoFlag(_ vc: UIViewController, _ setter: String, _ value: Bool, current getter: Selector) {
        let sel = NSSelectorFromString(setter)
        guard vc.responds(to: sel) else { return }
        typealias Getter = @convention(c) (AnyObject, Selector) -> Bool
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        let now = unsafeBitCast(vc.method(for: getter), to: Getter.self)(vc, getter)
        guard now != value else { return }
        unsafeBitCast(vc.method(for: sel), to: Setter.self)(vc, sel, value)
    }

    private static func swap(_ original: Selector, with replacement: Selector) {
        guard let cls = UIViewController.self as AnyClass? else { return }
        guard let originalMethod = class_getInstanceMethod(cls, original),
              let replacementMethod = class_getInstanceMethod(cls, replacement) else {
            return
        }
        let added = class_addMethod(cls, original,
                                    method_getImplementation(replacementMethod),
                                    method_getTypeEncoding(replacementMethod))
        if added {
            class_replaceMethod(cls, replacement,
                                method_getImplementation(originalMethod),
                                method_getTypeEncoding(originalMethod))
        } else {
            method_exchangeImplementations(originalMethod, replacementMethod)
        }
    }
}

extension UIViewController {
    @objc fileprivate func _hush_prefersStatusBarHidden() -> Bool {
        if ChromeControl.statusBarHidden(for: viewIfLoaded?.window) { return true }
        // Fall back to the original (now under our renamed selector).
        return self._hush_prefersStatusBarHidden()
    }

    @objc fileprivate func _hush_prefersHomeIndicatorAutoHidden() -> Bool {
        if chromeHidden { return true }
        return self._hush_prefersHomeIndicatorAutoHidden()
    }
}
