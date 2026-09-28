import ExpoModulesCore
import ExpoNotifications
import UIKit

/// Registers the agent notification categories and routes their Reply actions to
/// AgentReplyHandler. Runs on every launch, including the background launch iOS performs for a
/// notification action, before React starts.
public class AgentNotificationsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    AgentReplyHandler.registerCategories()
    NotificationCenterManager.shared.addDelegate(AgentReplyHandler.shared)
    return true
  }
}
