import UIKit
import WatchConnectivity

/// Answers the Apple Watch app's requests. The watch holds no credentials and can't reach the
/// tailnet on its own, so it asks the phone, which calls each saved environment the same way a
/// notification reply does. Messages are property lists; server JSON travels as Data.
///
/// Requests carry an "op": "list"; "thread" with environmentId and threadId; "reply" with
/// environmentId, threadId, replyId and replyText; "stop" with environmentId and threadId.
/// Failures come back as { "error": message }. The watch side is targets/watch/PhoneLink.swift.
final class WatchBridge: NSObject, WCSessionDelegate, @unchecked Sendable {
  static let shared = WatchBridge()

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  // Pairing a different watch deactivates the session; activate again for the new one.
  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  func session(
    _ session: WCSession,
    didReceiveMessage message: [String: Any],
    replyHandler: @escaping ([String: Any]) -> Void
  ) {
    let finish = Self.beginBackgroundWork()
    handle(message) { reply in
      replyHandler(reply)
      finish()
    }
  }

  // Replies the watch queued while the phone was out of reach. Nobody waits for the answer, so
  // a failure shows up as "Reply not delivered", like a failed notification reply.
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard userInfo["op"] as? String == "reply", let reply = AgentReply(retry: userInfo) else {
      return
    }
    DispatchQueue.main.async { AgentReplyHandler.shared.send(reply) }
  }

  private func handle(_ message: [String: Any], reply: @escaping ([String: Any]) -> Void) {
    switch message["op"] as? String {
    case "list":
      list(reply)
    case "thread":
      thread(message, reply)
    case "reply":
      guard let agentReply = AgentReply(retry: message) else {
        return reply(Self.error("That reply was empty."))
      }
      AgentReplyClient.send(agentReply) { failure in
        reply(failure.map { Self.error($0.message) } ?? ["ok": true])
      }
    case "stop":
      stop(message, reply)
    default:
      reply(Self.error("Update T3 Code on your iPhone to use this watch app."))
    }
  }

  /// Every saved environment's glance list, each row tagged with its environment's label.
  private func list(_ reply: @escaping ([String: Any]) -> Void) {
    let connections: [EnvironmentConnection]
    switch EnvironmentConnections.all() {
    case .success(let found):
      connections = found
    case .failure(let failure):
      return reply(Self.error(failure.message))
    }
    let group = DispatchGroup()
    let lock = NSLock()
    var threads: [[String: Any]] = []
    var unreachable: [String] = []
    for connection in connections {
      group.enter()
      EnvironmentClient.request(
        connection,
        method: "GET",
        path: ["api", "orchestration", "glance"]
      ) { status, data in
        lock.lock()
        defer {
          lock.unlock()
          group.leave()
        }
        guard
          let status, (200..<300).contains(status), let data,
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rows = body["threads"] as? [[String: Any]]
        else {
          unreachable.append(connection.label)
          return
        }
        threads += rows.map { $0.merging(["environmentLabel": connection.label]) { row, _ in row } }
      }
    }
    group.notify(queue: .global()) {
      let data = (try? JSONSerialization.data(withJSONObject: threads)) ?? Data("[]".utf8)
      reply(["threads": data, "unreachable": unreachable])
    }
  }

  private func thread(_ message: [String: Any], _ reply: @escaping ([String: Any]) -> Void) {
    withConnection(message, reply) { connection, threadId in
      EnvironmentClient.request(
        connection,
        method: "GET",
        path: ["api", "orchestration", "threads", threadId, "glance"]
      ) { status, data in
        guard let status, (200..<300).contains(status), let data else {
          return reply(Self.error(EnvironmentClient.failure(for: status).message))
        }
        reply(["glance": data])
      }
    }
  }

  private func stop(_ message: [String: Any], _ reply: @escaping ([String: Any]) -> Void) {
    withConnection(message, reply) { connection, threadId in
      EnvironmentClient.request(
        connection,
        method: "POST",
        path: ["api", "orchestration", "dispatch"],
        body: [
          "type": "thread.turn.interrupt",
          "commandId": "watch-stop:\(UUID().uuidString)",
          "threadId": threadId,
          "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
      ) { status, _ in
        guard let status, (200..<300).contains(status) else {
          return reply(Self.error(EnvironmentClient.failure(for: status).message))
        }
        reply(["ok": true])
      }
    }
  }

  private func withConnection(
    _ message: [String: Any],
    _ reply: @escaping ([String: Any]) -> Void,
    _ run: (EnvironmentConnection, String) -> Void
  ) {
    guard
      let environmentId = message["environmentId"] as? String,
      let threadId = message["threadId"] as? String
    else { return reply(Self.error("The watch didn't say which thread.")) }
    switch EnvironmentConnections.find(environmentId: environmentId) {
    case .success(let connection):
      run(connection, threadId)
    case .failure(let failure):
      reply(Self.error(failure.message))
    }
  }

  private static func error(_ message: String) -> [String: Any] {
    ["error": message]
  }

  /// Keeps the phone app running until the reply goes back, even when the watch woke it.
  private static func beginBackgroundWork() -> () -> Void {
    let application = UIApplication.shared
    let lock = NSLock()
    var task = UIBackgroundTaskIdentifier.invalid
    let end = {
      lock.lock()
      defer { lock.unlock() }
      guard task != .invalid else { return }
      application.endBackgroundTask(task)
      task = .invalid
    }
    let started = application.beginBackgroundTask(withName: "T3 watch request", expirationHandler: end)
    lock.lock()
    task = started
    lock.unlock()
    return end
  }
}
