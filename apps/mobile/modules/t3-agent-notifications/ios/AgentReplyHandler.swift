import ExpoNotifications
import UIKit
import UserNotifications

/// Answers the Reply and Retry actions on agent notifications without starting React.
///
/// The server picks a category per notification (apps/server/src/agentAwareness/ApnsProvider.ts)
/// and decides what the text means at POST /api/orchestration/threads/:threadId/reply. This side
/// only forwards the text, and posts a "Reply not delivered" notification when that fails, so
/// nothing is lost silently. The JS tap router skips these action ids
/// (src/features/agent-awareness/notificationPayload.ts). It keeps no state beyond static
/// constants, which is why the Sendable conformance is unchecked.
final class AgentReplyHandler: NotificationDelegate, @unchecked Sendable {
  static let shared = AgentReplyHandler()

  static let replyAction = "AGENT_REPLY"
  static let retryAction = "AGENT_RETRY"
  private static let notDeliveredCategory = "AGENT_NOT_DELIVERED"

  /// Adds the agent categories to whatever the app registered already.
  static func registerCategories() {
    let center = UNUserNotificationCenter.current()
    let ours: Set<UNNotificationCategory> = [
      replyCategory("AGENT_INPUT", button: "Answer", placeholder: "Your answer"),
      replyCategory("AGENT_DONE", button: "Reply", placeholder: "What should the agent do next?"),
      UNNotificationCategory(
        identifier: notDeliveredCategory,
        actions: [UNNotificationAction(identifier: retryAction, title: "Retry", options: [])],
        intentIdentifiers: [],
        options: []
      ),
    ]
    let ourIdentifiers = Set(ours.map(\.identifier))
    center.getNotificationCategories { existing in
      center.setNotificationCategories(
        existing.filter { !ourIdentifiers.contains($0.identifier) }.union(ours)
      )
    }
  }

  private static func replyCategory(
    _ identifier: String,
    button: String,
    placeholder: String
  ) -> UNNotificationCategory {
    UNNotificationCategory(
      identifier: identifier,
      actions: [
        UNTextInputNotificationAction(
          identifier: replyAction,
          title: button,
          options: [],
          textInputButtonTitle: "Send",
          textInputPlaceholder: placeholder
        )
      ],
      intentIdentifiers: [],
      options: []
    )
  }

  func didReceive(
    _ response: UNNotificationResponse,
    completionHandler: @escaping () -> Void
  ) -> Bool {
    let content = response.notification.request.content
    let reply: AgentReply?
    switch response.actionIdentifier {
    case Self.replyAction:
      reply = (response as? UNTextInputNotificationResponse).flatMap {
        AgentReply(
          notification: content,
          replyId: response.notification.request.identifier,
          text: $0.userText
        )
      }
    case Self.retryAction:
      reply = AgentReply(retry: content.userInfo)
    default:
      return false
    }
    // NotificationCenterManager completes the response after every delegate ran, so the send
    // keeps itself alive with a background task instead.
    if let reply {
      send(reply)
    }
    return true
  }

  private func send(_ reply: AgentReply) {
    let application = UIApplication.shared
    var backgroundTask = UIBackgroundTaskIdentifier.invalid
    let finish = {
      guard backgroundTask != .invalid else { return }
      application.endBackgroundTask(backgroundTask)
      backgroundTask = .invalid
    }
    backgroundTask = application.beginBackgroundTask(
      withName: "T3 agent reply",
      expirationHandler: finish
    )
    AgentReplyClient.send(reply) { failure in
      DispatchQueue.main.async {
        guard let failure else { return finish() }
        Self.postNotDelivered(reply, failure: failure, completion: finish)
      }
    }
  }

  private static func postNotDelivered(
    _ reply: AgentReply,
    failure: AgentReplyFailure,
    completion: @escaping () -> Void
  ) {
    let content = UNMutableNotificationContent()
    content.title = "Reply not delivered"
    if let threadTitle = reply.threadTitle {
      content.subtitle = threadTitle
    }
    content.body = failure.message
    content.sound = .default
    content.userInfo = reply.retryUserInfo
    content.threadIdentifier = "\(reply.environmentId)/\(reply.threadId)"
    if failure.retryable {
      content.categoryIdentifier = notDeliveredCategory
    }
    // One notice per reply: a failed retry replaces the previous one.
    let request = UNNotificationRequest(
      identifier: "t3-reply-\(reply.replyId)",
      content: content,
      trigger: nil
    )
    UNUserNotificationCenter.current().add(request) { _ in
      DispatchQueue.main.async(execute: completion)
    }
  }
}

/// A reply on its way to the environment. The id doubles as the server's idempotency key, so
/// Retry carries the original id along.
struct AgentReply {
  let environmentId: String
  let threadId: String
  let deepLink: String?
  let threadTitle: String?
  let replyId: String
  let text: String

  init?(notification content: UNNotificationContent, replyId: String, text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      !trimmed.isEmpty,
      let environmentId = content.userInfo["environmentId"] as? String,
      let threadId = content.userInfo["threadId"] as? String
    else { return nil }
    self.environmentId = environmentId
    self.threadId = threadId
    self.deepLink = content.userInfo["deepLink"] as? String
    self.threadTitle = content.title.isEmpty ? nil : content.title
    self.replyId = replyId
    self.text = trimmed
  }

  init?(retry userInfo: [AnyHashable: Any]) {
    guard
      let environmentId = userInfo["environmentId"] as? String,
      let threadId = userInfo["threadId"] as? String,
      let replyId = userInfo["replyId"] as? String,
      let text = userInfo["replyText"] as? String
    else { return nil }
    self.environmentId = environmentId
    self.threadId = threadId
    self.deepLink = userInfo["deepLink"] as? String
    self.threadTitle = userInfo["threadTitle"] as? String
    self.replyId = replyId
    self.text = text
  }

  /// The keys the JS tap router reads to open the thread, plus what Retry needs.
  var retryUserInfo: [AnyHashable: Any] {
    var userInfo: [AnyHashable: Any] = [
      "environmentId": environmentId,
      "threadId": threadId,
      "replyId": replyId,
      "replyText": text,
    ]
    userInfo["deepLink"] = deepLink
    userInfo["threadTitle"] = threadTitle
    return userInfo
  }
}

enum AgentReplyFailure: Error {
  case unreachable
  case locked
  case notSetUp
  case switchedOff
  case unauthorized
  case threadGone
  case rejected(reason: String)

  var retryable: Bool {
    switch self {
    case .unreachable, .locked, .notSetUp: return true
    case .switchedOff, .unauthorized, .threadGone, .rejected: return false
    }
  }

  var message: String {
    switch self {
    case .unreachable:
      return "Couldn't reach the environment. Tap Retry when it's back."
    case .locked:
      return "Unlock your iPhone, then tap Retry."
    case .notSetUp:
      return "Open T3 Code once, then tap Retry."
    case .switchedOff:
      return "This environment is switched off in T3 Code."
    case .unauthorized:
      return "This iPhone isn't paired with the environment anymore. Open T3 Code to pair it again."
    case .threadGone:
      return "That thread no longer exists."
    case .rejected(let reason):
      switch reason {
      case "approval_pending":
        return "An approval is waiting. Open T3 Code to answer it."
      case "no_matching_option":
        return "That didn't match any of the options. Open T3 Code to answer."
      default:
        return "This question needs the app. Open T3 Code to answer it."
      }
    }
  }
}

enum AgentReplyClient {
  static func send(_ reply: AgentReply, completion: @escaping (AgentReplyFailure?) -> Void) {
    let connection: AgentReplyConnection
    switch AgentReplyConnections.find(environmentId: reply.environmentId) {
    case .success(let found):
      connection = found
    case .failure(let failure):
      return completion(failure)
    }
    let url = connection.httpBaseUrl
      .appendingPathComponent("api/orchestration/threads")
      .appendingPathComponent(reply.threadId)
      .appendingPathComponent("reply")
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(connection.bearerToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = try? JSONSerialization.data(
      withJSONObject: ["replyId": reply.replyId, "text": reply.text]
    )
    URLSession.shared.dataTask(with: request) { data, response, error in
      guard error == nil, let http = response as? HTTPURLResponse else {
        return completion(.unreachable)
      }
      switch http.statusCode {
      case 200..<300:
        let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        if body?["outcome"] as? String == "rejected" {
          return completion(.rejected(reason: body?["reason"] as? String ?? ""))
        }
        completion(nil)
      case 401, 403:
        completion(.unauthorized)
      case 404:
        completion(.threadGone)
      default:
        completion(.unreachable)
      }
    }.resume()
  }
}
