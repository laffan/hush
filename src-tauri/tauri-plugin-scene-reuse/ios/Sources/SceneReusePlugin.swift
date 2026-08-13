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

  /// Hide the scene's windows first, then ask the system to tear the
  /// session down. Destruction is asynchronous and the webview inside is
  /// already loading by the time we get here, so without the hide the
  /// monitor can flash a frame or two of the restored document.
  ///
  /// If the system refuses the destruction we put the windows back:
  /// a hidden-but-still-attached scene owns the display and paints it
  /// black, which is a worse outcome than the window we were trying to
  /// get rid of.
  private func dismissExternalDisplayScene(_ scene: UIScene) {
    let windows = (scene as? UIWindowScene)?.windows ?? []
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
}

@_cdecl("init_plugin_scene_reuse")
func initPlugin() -> Plugin {
  return SceneReusePlugin()
}
