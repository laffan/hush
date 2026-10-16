import UIKit
import WebKit

// ⌘Z and ⇧⌘Z, handed to the page as the key presses they are.
//
// iPadOS gives every app a menu bar whose Edit menu owns ⌘Z: the press
// becomes UIKit's `undo:` action, sent down the responder chain, and the
// page never sees a `keydown` for it. WebKit answers `undo:` only for an
// editable element with history in WebKit's own undo stack, by sending
// it a `beforeinput` of type `historyUndo` — which CodeMirror listens
// for, so a Doc still undid. A notebook canvas is not editable and keeps
// its own history, so ⌘Z on a canvas reached nothing at all, and redo
// the same.
//
// These key commands sit on each window's root view controller, in the
// responder chain ahead of the menu, and their action is found on the
// WKWebView (the content view's ancestor) through the extension below.
// It calls `window.__hushHistoryKey` (src/history-keys.js), which
// dispatches the ⌘Z keydown the press would have produced, so every
// surface's own handling — the canvas, CodeMirror, a text field — runs
// as it does on the Mac. The Edit menu's own Undo item, chosen with the
// pointer, still goes to WebKit as before.

enum HistoryKeys {
    /// Root view controllers already carrying the commands.
    static var attached = Set<ObjectIdentifier>()

    static func attach(to webView: WKWebView) {
        guard let root = webView.window?.rootViewController else { return }
        let key = ObjectIdentifier(root)
        guard !attached.contains(key) else { return }
        attached.insert(key)
        let undo = UIKeyCommand(input: "z", modifierFlags: .command,
                                action: #selector(WKWebView.hushHistoryUndo(_:)))
        let redo = UIKeyCommand(input: "z", modifierFlags: [.command, .shift],
                                action: #selector(WKWebView.hushHistoryRedo(_:)))
        for command in [undo, redo] {
            command.wantsPriorityOverSystemBehavior = true
            root.addKeyCommand(command)
        }
        NSLog("[HistoryKeys] ⌘Z / ⇧⌘Z attached")
    }
}

extension WKWebView {
    @objc func hushHistoryUndo(_ sender: UIKeyCommand) { hushSendHistoryKey("undo") }
    @objc func hushHistoryRedo(_ sender: UIKeyCommand) { hushSendHistoryKey("redo") }

    private func hushSendHistoryKey(_ direction: String) {
        evaluateJavaScript(
            "window.__hushHistoryKey ? (window.__hushHistoryKey('\(direction)'), true) : false"
        ) { result, error in
            if let error = error {
                NSLog("[HistoryKeys] \(direction) failed: \(error)")
            } else if (result as? Bool) != true {
                NSLog("[HistoryKeys] \(direction): page has no handler yet")
            }
        }
    }
}
