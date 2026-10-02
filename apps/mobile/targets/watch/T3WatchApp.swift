import SwiftUI
import UserNotifications
import WatchKit

@main
struct T3WatchApp: App {
  @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ThreadListView()
        .environmentObject(AppModel.shared)
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        Task { await AppModel.shared.refresh() }
      }
    }
  }
}

/// Connects to the phone and handles agent notifications that reach the watch app.
final class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
  func applicationDidFinishLaunching() {
    PhoneLink.shared.activate()
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    // The same categories the iPhone registers (AgentReplyHandler.swift). Once this app is
    // installed, the watch may deliver a mirrored notification's actions here instead of to the
    // phone, so this app handles them too.
    let reply = { (identifier: String, title: String, placeholder: String) in
      UNNotificationCategory(
        identifier: identifier,
        actions: [
          UNTextInputNotificationAction(
            identifier: "AGENT_REPLY",
            title: title,
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: placeholder
          )
        ],
        intentIdentifiers: [],
        options: []
      )
    }
    center.setNotificationCategories([
      reply("AGENT_INPUT", "Answer", "Your answer"),
      reply("AGENT_DONE", "Reply", "What should the agent do next?"),
      UNNotificationCategory(
        identifier: "AGENT_NOT_DELIVERED",
        actions: [UNNotificationAction(identifier: "AGENT_RETRY", title: "Retry", options: [])],
        intentIdentifiers: [],
        options: []
      ),
    ])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    let info = response.notification.request.content.userInfo
    guard
      let environmentId = info["environmentId"] as? String,
      let threadId = info["threadId"] as? String
    else { return }
    let thread = ThreadRef(environmentId: environmentId, threadId: threadId)
    switch response.actionIdentifier {
    case "AGENT_REPLY":
      guard let text = (response as? UNTextInputNotificationResponse)?.userText else { return }
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return }
      // The notification's id is the reply id, matching what the phone would have used.
      _ = try? await PhoneLink.shared.sendReply(
        to: thread,
        replyId: response.notification.request.identifier,
        text: trimmed
      )
    case "AGENT_RETRY":
      guard
        let replyId = info["replyId"] as? String,
        let text = info["replyText"] as? String
      else { return }
      _ = try? await PhoneLink.shared.sendReply(to: thread, replyId: replyId, text: text)
    case UNNotificationDefaultActionIdentifier:
      await MainActor.run { AppModel.shared.open(thread) }
    default:
      break
    }
  }
}
