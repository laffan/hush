import UIKit
import WebKit
import ObjectiveC.runtime

// Status bar + home indicator control, driven by the "Hide status bar in
// full screen" setting (`hideSystemChrome`).
//
// Hiding the bar: iOS has no app-wide runtime toggle —
// `UIApplication.statusBarHidden` does nothing at all for apps linked
// against the iOS 27 SDK — so the only lever is the view controller's
// `prefersStatusBarHidden` plus `setNeedsStatusBarAppearanceUpdate()`,
// which also needs `UIViewControllerBasedStatusBarAppearance` left at YES
// (pinned in Info.ios.plist). Every window's root is tao's
// `TaoUIViewController`, which *overrides* that getter to return an ivar
// of its own, so it is set through tao's setter on each root (see
// `refresh`); the swizzle on the `UIViewController` base class only
// reaches everything else, i.e. view controllers presented over the
// webview. A windowed scene (Split View, Stage Manager, iPadOS 26+
// windowing) keeps its status bar: that is where the system puts the
// window controls.
//
// The window controls: in a full-screen scene they live in the status
// bar, so hiding the bar hides them with it, and the system only brings
// them back on its own menu-bar reveal — which reads as them turning up
// at random. There is no API to show the controls themselves, so while
// the pointer sits in the top-left corner the bar is shown again
// (`CornerHover`), and the controls come with it.
//
// The webview hears about it too: `html.status-bar-hidden` is on while a
// window's bar is hidden (a corner peek doesn't count), which is what
// drops the iOS 27 status-bar blur band out of `--top-chrome-inset`.
//
// The window is left freely resizable in every chrome state (only a
// 320×320 floor) so iPad multitasking keeps working — an earlier build
// pinned the scene size restrictions to suppress the Stage-Manager resize
// handle, but that locked the window and blocked multitasking resize
// entirely.

enum ChromeControl {
    /// The setting, as last pushed from JS.
    static var hidden = false
    static var installed = false
    /// One `effectiveGeometry` observation per connected scene, so a
    /// window dragged between full screen and windowed re-evaluates.
    static var geometryObservers: [ObjectIdentifier: NSKeyValueObservation] = [:]
    /// What each window's page was last told about `status-bar-hidden`.
    static var reported: [ObjectIdentifier: Bool] = [:]

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
            guard let scene = note.object as? UIWindowScene else { return }
            ChromeControl.geometryObservers.removeValue(forKey: ObjectIdentifier(scene))
            for window in scene.windows {
                ChromeControl.reported.removeValue(forKey: ObjectIdentifier(window))
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

    /// The bar's resting state for `window`, ignoring a corner peek.
    static func hidesStatusBar(in window: UIWindow) -> Bool {
        return hidden && fillsScreen(window)
    }

    static func statusBarHidden(for window: UIWindow?) -> Bool {
        guard let window = window, hidesStatusBar(in: window) else { return false }
        return !(CornerHover.existing(on: window)?.peeking ?? false)
    }

    /// A settings push (every window pushes once as it boots, so this
    /// also re-tells a reloaded page its class). Main thread.
    static func apply() {
        // Keep every window freely resizable — see the header.
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.sizeRestrictions?.minimumSize = CGSize(width: 320, height: 320)
            scene.sizeRestrictions?.maximumSize = CGSize(width: CGFloat.greatestFiniteMagnitude,
                                                          height: CGFloat.greatestFiniteMagnitude)
        }
        refresh(force: true)
    }

    /// Re-evaluate every window of every connected scene. Main thread;
    /// runs on every geometry tick of a live resize, so tao's flags and
    /// the page's class are written only when they flip (the `setNeeds…`
    /// calls are coalesced by UIKit).
    static func refresh(force: Bool = false, animated: Bool = false) {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            observeGeometry(of: scene)
            for window in scene.windows {
                // Only tao's windows — the keyboard's and other system
                // windows in the scene are none of this code's business.
                guard let root = window.rootViewController,
                      root.responds(to: NSSelectorFromString("setPrefersStatusBarHidden:")) else { continue }
                let resting = hidesStatusBar(in: window)
                let hover = CornerHover.on(window)
                // A peek only means something over a hidden bar; one left
                // over from before the window went windowed must not
                // survive its return to full screen.
                if !resting { hover.endPeek() }

                let update = {
                    ChromeControl.setTaoFlag(root, "setPrefersStatusBarHidden:",
                               ChromeControl.statusBarHidden(for: window),
                               current: #selector(getter: UIViewController.prefersStatusBarHidden))
                    // Anything presented over the root answers through
                    // the swizzle; ask it again too.
                    root.setNeedsStatusBarAppearanceUpdate()
                }
                if animated { UIView.animate(withDuration: 0.2, animations: update) } else { update() }
                setTaoFlag(root, "setPrefersHomeIndicatorAutoHidden:", hidden,
                           current: #selector(getter: UIViewController.prefersHomeIndicatorAutoHidden))
                root.setNeedsUpdateOfHomeIndicatorAutoHidden()

                let key = ObjectIdentifier(window)
                if force || reported[key] != resting {
                    reported[key] = resting
                    webView(in: window)?.evaluateJavaScript(
                        "document.documentElement.classList.toggle('status-bar-hidden', \(resting))",
                        completionHandler: nil)
                }
            }
        }
    }

    /// Apple's recommended signal for a scene's size changing (iOS 16+).
    /// Fires continuously through an interactive resize. On iOS 15 a
    /// resize is picked up at the next activation or settings push.
    static func observeGeometry(of scene: UIWindowScene) {
        guard #available(iOS 16.0, *) else { return }
        let key = ObjectIdentifier(scene)
        guard geometryObservers[key] == nil else { return }
        geometryObservers[key] = scene.observe(\.effectiveGeometry, options: [.new]) { _, _ in
            DispatchQueue.main.async { ChromeControl.refresh() }
        }
    }

    private static func webView(in view: UIView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        for sub in view.subviews {
            if let web = webView(in: sub) { return web }
        }
        return nil
    }

    /// tao's root view controller keeps each preference in an ivar
    /// behind a setter that also calls the matching `setNeeds…Update`.
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

// MARK: - Corner hover

/// Shows a full-screen window's hidden status bar while the pointer is in
/// its top-left corner. One per window, attached to the `UIWindow` itself
/// so it sees the pointer over every subview.
///
/// Pointer only: `allowedTouchTypes` is the indirect pointer (mouse /
/// trackpad), so neither Apple Pencil hover nor a finger ever peeks. It
/// recognizes alongside everything else, WebKit's own hover handling
/// included — the page still gets every `pointermove` — and a hover
/// recognizer never sees a touch, so drawing is untouched.
final class CornerHover: UIHoverGestureRecognizer, UIGestureRecognizerDelegate {
    /// Entering this box from the top-left corner shows the bar.
    static let enter = CGSize(width: 120, height: 40)
    /// Once shown, it stays while the pointer is anywhere in this larger
    /// box — the controls, once expanded, reach past the entry box.
    static let keep = CGSize(width: 280, height: 80)
    static let hideDelay: TimeInterval = 0.6

    private(set) var peeking = false
    private var pendingHide: DispatchWorkItem?

    static func existing(on window: UIWindow) -> CornerHover? {
        return window.gestureRecognizers?.first(where: { $0 is CornerHover }) as? CornerHover
    }

    /// Installs on first use. Only `ChromeControl.refresh` calls this,
    /// and only for tao's windows.
    static func on(_ window: UIWindow) -> CornerHover {
        if let hover = existing(on: window) { return hover }
        let hover = CornerHover(target: nil, action: nil)
        hover.addTarget(hover, action: #selector(moved))
        hover.delegate = hover
        hover.cancelsTouchesInView = false
        hover.delaysTouchesBegan = false
        hover.delaysTouchesEnded = false
        hover.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        window.addGestureRecognizer(hover)
        return hover
    }

    @objc private func moved() {
        guard let window = view as? UIWindow, ChromeControl.hidesStatusBar(in: window) else { return }
        switch state {
        case .began, .changed:
            let p = location(in: window)
            if p.x <= Self.enter.width && p.y <= Self.enter.height {
                cancelHide()
                if !peeking { peeking = true; ChromeControl.refresh(animated: true) }
            } else if peeking && !(p.x <= Self.keep.width && p.y <= Self.keep.height) {
                scheduleHide()
            } else {
                cancelHide()
            }
        default:
            // The pointer left the window's content — most likely onto
            // the bar just revealed, to reach a control. Keep it; the
            // next hover back inside the window decides.
            break
        }
    }

    func endPeek() {
        cancelHide()
        peeking = false
    }

    private func scheduleHide() {
        guard pendingHide == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.pendingHide = nil
            self.peeking = false
            ChromeControl.refresh(animated: true)
        }
        pendingHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.hideDelay, execute: work)
    }

    private func cancelHide() {
        pendingHide?.cancel()
        pendingHide = nil
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        return true
    }
}

// MARK: - Swizzled getters

extension UIViewController {
    @objc fileprivate func _hush_prefersStatusBarHidden() -> Bool {
        if ChromeControl.statusBarHidden(for: viewIfLoaded?.window) { return true }
        // Fall back to the original (now under our renamed selector).
        return self._hush_prefersStatusBarHidden()
    }

    @objc fileprivate func _hush_prefersHomeIndicatorAutoHidden() -> Bool {
        if ChromeControl.hidden { return true }
        return self._hush_prefersHomeIndicatorAutoHidden()
    }
}
