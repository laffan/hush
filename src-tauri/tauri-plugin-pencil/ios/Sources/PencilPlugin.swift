import SwiftRs
import Tauri
import UIKit
import WebKit

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
//  2. Hide the status bar while a window is full screen, and bring it
//     back — window controls and all — while the pointer sits in the
//     top-left corner. See ChromeControl.swift.

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
            ChromeControl.hidden = args.hidden
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
