import GameController
import UIKit
import WebKit

// Hands each window's web view the hardware keyboard.
//
// On iPad a hardware key goes to the first responder and nowhere else.
// For the page that is WebKit's content view inside the WKWebView, and
// until it holds that role ⌘P, ⌘\ and every other shortcut are dropped
// before the page exists as far as the key is concerned — no `keydown`,
// at any level, so nothing in `window-shortcuts.js` can catch them.
//
// Nothing gave it the role at launch. wry makes the webview first
// responder when it builds a macOS window (wry#739) but has no iOS
// equivalent, and the page cannot do it for itself: WebKit only
// promotes the content view for a finger tap it recognizes as one, or
// for an editable element focused while the user is interacting.
// `editor.focus()` from boot or from `installActivationFocus` is
// neither, so it moves `document.activeElement` and nothing else. And a
// trackpad or mouse click never counts as that tap — WebKit routes
// pointer touches to its mouse interaction alone, which doesn't claim
// first responder. So with a Magic Keyboard the shortcuts stayed dead
// until a click landed in editable text: a Doc or a text shape worked,
// a PDF (nothing editable on it) never did.
//
// So the native side claims it, per window: once the plugin loads,
// whenever a window becomes key or its scene activates (launch, app
// switch, Stage Manager focus moving between Hush windows), and when a
// keyboard is attached mid-session. Becoming first responder marks the
// page focused, so the page's own `focus` listener then runs and puts
// the caret where it belongs — now with a responder behind it.
//
// Only while a hardware keyboard is attached. Without one there are no
// shortcuts to deliver, and a page with the editor focused would answer
// the claim by starting an input session — the on-screen keyboard
// sliding up over a document nobody tapped.
//
// It never takes the role from anything else in the web view (a claim
// that finds the web view already first responder is a no-op), and
// stands aside while a view controller is presented over the window —
// a share sheet, a document picker — whose own responders own the keys.

enum KeyboardFocus {
    static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        let center = NotificationCenter.default
        center.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            guard let window = note.object as? UIWindow else { return }
            KeyboardFocus.claim(in: window)
        }
        center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { note in
            guard let scene = note.object as? UIWindowScene else { return }
            for window in scene.windows { KeyboardFocus.claim(in: window) }
        }
        center.addObserver(forName: .GCKeyboardDidConnect, object: nil, queue: .main) { _ in
            KeyboardFocus.claimEverywhere()
        }
    }

    /// The plugin's own web view, at load. It may not be in its window
    /// yet — `becomeFirstResponder` refuses a view without one — so try
    /// again for a few seconds; the notifications above cover everything
    /// after that.
    static func claimAtLoad(_ webView: WKWebView, attempts: Int = 20) {
        if webView.window != nil {
            claim(webView)
            return
        }
        guard attempts > 1 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            KeyboardFocus.claimAtLoad(webView, attempts: attempts - 1)
        }
    }

    static func claimEverywhere() {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes
        where scene.activationState == .foregroundActive {
            for window in scene.windows { claim(in: window) }
        }
    }

    static func claim(in window: UIWindow) {
        // Only tao's windows carry a web view; the keyboard's and other
        // system windows in the scene come back nil here.
        guard let webView = ChromeControl.webView(in: window) else { return }
        claim(webView)
    }

    static func claim(_ webView: WKWebView) {
        guard GCKeyboard.coalesced != nil,
              let window = webView.window,
              window.rootViewController?.presentedViewController == nil,
              !holdsFirstResponder(webView) else { return }
        let took = webView.becomeFirstResponder()
        NSLog("[KeyboardFocus] web view first responder: \(took)")
    }

    /// WKWebView itself never reports first responder — its content view
    /// takes the role — so look anywhere under it.
    private static func holdsFirstResponder(_ view: UIView) -> Bool {
        if view.isFirstResponder { return true }
        return view.subviews.contains(where: holdsFirstResponder)
    }
}
