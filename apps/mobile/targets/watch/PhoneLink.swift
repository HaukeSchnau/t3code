import Foundation
import WatchConnectivity

/// Sends requests to the iPhone app, which calls the T3 Code servers for the watch. The phone side
/// is modules/t3-agent-notifications/ios/WatchBridge.swift; the message keys must match.
final class PhoneLink: NSObject, WCSessionDelegate, @unchecked Sendable {
  static let shared = PhoneLink()

  enum LinkError: LocalizedError {
    case unreachable
    case failed(String)

    var errorDescription: String? {
      switch self {
      case .unreachable: return "Can't reach your iPhone."
      case .failed(let message): return message
      }
    }
  }

  /// How a reply left the watch.
  enum ReplyOutcome {
    case sent
    // The phone was out of reach, so WatchConnectivity holds the reply until it's back.
    case queued
  }

  private let lock = NSLock()
  private var activationWaiters: [CheckedContinuation<Void, Never>] = []

  func activate() {
    guard WCSession.isSupported() else { return }
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    lock.lock()
    let waiters = activationWaiters
    activationWaiters = []
    lock.unlock()
    waiters.forEach { $0.resume() }
  }

  /// One request to the phone. Throws the phone's error message, or `unreachable`.
  func request(_ message: [String: Any]) async throws -> [String: Any] {
    await waitForActivation()
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else {
      throw LinkError.unreachable
    }
    return try await withCheckedThrowingContinuation { continuation in
      session.sendMessage(
        message,
        replyHandler: { reply in
          if let error = reply["error"] as? String {
            continuation.resume(throwing: LinkError.failed(error))
          } else {
            continuation.resume(returning: reply)
          }
        },
        errorHandler: { _ in continuation.resume(throwing: LinkError.unreachable) }
      )
    }
  }

  /// Sends a reply. If the phone is out of reach the reply queues instead of getting lost; the
  /// phone sends it later and posts "Reply not delivered" if that fails.
  func sendReply(to thread: ThreadRef, replyId: String, text: String) async throws -> ReplyOutcome {
    let message: [String: Any] = [
      "op": "reply",
      "environmentId": thread.environmentId,
      "threadId": thread.threadId,
      "replyId": replyId,
      "replyText": text,
    ]
    do {
      _ = try await request(message)
      return .sent
    } catch LinkError.unreachable {
      guard WCSession.default.activationState == .activated else { throw LinkError.unreachable }
      WCSession.default.transferUserInfo(message)
      return .queued
    }
  }

  private func waitForActivation() async {
    guard WCSession.isSupported() else { return }
    if WCSession.default.activationState == .activated { return }
    await withCheckedContinuation { continuation in
      lock.lock()
      if WCSession.default.activationState == .activated {
        lock.unlock()
        continuation.resume()
        return
      }
      activationWaiters.append(continuation)
      lock.unlock()
    }
  }
}
