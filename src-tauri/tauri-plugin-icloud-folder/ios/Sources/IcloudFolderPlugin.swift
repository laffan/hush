import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

// iCloud-folder plugin — proof-of-concept for granting Hush durable,
// read/write access to an *arbitrary* user-picked folder on iOS
// (typically an iCloud Drive location).
//
// iOS apps are always sandboxed, so a folder outside the sandbox can
// only be touched through a security-scoped URL handed back by
// UIDocumentPickerViewController. That access dies when the app quits
// unless we persist a *security-scoped bookmark* and re-resolve it on
// the next launch. Tauri's stock dialog/fs plugins do neither (no
// folder picker mode, no bookmark persistence), which is exactly the
// gap this plugin fills.
//
// Flow:
//   1. pickFolder()       -> present the folder picker, start access,
//                            mint a bookmark, return { path, bookmark }.
//   2. (JS persists the bookmark blob, e.g. localStorage / settings.)
//   3. resolveBookmark()  -> on a later launch, resolve the blob back
//                            into a live security-scoped URL and start
//                            access again.
//   4. listDir/readFile/writeFile operate by absolute path while the
//      folder's scope is held — this is what lets the existing Rust
//      std::fs Local Sync code work unchanged on iOS.
//   5. stopAccess()       -> balance the startAccessing call.

class IcloudFolderPlugin: Plugin, UIDocumentPickerDelegate {
  // The pick is async (waits on the picker UI), so we stash the Invoke
  // and resolve it from the delegate callback.
  private var pendingPick: Invoke?

  // Folders we currently hold security-scoped access to, keyed by path,
  // so stopAccess() can balance the matching startAccessing call.
  private var accessing: [String: URL] = [:]

  // MARK: - Pick a folder

  @objc public func pickFolder(_ invoke: Invoke) throws {
    pendingPick = invoke
    DispatchQueue.main.async {
      let picker: UIDocumentPickerViewController
      if #available(iOS 14.0, *) {
        // The key difference from Tauri's stock dialog plugin: we ask
        // for UTType.folder (folder selection) with asCopy:false so we
        // get the real in-place, security-scoped folder URL.
        picker = UIDocumentPickerViewController(
          forOpeningContentTypes: [UTType.folder], asCopy: false)
      } else {
        picker = UIDocumentPickerViewController(
          documentTypes: ["public.folder"], in: .open)
      }
      picker.delegate = self
      picker.allowsMultipleSelection = false
      picker.modalPresentationStyle = .fullScreen
      self.manager.viewController?.present(picker, animated: true, completion: nil)
    }
  }

  func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    guard let invoke = pendingPick else { return }
    pendingPick = nil
    guard let url = urls.first else {
      invoke.reject("No folder selected")
      return
    }
    // Must hold scope before we can read attributes / mint a bookmark.
    let started = url.startAccessingSecurityScopedResource()
    do {
      // On iOS, bookmarks are implicitly security-scoped — there is no
      // .withSecurityScope option (that's macOS-only). A plain
      // bookmarkData() blob is what survives across launches.
      let data = try url.bookmarkData(
        options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
      accessing[url.path] = url
      invoke.resolve([
        "path": url.path,
        "bookmark": data.base64EncodedString(),
        "name": url.lastPathComponent,
        "accessOk": started,
      ])
    } catch {
      if started { url.stopAccessingSecurityScopedResource() }
      invoke.reject("Failed to create bookmark: \(error.localizedDescription)")
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pendingPick?.reject("cancelled")
    pendingPick = nil
  }

  // MARK: - Resolve a persisted bookmark (the cross-launch proof)

  @objc public func resolveBookmark(_ invoke: Invoke) throws {
    struct Args: Decodable { let bookmark: String }
    let args = try invoke.parseArgs(Args.self)
    guard let data = Data(base64Encoded: args.bookmark) else {
      invoke.reject("Bookmark is not valid base64")
      return
    }
    var stale = false
    do {
      let url = try URL(
        resolvingBookmarkData: data, options: [], relativeTo: nil,
        bookmarkDataIsStale: &stale)
      let started = url.startAccessingSecurityScopedResource()
      accessing[url.path] = url
      invoke.resolve([
        "path": url.path,
        "name": url.lastPathComponent,
        "stale": stale,
        "accessOk": started,
      ])
    } catch {
      invoke.reject("Failed to resolve bookmark: \(error.localizedDescription)")
    }
  }

  @objc public func stopAccess(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    if let url = accessing.removeValue(forKey: args.path) {
      url.stopAccessingSecurityScopedResource()
    }
    invoke.resolve()
  }

  // MARK: - File operations inside the scoped folder

  @objc public func listDir(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let dir = URL(fileURLWithPath: args.path, isDirectory: true)
    do {
      let items = try FileManager.default.contentsOfDirectory(
        at: dir, includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles])
      var entries: [[String: Any]] = []
      for item in items {
        let isDir =
          (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        entries.append(["name": item.lastPathComponent, "isDir": isDir])
      }
      invoke.resolve(["entries": entries])
    } catch {
      invoke.reject("listDir failed: \(error.localizedDescription)")
    }
  }

  @objc public func readFile(_ invoke: Invoke) throws {
    struct Args: Decodable { let path: String }
    let args = try invoke.parseArgs(Args.self)
    let url = URL(fileURLWithPath: args.path)
    // iCloud files can be dataless placeholders; nudge a download then
    // do a coordinated read so we don't race the iCloud daemon.
    try? FileManager.default.startDownloadingUbiquitousItem(at: url)
    var coordErr: NSError?
    var contents: String?
    var readErr: Error?
    NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordErr) {
      (u) in
      do { contents = try String(contentsOf: u, encoding: .utf8) } catch { readErr = error }
    }
    if let c = contents {
      invoke.resolve(["contents": c])
    } else {
      invoke.reject(
        "read failed: "
          + (readErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }

  @objc public func writeFile(_ invoke: Invoke) throws {
    struct Args: Decodable {
      let path: String
      let contents: String
    }
    let args = try invoke.parseArgs(Args.self)
    let url = URL(fileURLWithPath: args.path)
    var coordErr: NSError?
    var writeErr: Error?
    NSFileCoordinator().coordinate(
      writingItemAt: url, options: .forReplacing, error: &coordErr
    ) { (u) in
      do {
        try args.contents.write(to: u, atomically: true, encoding: .utf8)
      } catch {
        writeErr = error
      }
    }
    if writeErr == nil && coordErr == nil {
      invoke.resolve()
    } else {
      invoke.reject(
        "write failed: "
          + (writeErr?.localizedDescription ?? coordErr?.localizedDescription ?? "unknown"))
    }
  }
}

@_cdecl("init_plugin_icloud_folder")
func initPlugin() -> Plugin {
  return IcloudFolderPlugin()
}
