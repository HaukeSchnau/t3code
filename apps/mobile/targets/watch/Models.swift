import SwiftUI

/// Identifies a thread across environments.
struct ThreadRef: Hashable, Codable {
  let environmentId: String
  let threadId: String
}

/// What an agent is doing, as the server's awareness projection reports it.
enum AgentPhase: String {
  case starting, running, completed, failed, stale
  case waitingForApproval = "waiting_for_approval"
  case waitingForInput = "waiting_for_input"

  init(serverValue: String?) {
    self = serverValue.flatMap(AgentPhase.init(rawValue:)) ?? .stale
  }

  var label: String {
    switch self {
    case .starting: return "Connecting"
    case .running: return "Working"
    case .waitingForApproval: return "Approval"
    case .waitingForInput: return "Question"
    case .completed: return "Done"
    case .failed: return "Failed"
    case .stale: return "Waiting"
    }
  }

  // The Live Activity's dark-scheme tints (src/widgets/AgentActivity.tsx).
  var tint: Color {
    switch self {
    case .waitingForApproval: return Color(red: 0.99, green: 0.83, blue: 0.30)
    case .waitingForInput: return Color(red: 0.65, green: 0.71, blue: 0.99)
    case .failed: return Color(red: 0.99, green: 0.65, blue: 0.65)
    case .completed: return Color(red: 0.43, green: 0.91, blue: 0.72)
    case .starting, .running: return Color(red: 0.49, green: 0.83, blue: 0.99)
    case .stale: return .secondary
    }
  }

  var needsUser: Bool { self == .waitingForApproval || self == .waitingForInput }
}

/// One row of the thread list, from GET /api/orchestration/glance via the phone.
struct GlanceRow: Decodable, Identifiable, Hashable {
  let environmentId: String
  let threadId: String
  let projectTitle: String
  let threadTitle: String
  let phase: String
  let updatedAt: String
  let environmentLabel: String?

  var id: String { "\(environmentId)/\(threadId)" }
  var ref: ThreadRef { ThreadRef(environmentId: environmentId, threadId: threadId) }
  var agentPhase: AgentPhase { AgentPhase(serverValue: phase) }
}

/// One thread for the thread card, from GET /api/orchestration/threads/:threadId/glance.
struct Glance: Decodable {
  struct Question: Decodable {
    let text: String
    let options: [String]
    let allowsFreeText: Bool
  }

  let environmentId: String
  let threadId: String
  let projectTitle: String
  let threadTitle: String
  let modelTitle: String
  let phase: String?
  let excerpt: String?
  let question: Question?
  let canStop: Bool

  var agentPhase: AgentPhase? { phase.map { AgentPhase(serverValue: $0) } }
}

/// Canned follow-ups for a finished or working agent, tapped instead of dictated.
enum QuickReplies {
  static let all = [
    "Yes, continue",
    "Looks good, commit it",
    "Stop and summarize",
    "Run the tests first",
  ]
}
