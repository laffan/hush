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
// application(_:configurationForConnecting:) — so swizzling that method
// (in the plugin's load(), well after launch) can't work, and adopting
// scenes via Info.plist would make UIKit ignore wry's legacy primary
// window. Instead we observe `UIScene.willConnectNotification`: when
// `open_single_file_window` fires requestSceneSessionActivation, the scene
// connection lands in our observer and we attach a UIWindow + content
// ourselves. The primary window is a legacy UIWindow (not a scene) so it
// never trips the observer; we also gate on an `expectingNewScene` flag so
// we only ever claim a scene we explicitly requested, and destroy
// unrequested (iOS-restored) scenes so they can't be reused.
//
// Stage 2 — the SATELLITE RELAY. The second scene hosts a hand-made
// WKWebView that loads the REAL `dist` bundle (same origin as the primary,
// via the primary's own URL-scheme handler) in single-file mode. A plain
// WKWebView gets no Tauri IPC, so we inject a `window.__TAURI_INTERNALS__`
// shim whose `invoke()` posts to a native `hushInvoke` handler; native
// runs the request inside the PRIMARY webview (which has the real IPC) via
// `__hushSatelliteRequest`, and the primary posts the result back through
// `hushRelayResult`, which native forwards to the satellite. JSON crossing
// the JS↔Swift boundary is base64-wrapped so there is no string-escaping
// risk. This one relay covers EVERY command, so all file types are served
// by the same plumbing.
//
// Diagnostics are emitted via NSLog and `trigger("diag", …)` (dispatched to
// the main thread, since trigger drives evaluateJavaScript) so they surface
// in the MAIN window's JS console (Safari Web Inspector) without a terminal.

let HUSH_FILE_ACTIVITY = "com.hushwriter.app.fileWindow"

struct HushSeed {
    let fileId: String
    let fileType: String
    let title: String
}

final class HushWindowBridge {
    static let shared = HushWindowBridge()
    weak var primaryWebview: WKWebView?
    weak var satelliteWebview: WKWebView?
    var pendingSeed: HushSeed?
    var expectingNewScene = false
    var relayInstalled = false
    // Strong refs so the scene windows aren't deallocated — in this
    // observer-based approach no scene delegate owns them.
    var sceneWindows: [UIWindow] = []
}

class IpadWindowPlugin: Plugin, WKScriptMessageHandler {
    @objc public override func load(webview: WKWebView) {
        NSLog("[IpadWindow] load() called")
        HushWindowBridge.shared.primaryWebview = webview
        installPrimaryRelay(on: webview)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sceneWillConnect(_:)),
            name: UIScene.willConnectNotification,
            object: nil
        )
        diag("observer installed for UIScene.willConnectNotification")

        // Purge the backlog of leftover secondary scenes that iOS persists
        // and restores from previous runs. Without this they pile up,
        // flash open/closed as we destroy them, and (worse) get *reused*
        // by a later activation instead of a fresh seeded scene. Run after
        // a short delay so the primary webview is attached to its scene and
        // restorations have settled; never touch the primary or any window
        // we've already attached ourselves.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.purgeLeftoverScenes()
        }
    }

    /// Teach the PRIMARY webview (the only one with real Tauri IPC) to run
    /// relayed requests from the satellite. The user script applies to
    /// future loads; the immediate evaluateJavaScript covers the page that
    /// is already running. Also registers the result message handler.
    private func installPrimaryRelay(on webview: WKWebView) {
        guard !HushWindowBridge.shared.relayInstalled else { return }
        HushWindowBridge.shared.relayInstalled = true
        let ucc = webview.configuration.userContentController
        ucc.add(self, name: "hushRelayResult")
        ucc.addUserScript(WKUserScript(
            source: Self.primaryRelayJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webview.evaluateJavaScript(Self.primaryRelayJS, completionHandler: nil)
    }

    private func purgeLeftoverScenes() {
        guard let primary = HushWindowBridge.shared.primaryWebview?.window?.windowScene else {
            diag("purge skipped: primary scene not yet identifiable")
            return
        }
        for s in UIApplication.shared.connectedScenes {
            guard let ws = s as? UIWindowScene,
                  ws.session.role == .windowApplication,
                  ws !== primary,
                  !HushWindowBridge.shared.sceneWindows.contains(where: { $0.windowScene === ws })
            else { continue }
            diag("purging leftover scene session at launch")
            UIApplication.shared.requestSceneSessionDestruction(ws.session, options: nil, errorHandler: nil)
        }
    }

    // Tauri command: invoke("plugin:ipad-window|open_single_file_window", …)
    @objc public func openWindow(_ invoke: Invoke) throws {
        struct Args: Decodable {
            let fileId: String
            let fileType: String
            let title: String
        }
        let args = try invoke.parseArgs(Args.self)
        diag("openWindow file=\(args.fileId) type=\(args.fileType) title=\(args.title)")

        HushWindowBridge.shared.pendingSeed = HushSeed(
            fileId: args.fileId, fileType: args.fileType, title: args.title
        )
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
        guard expecting else {
            // Unrequested = iOS restoring a leftover session from a prior
            // run. Destroy it so it can't be reused by a later activation
            // (which would foreground a stale, seedless window). Primary is
            // a legacy window scene that connected before this observer
            // existed, so it never reaches here.
            diag("willConnect: unrequested scene; destroying stale session")
            DispatchQueue.main.async {
                UIApplication.shared.requestSceneSessionDestruction(
                    scene.session, options: nil, errorHandler: nil
                )
            }
            return
        }
        HushWindowBridge.shared.expectingNewScene = false

        let seed = HushWindowBridge.shared.pendingSeed
        let win = UIWindow(windowScene: scene)
        win.rootViewController = makeSatelliteVC(seed: seed)
        win.makeKeyAndVisible()
        HushWindowBridge.shared.sceneWindows.append(win)
        diag("scene window attached (requested) file=\(seed?.fileId ?? "(none)")")
    }

    // MARK: - Relay message routing

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "hushInvoke":
            // Satellite asked us to run a command. Forward it into the
            // primary webview (real IPC) as a base64 JSON request.
            guard let dict = message.body as? [String: Any], let id = dict["id"] else { return }
            let cmd = dict["cmd"] as? String ?? ""
            let args = dict["args"] ?? [String: Any]()
            diag("relay → \(cmd)")
            guard let b64 = Self.jsonB64(["id": id, "cmd": cmd, "args": args]) else {
                diag("relay encode failed for \(cmd)")
                return
            }
            HushWindowBridge.shared.primaryWebview?.evaluateJavaScript(
                "window.__hushSatelliteRequest(\"\(b64)\")", completionHandler: nil
            )
        case "hushRelayResult":
            // Primary produced a result (already base64 JSON). Hand it
            // straight to the satellite, which resolves the pending promise.
            guard let b64 = message.body as? String else { return }
            HushWindowBridge.shared.satelliteWebview?.evaluateJavaScript(
                "window.__HUSH_RESOLVE_B64__(\"\(b64)\")", completionHandler: nil
            )
        default:
            break
        }
    }

    /// Base64-encode a JSON-serializable value (must be an array/dict at the
    /// top level, per JSONSerialization). Standard base64, UTF-8 — matches
    /// the JS `decodeURIComponent(escape(atob(...)))` decode on both sides.
    static func jsonB64(_ obj: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(obj),
              let d = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return d.base64EncodedString()
    }

    // MARK: - Satellite content

    /// Build the satellite scene's root VC: a full-bleed WKWebView that
    /// loads the real bundled `dist` in single-file mode, wired to the relay.
    private func makeSatelliteVC(seed: HushSeed?) -> UIViewController {
        let vc = UIViewController()
        vc.view.backgroundColor = .systemBackground

        let primary = HushWindowBridge.shared.primaryWebview

        // Copy the primary's configuration so the satellite inherits wry's
        // custom-scheme asset handler(s), process pool, and data store
        // (same web origin) — copying is the supported way to share scheme
        // handlers, vs. re-registering a handler instance on a fresh config
        // (which can raise). We then swap in OUR userContentController,
        // dropping wry's injected IPC scripts (the satellite uses the relay
        // shim instead) while keeping the inherited asset plumbing.
        let cfg: WKWebViewConfiguration =
            (primary?.configuration.copy() as? WKWebViewConfiguration) ?? WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.add(self, name: "hushInvoke")
        ucc.addUserScript(WKUserScript(
            source: Self.satelliteShimJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        cfg.userContentController = ucc

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.translatesAutoresizingMaskIntoConstraints = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        HushWindowBridge.shared.satelliteWebview = web

        vc.view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: vc.view.topAnchor),
            web.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
        ])

        if let target = satelliteURL(seed: seed) {
            diag("satellite loading \(target.absoluteString)")
            web.load(URLRequest(url: target))
        } else {
            diag("satellite URL build failed; primary.url=\(primary?.url?.absoluteString ?? "nil")")
            web.loadHTMLString(
                "<html><body style=\"font-family:-apple-system;padding:2rem\">"
                + "<h2>Satellite could not resolve the app URL.</h2></body></html>",
                baseURL: nil
            )
        }
        return vc
    }

    /// Same-origin app URL + single-file hash. Mirrors the desktop
    /// `index.html#file=…&type=…` seed that `getInitialFileFromHash()` reads;
    /// `satellite=1` flags single-file boot mode for a later stage.
    private func satelliteURL(seed: HushSeed?) -> URL? {
        guard let seed = seed,
              let base = HushWindowBridge.shared.primaryWebview?.url else { return nil }
        var s = base.absoluteString
        if let hashIdx = s.firstIndex(of: "#") { s = String(s[..<hashIdx]) }
        let qs = CharacterSet.urlQueryAllowed
        let f = seed.fileId.addingPercentEncoding(withAllowedCharacters: qs) ?? seed.fileId
        let t = seed.fileType.addingPercentEncoding(withAllowedCharacters: qs) ?? seed.fileType
        s += "#satellite=1&file=\(f)&type=\(t)"
        return URL(string: s)
    }

    private func diag(_ message: String) {
        NSLog("[IpadWindow] \(message)")
        // trigger() drives evaluateJavaScript, which must run on the main
        // thread. Command handlers (openWindow) run off-main, so dispatch
        // here — otherwise those breadcrumbs are silently dropped and only
        // main-thread callers (the willConnect observer) reach the JS
        // console.
        DispatchQueue.main.async { [weak self] in
            self?.trigger("diag", data: ["msg": message])
        }
    }

    // MARK: - Injected JS

    /// Runs in the SATELLITE at document-start, before the dist bundle, so
    /// `@tauri-apps/api/core`'s `invoke` finds a working `__TAURI_INTERNALS__`.
    static let satelliteShimJS = """
    (function(){
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.__hushShim) return;
      var pending = Object.create(null), nextId = 1;
      window.__HUSH_SATELLITE__ = true;
      function dec(b64){ return JSON.parse(decodeURIComponent(escape(atob(b64)))); }
      window.__HUSH_RESOLVE_B64__ = function(b64){
        var o; try { o = dec(b64); } catch(e){ return; }
        var p = pending[o.id]; if(!p) return; delete pending[o.id];
        if(o.ok) p.resolve(o.payload); else p.reject(o.payload);
      };
      window.__TAURI_INTERNALS__ = {
        __hushShim: true,
        metadata: {
          currentWindow: { label: "ipad-satellite" },
          currentWebview: { label: "ipad-satellite", windowLabel: "ipad-satellite" }
        },
        invoke: function(cmd, args){
          return new Promise(function(resolve, reject){
            var id = nextId++;
            pending[id] = { resolve: resolve, reject: reject };
            try {
              window.webkit.messageHandlers.hushInvoke.postMessage({ id: id, cmd: cmd, args: args || {} });
            } catch(e){ delete pending[id]; reject(e); }
          });
        },
        transformCallback: function(cb, once){
          var id = nextId++;
          (window.__HUSH_CB__ = window.__HUSH_CB__ || Object.create(null))[id] = cb;
          return id;
        },
        unregisterCallback: function(id){ if(window.__HUSH_CB__) delete window.__HUSH_CB__[id]; },
        convertFileSrc: function(path){ return path; }
      };
    })();
    """

    /// Runs in the PRIMARY: executes a relayed request with the real Tauri
    /// invoke and posts the result back (base64 JSON) for native to forward.
    static let primaryRelayJS = """
    (function(){
      if (window.__hushSatelliteRequest) return;
      function dec(b64){ return JSON.parse(decodeURIComponent(escape(atob(b64)))); }
      function enc(o){ return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
      window.__hushSatelliteRequest = function(b64){
        var req; try { req = dec(b64); } catch(e){ return; }
        function reply(ok, payload){
          try { window.webkit.messageHandlers.hushRelayResult.postMessage(enc({ id: req.id, ok: ok, payload: payload })); }
          catch(e){}
        }
        try {
          Promise.resolve(window.__TAURI_INTERNALS__.invoke(req.cmd, req.args)).then(
            function(res){ reply(true, res); },
            function(err){ reply(false, (err && err.message) ? err.message : String(err)); }
          );
        } catch(e){ reply(false, String(e)); }
      };
    })();
    """
}

@_cdecl("init_plugin_ipad_window")
func initPlugin() -> Plugin {
    return IpadWindowPlugin()
}
