import SwiftRs
import Tauri
import UIKit
import WebKit

// Observes UITouch.type without consuming touches. Reports the type for
// every touch-down so JS can show "pencil" vs "finger".
class TouchTypeRecognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
    var onTouch: ((UITouch.TouchType) -> Void)?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        self.cancelsTouchesInView = false
        self.delaysTouchesBegan = false
        self.delaysTouchesEnded = false
        self.delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        for touch in touches {
            onTouch?(touch.type)
        }
        // Never recognize - immediately fail so we stay passive observers
        // and other recognizers/the webview keep getting touches.
        self.state = .failed
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        return true
    }
}

class PencilPlugin: Plugin {
    private var pencilInteraction: UIPencilInteraction?
    private var recognizer: TouchTypeRecognizer?

    @objc public override func load(webview: WKWebView) {
        NSLog("[PencilPlugin] load() called")

        // 1. Touch type detection. Attach to the WKWebView's scrollView -
        //    that's the actual touch surface inside WKWebView.
        let r = TouchTypeRecognizer(target: nil, action: nil)
        r.onTouch = { [weak self] type in
            let kind: String = (type == .pencil) ? "pencil" : "finger"
            NSLog("[PencilPlugin] touch: \(kind)")
            self?.trigger("touch", data: ["type": kind])
        }
        webview.scrollView.addGestureRecognizer(r)
        self.recognizer = r

        // 2. Apple Pencil double-tap (Pencil 2nd gen / Pencil Pro).
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
