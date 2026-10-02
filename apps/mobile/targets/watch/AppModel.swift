import Foundation

/// The watch's state: the merged thread list across environments and which thread is open.
@MainActor
final class AppModel: ObservableObject {
  static let shared = AppModel()

  @Published private(set) var rows: [GlanceRow]
  @Published private(set) var unreachable: [String] = []
  @Published private(set) var listError: String?
  @Published private(set) var isLoading = false
  @Published var path: [ThreadRef] = []

  private static let cacheKey = "t3.glance.rows"

  private init() {
    // Show the last known list right away; a refresh replaces it.
    rows = UserDefaults.standard.data(forKey: Self.cacheKey)
      .flatMap { try? JSONDecoder().decode([GlanceRow].self, from: $0) } ?? []
  }

  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      let reply = try await PhoneLink.shared.request(["op": "list"])
      let data = reply["threads"] as? Data ?? Data("[]".utf8)
      rows = Self.ordered(try JSONDecoder().decode([GlanceRow].self, from: data))
      unreachable = reply["unreachable"] as? [String] ?? []
      listError = nil
      UserDefaults.standard.set(data, forKey: Self.cacheKey)
    } catch {
      listError = error.localizedDescription
    }
  }

  /// Opens a thread, for example from a tapped notification.
  func open(_ thread: ThreadRef) {
    path = [thread]
  }

  /// Each server orders its own list; merged lists need the same order across environments.
  private static func ordered(_ rows: [GlanceRow]) -> [GlanceRow] {
    func rank(_ phase: AgentPhase) -> Int {
      switch phase {
      case .waitingForApproval, .waitingForInput: return 0
      case .failed: return 1
      case .starting, .running: return 2
      default: return 3
      }
    }
    return rows.sorted { left, right in
      let leftRank = rank(left.agentPhase)
      let rightRank = rank(right.agentPhase)
      return leftRank != rightRank ? leftRank < rightRank : left.updatedAt > right.updatedAt
    }
  }
}
