import SwiftRs
import Tauri
import UIKit
import WebKit

// Two jobs, both about *which scene* iPadOS hands our content to.
//
// 1. Reuse: keeps external URL opens (hushwriter://, Files "Open in…")
//    from spawning a brand-new iPad window.
//
//    Hush opts into multi-window (UIApplicationSupportsMultipleScenes),
//    so when another app opens one of our URLs iPadOS is free to create
//    a fresh scene for it — which is what made "Send to Hush" pop an
//    empty window every time. Marking each scene as able to (and
//    preferring to) activate for any target content identifier tells the
//    system an on-screen window can take the event, so it routes there
//    instead.
//
// 2. External displays: refuses the scene iPadOS offers for a connected
//    monitor.
//
//    The same multi-scene opt-in makes the app eligible for an
//    external-display session. Plugging a monitor in therefore handed
//    Hush a second scene whose window booted the full app and restored
//    the last file — the document "took over" the monitor. That session
//    role is non-interactive by design: the pointer cannot cross into
//    it, it has no close affordance, and nothing inside the app can
//    dismiss it, so the only way out was unplugging the cable. Hush has
//    no external-display presentation mode, so the correct answer is to
//    decline the session and let iPadOS fall back to mirroring.
//
//    Only external-display *roles* are refused. A window the user drags
//    to a monitor themselves under Stage Manager is an ordinary
//    application-role scene that happens to sit on another screen — that
//    stays untouched.
//
//    This is one of two halves. The Rust side (`src/ios_scene.rs`) makes
//    the same call when Tauri asks it whether to build a window for a
//    requested scene, because the two run off different notifications
//    and neither ordering is guaranteed. Both are idempotent: a second
//    destruction request for a session already on its way out just
//    reports an error to its handler.

class SceneReusePlugin: Plugin {
  @objc public override func load(webview: WKWebView) {
    DispatchQueue.main.async {
      self.applyToConnectedScenes()
      // Windows opened later need the same treatment.
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.sceneWillConnect(_:)),
        name: UIScene.willConnectNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(self.sceneDidDisconnect(_:)),
        name: UIScene.didDisconnectNotification,
        object: nil
      )
    }
  }

  @objc private func sceneWillConnect(_ note: Notification) {
    if let scene = note.object as? UIScene {
      apply(to: scene)
    }
  }

  private func applyToConnectedScenes() {
    // Covers the launch-with-monitor-already-attached case: the
    // external-display session exists before our plugin loads, so the
    // willConnect notification for it has already been and gone.
    for scene in UIApplication.shared.connectedScenes {
      apply(to: scene)
    }
  }

  private func apply(to scene: UIScene) {
    if isExternalDisplay(scene) {
      dismissExternalDisplayScene(scene)
      return
    }
    let anyEvent = NSPredicate(value: true)
    scene.activationConditions.canActivateForTargetContentIdentifierPredicate = anyEvent
    scene.activationConditions.prefersToActivateForTargetContentIdentifierPredicate = anyEvent
  }

  /// True for the session roles iPadOS uses to drive a connected
  /// monitor: `UIWindowSceneSessionRoleExternalDisplayNonInteractive`
  /// (iOS 16+) and the deprecated `…RoleExternalDisplay`. Matched on the
  /// raw value rather than the constants so this compiles against SDKs
  /// on either side of that rename.
  private func isExternalDisplay(_ scene: UIScene) -> Bool {
    return scene.session.role.rawValue.contains("ExternalDisplay")
  }

  /// Claim the scene with a placeholder window, hide whatever is already
  /// in it, then ask the system to tear the session down.
  ///
  /// **The placeholder is the important part.** Destruction is
  /// asynchronous, and while the session is still connected the scene is
  /// a `UIWindowScene` with zero windows — which is exactly what Tauri's
  /// window factory looks for when it needs somewhere to put a new
  /// window (`tao`'s `unitialized_scene()` returns the first empty
  /// scene it finds). So a perfectly ordinary "Open in new window",
  /// issued in the seconds after a monitor is plugged in, would have its
  /// window adopted by the display we are in the middle of declining.
  /// An empty hidden `UIWindow` costs nothing and takes the scene out of
  /// that running, whichever order the notifications arrive in.
  ///
  /// Hiding the existing windows is the cosmetic half: the webview
  /// inside is already loading by the time we get here, and without it
  /// the monitor can flash a frame or two of the restored document.
  ///
  /// If the system refuses the destruction we put the windows back: a
  /// hidden-but-still-attached scene owns the display and paints it
  /// black, which is a worse outcome than the window we were trying to
  /// get rid of. The placeholder stays either way — it has no content,
  /// and it is still the only thing standing between that scene and the
  /// next window the app opens.
  private func dismissExternalDisplayScene(_ scene: UIScene) {
    let windows = (scene as? UIWindowScene)?.windows ?? []
    NSLog("Hush: declining external-display scene (role \(scene.session.role.rawValue), \(windows.count) window(s))")
    if let windowScene = scene as? UIWindowScene {
      let placeholder = UIWindow(windowScene: windowScene)
      placeholder.isHidden = true
      placeholder.isUserInteractionEnabled = false
      externalDisplayPlaceholders.append(placeholder)
    }
    for window in windows {
      window.isHidden = true
    }
    UIApplication.shared.requestSceneSessionDestruction(
      scene.session,
      options: nil,
      errorHandler: { error in
        NSLog("Hush: external-display scene destruction failed: \(error)")
        DispatchQueue.main.async {
          for window in windows {
            window.isHidden = false
          }
        }
      }
    )
  }

  /// Placeholder windows are held here purely so ARC doesn't release
  /// them the moment `dismissExternalDisplayScene` returns — a window
  /// with no other owner would be deallocated and leave the scene empty
  /// again, which is the state we created it to avoid. Cleared when the
  /// scene it belonged to actually disconnects.
  private var externalDisplayPlaceholders: [UIWindow] = []

  @objc private func sceneDidDisconnect(_ note: Notification) {
    guard let scene = note.object as? UIScene else { return }
    let count = externalDisplayPlaceholders.count
    externalDisplayPlaceholders.removeAll { $0.windowScene == nil || $0.windowScene === scene }
    if externalDisplayPlaceholders.count != count {
      NSLog("Hush: external-display scene disconnected, placeholder released")
    }
  }
}

@_cdecl("init_plugin_scene_reuse")
func initPlugin() -> Plugin {
  return SceneReusePlugin()
}
