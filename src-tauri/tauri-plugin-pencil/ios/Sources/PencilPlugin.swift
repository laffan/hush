import SwiftRs
import Tauri
import UIKit
import WebKit
import ObjectiveC.runtime

// Pencil plugin — two responsibilities, both iPad-only:
//
//  1. Forward the Apple Pencil 2nd-gen / Pencil Pro hardware double-tap
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
//  2. Hide / show the iPad top status bar (time, battery, wifi).
//     iPadOS doesn't expose a runtime toggle, so we swizzle
//     `prefersStatusBarHidden` and `prefersHomeIndicatorAutoHidden`
//     onto whichever UIViewController is hosting the webview, then
//     call `setNeedsStatusBarAppearanceUpdate()` so the change paints
//     immediately. The window is left freely resizable in every chrome
//     state (only a 320×320 floor) so iPad Split View / Slide Over keep
//     working — an earlier build pinned the scene size restrictions to
//     suppress the Stage-Manager resize handle, but that locked the
//     window and blocked multitasking resize entirely.

private var chromeHidden = false

class PencilPlugin: Plugin {
    private var pencilInteraction: UIPencilInteraction?

    @objc public override func load(webview: WKWebView) {
        NSLog("[PencilPlugin] load() called")

        let interaction = UIPencilInteraction()
        interaction.delegate = self
        webview.addInteraction(interaction)
        self.pencilInteraction = interaction

        ChromeControl.installSwizzle()

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
        chromeHidden = args.hidden
        DispatchQueue.main.async {
            ChromeControl.apply(hidden: args.hidden)
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

// MARK: - Chrome control via runtime swizzling

private enum ChromeControl {
    static var swizzled = false

    /// Replace `prefersStatusBarHidden` and
    /// `prefersHomeIndicatorAutoHidden` on `UIViewController` so every
    /// view controller (including the Tauri-generated root) reads our
    /// `chromeHidden` flag rather than the default `false`.
    static func installSwizzle() {
        guard !swizzled else { return }
        swizzled = true
        swap(#selector(getter: UIViewController.prefersStatusBarHidden),
             with: #selector(UIViewController._hush_prefersStatusBarHidden))
        swap(#selector(getter: UIViewController.prefersHomeIndicatorAutoHidden),
             with: #selector(UIViewController._hush_prefersHomeIndicatorAutoHidden))
    }

    static func apply(hidden: Bool) {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }
        for window in scene.windows {
            window.rootViewController?.setNeedsStatusBarAppearanceUpdate()
            if #available(iOS 11, *) {
                window.rootViewController?.setNeedsUpdateOfHomeIndicatorAutoHidden()
            }
        }
        // Keep the window freely resizable in every chrome state so iPad
        // Split View / Slide Over still work — only enforce a sane 320×320
        // floor. Hiding chrome used to pin minimumSize == maximumSize == the
        // current scene size to suppress the Stage-Manager resize handle,
        // but that locked the window and blocked multitasking resize
        // entirely (the app could no longer be scaled down into split
        // screen or slide over). Leave the resize handle painted; letting
        // it work is the whole point.
        scene.sizeRestrictions?.minimumSize = CGSize(width: 320, height: 320)
        scene.sizeRestrictions?.maximumSize = CGSize(width: CGFloat.greatestFiniteMagnitude,
                                                      height: CGFloat.greatestFiniteMagnitude)
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
        if chromeHidden { return true }
        // Fall back to the original (now under our renamed selector).
        return self._hush_prefersStatusBarHidden()
    }

    @objc fileprivate func _hush_prefersHomeIndicatorAutoHidden() -> Bool {
        if chromeHidden { return true }
        return self._hush_prefersHomeIndicatorAutoHidden()
    }
}
