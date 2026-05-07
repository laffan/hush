import SwiftRs
import Tauri
import UIKit
import WebKit

// Pencil plugin — only purpose is forwarding the Apple Pencil 2nd-gen /
// Pencil Pro hardware double-tap into a Tauri plugin event. We attach
// `UIPencilInteraction` directly to the WKWebView; this interaction
// fires on the squeeze sensor and never touches the WKWebView's
// scrollView gesture chain, so it does not interfere with how the page
// receives touches. (An earlier iteration also installed a passive
// `UIGestureRecognizer` on the scrollView for finger-vs-pencil
// detection — that one *did* break iPad drawing on this WKWebView
// build, so it has been removed. Touch-type gating now lives entirely
// in JS via `PointerEvent.pointerType`.)
class PencilPlugin: Plugin {
    private var pencilInteraction: UIPencilInteraction?

    @objc public override func load(webview: WKWebView) {
        NSLog("[PencilPlugin] load() called")

        let interaction = UIPencilInteraction()
        interaction.delegate = self
        webview.addInteraction(interaction)
        self.pencilInteraction = interaction

        NSLog("[PencilPlugin] handlers installed")

        // Emit a "loaded" event so JS can confirm the bridge is alive.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            NSLog("[PencilPlugin] firing loaded event")
            self?.trigger("loaded", data: [:])
        }
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
