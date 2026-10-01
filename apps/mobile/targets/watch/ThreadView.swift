import SwiftUI

/// One thread: where the agent stands, its question if the wrist can answer it, and ways to
/// reply or stop. Everything goes through the phone (PhoneLink) to the thread's environment.
struct ThreadView: View {
  let thread: ThreadRef

  @State private var glance: Glance?
  @State private var loadError: String?
  @State private var status: String?
  @State private var isSending = false
  @State private var replyText = ""
  @State private var confirmStop = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        if let glance {
          header(glance)
          actions(glance)
          if let status {
            Text(status)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        } else if let loadError {
          Text(loadError)
            .foregroundStyle(.secondary)
          Button("Try again") { Task { await load() } }
        } else {
          ProgressView()
        }
      }
    }
    .navigationTitle(glance?.projectTitle ?? "Thread")
    .task { await load() }
    .confirmationDialog("Stop the agent?", isPresented: $confirmStop) {
      Button("Stop", role: .destructive) { Task { await stop() } }
    }
  }

  @ViewBuilder
  private func header(_ glance: Glance) -> some View {
    Text(glance.threadTitle)
      .font(.headline)
    if let phase = glance.agentPhase {
      Text(phase.label)
        .font(.footnote)
        .foregroundStyle(phase.tint)
    }
    if let excerpt = glance.excerpt {
      Text(excerpt)
        .font(.footnote)
    }
  }

  @ViewBuilder
  private func actions(_ glance: Glance) -> some View {
    let phase = glance.agentPhase
    if let question = glance.question {
      Text(question.text)
        .font(.body.weight(.semibold))
      ForEach(question.options, id: \.self) { option in
        Button(option) { Task { await send(option) } }
          .disabled(isSending)
      }
      if question.allowsFreeText {
        replyField(placeholder: "Your answer")
      }
    } else if phase == .waitingForInput {
      Text("This question needs your iPhone.")
        .foregroundStyle(.secondary)
    } else if phase == .waitingForApproval {
      Text("Approve or deny this on your iPhone.")
        .foregroundStyle(.secondary)
    } else {
      replyField(placeholder: "Tell the agent")
      ForEach(QuickReplies.all, id: \.self) { text in
        Button(text) { Task { await send(text) } }
          .disabled(isSending)
      }
    }
    if glance.canStop {
      Button("Stop", role: .destructive) { confirmStop = true }
        .disabled(isSending)
    }
  }

  private func replyField(placeholder: String) -> some View {
    TextField(placeholder, text: $replyText)
      .submitLabel(.send)
      .onSubmit {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        replyText = ""
        Task { await send(text) }
      }
  }

  private func load() async {
    do {
      let reply = try await PhoneLink.shared.request([
        "op": "thread",
        "environmentId": thread.environmentId,
        "threadId": thread.threadId,
      ])
      guard let data = reply["glance"] as? Data else { throw PhoneLink.LinkError.unreachable }
      glance = try JSONDecoder().decode(Glance.self, from: data)
      loadError = nil
    } catch {
      loadError = error.localizedDescription
    }
  }

  private func send(_ text: String) async {
    isSending = true
    defer { isSending = false }
    do {
      switch try await PhoneLink.shared.sendReply(
        to: thread,
        replyId: UUID().uuidString,
        text: text
      ) {
      case .sent:
        status = "Sent."
        await load()
      case .queued:
        status = "Your iPhone is out of reach. This sends when it's back."
      }
    } catch {
      status = error.localizedDescription
    }
  }

  private func stop() async {
    isSending = true
    defer { isSending = false }
    do {
      _ = try await PhoneLink.shared.request([
        "op": "stop",
        "environmentId": thread.environmentId,
        "threadId": thread.threadId,
      ])
      status = "Stopped."
      await load()
    } catch {
      status = error.localizedDescription
    }
  }
}
