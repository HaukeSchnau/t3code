import SwiftUI

/// Threads across every saved environment: what needs you first, then work in flight, then
/// recently finished work.
struct ThreadListView: View {
  @EnvironmentObject private var model: AppModel

  private var sections: [(title: String, rows: [GlanceRow])] {
    let groups: [(String, (AgentPhase) -> Bool)] = [
      ("Needs you", { $0.needsUser }),
      ("Failed", { $0 == .failed }),
      ("Working", { $0 == .starting || $0 == .running }),
      ("Recent", { $0 == .completed || $0 == .stale }),
    ]
    return groups.compactMap { title, matches in
      let rows = model.rows.filter { matches($0.agentPhase) }
      return rows.isEmpty ? nil : (title, rows)
    }
  }

  private var showsEnvironment: Bool {
    Set(model.rows.map(\.environmentId)).count > 1
  }

  var body: some View {
    NavigationStack(path: $model.path) {
      List {
        if let error = model.listError {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        if !model.unreachable.isEmpty {
          Text("Offline: \(model.unreachable.joined(separator: ", "))")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        ForEach(sections, id: \.title) { section in
          Section(section.title) {
            ForEach(section.rows) { row in
              NavigationLink(value: row.ref) {
                ThreadRowView(row: row, showsEnvironment: showsEnvironment)
              }
            }
          }
        }
        if model.rows.isEmpty && model.listError == nil && !model.isLoading {
          Text("No agents are working right now.")
            .foregroundStyle(.secondary)
        }
        Button {
          Task { await model.refresh() }
        } label: {
          Label(model.isLoading ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
        }
        .disabled(model.isLoading)
      }
      .navigationTitle("T3 Code")
      .navigationDestination(for: ThreadRef.self) { thread in
        ThreadView(thread: thread)
      }
    }
    .task { await model.refresh() }
  }
}

private struct ThreadRowView: View {
  let row: GlanceRow
  let showsEnvironment: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(row.threadTitle)
        .font(.headline)
        .lineLimit(2)
      HStack(spacing: 4) {
        Text(row.agentPhase.label)
          .foregroundStyle(row.agentPhase.tint)
        Text(showsEnvironment ? (row.environmentLabel ?? row.projectTitle) : row.projectTitle)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      .font(.footnote)
    }
  }
}
