import ExpoModulesCore
import ExpoNotifications
import UIKit

/// Registers the agent notification categories, routes their Reply actions to AgentReplyHandler,
/// and starts answering the watch app. Runs on every launch, including the background launches
/// iOS performs for a notification action or a watch request, before React starts.
public class AgentNotificationsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    AgentReplyHandler.registerCategories()
    NotificationCenterManager.shared.addDelegate(AgentReplyHandler.shared)
    WatchBridge.shared.activate()
    return true
  }
}
