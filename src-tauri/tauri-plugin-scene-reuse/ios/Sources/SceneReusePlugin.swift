import SwiftRs
import Tauri
import UIKit
import WebKit

// Keeps external URL opens (hushwriter://, Files "Open in…") from
// spawning a brand-new iPad window.
//
// Hush opts into multi-window (UIApplicationSupportsMultipleScenes), so
// when another app opens one of our URLs iPadOS is free to create a
// fresh scene for it — which is what made "Send to Hush" pop an empty
// window every time. Marking each scene as able to (and preferring to)
// activate for any target content identifier tells the system an
// on-screen window can take the event, so it routes there instead.
//
// This only affects where incoming events land; the user opening a new
// window from within Hush is untouched.

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
    for scene in UIApplication.shared.connectedScenes {
      apply(to: scene)
    }
  }

  private func apply(to scene: UIScene) {
    let anyEvent = NSPredicate(value: true)
    scene.activationConditions.canActivateForTargetContentIdentifierPredicate = anyEvent
    scene.activationConditions.prefersToActivateForTargetContentIdentifierPredicate = anyEvent
  }
}

@_cdecl("init_plugin_scene_reuse")
func initPlugin() -> Plugin {
  return SceneReusePlugin()
}
