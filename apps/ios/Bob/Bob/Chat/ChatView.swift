import BobKit
import SwiftUI
import UIKit

// The Chat screen: the conversation, newest at the bottom, above the composer.
struct ChatView: View {
    let model: ChatViewModel
    var onVoice: (() -> Void)?
    @State private var audio: ChatAudioModel

    init(model: ChatViewModel, onVoice: (() -> Void)? = nil) {
        self.model = model
        self.onVoice = onVoice
        _audio = State(initialValue: ChatAudioModel(chat: model, service: VoiceServiceFactory.make().service))
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var editing: ChatMessage?
    @State private var deletingFrom: ChatMessage?
    @State private var selecting: ChatMessage?
    @ScaledMetric(relativeTo: .subheadline) private var messageSpacing: CGFloat = 10
    @ScaledMetric(relativeTo: .subheadline) private var listVerticalPadding: CGFloat = 12
    // Fixed so large text keeps the screen width for the words.
    private let pageMargin: CGFloat = 16

    var body: some View {
        VStack(spacing: 0) {
            Label(model.room == nil ? "Just you and Bob" : "Shared with this conversation’s members", systemImage: model.room == nil ? "lock" : "person.2")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, pageMargin)
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
            switch model.openPhase {
            case .opening:
                ProgressView()
                    .accessibilityLabel("Opening chat")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(_, let error):
                BobLoadFailure(title: "Couldn't open this chat", error: error) { model.retryOpen() }
                    .frame(maxHeight: .infinity)
            case .ready:
                if model.transcript.messages.isEmpty {
                    emptyState
                } else {
                    messageList
                }
                notices
            }
            ChatComposer(model: model, onVoice: onVoice.map { action in
                { audio.cancelAll(); action() }
            }, audio: audio)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .bobPage()
        .privacySensitive()
        .task(id: model.followKey) {
            if model.followKey != nil { await model.followUnanswered() }
        }
        .task(id: model.room?.threadID) {
            if model.room != nil { await model.followRoom() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.syncFromServer() } }
            else { audio.sceneLeft(background: phase == .background) }
        }
        .onDisappear { audio.cancelAll() }
        .onChange(of: model.composerContext) { _, _ in audio.cancelAll() }
        .onChange(of: ObjectIdentifier(model)) { _, _ in
            audio.cancelAll()
            audio = ChatAudioModel(chat: model, service: VoiceServiceFactory.make().service)
        }
        .sheet(item: $editing) { message in
            MessageEditSheet(original: message.text, resendsToBob: model.room == nil) { model.edit(message, text: $0) }.bobSheet()
        }
        .sheet(item: $selecting) { message in
            ChatSelectTextSheet(text: message.text).bobSheet()
        }
        .alert(
            model.room == nil ? "Delete from here?" : "Delete this message?",
            isPresented: Binding(get: { deletingFrom != nil }, set: { if !$0 { deletingFrom = nil } }),
            presenting: deletingFrom
        ) { message in
            Button(model.room == nil ? "Delete messages" : "Delete message", role: .destructive) { Task { await model.deleteFrom(message) } }
            Button(model.room == nil ? "Keep them" : "Keep it", role: .cancel) {}
        } message: { _ in
            Text(model.room == nil
                ? "This message and everything after it will be permanently deleted. Memories already saved from them are kept."
                : "Everyone in the conversation will see that a message was deleted. Replies after it stay.")
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    // What's wrong with the chat as a whole, just above the composer.
    @ViewBuilder private var notices: some View {
        if let notice = model.notice {
            noticeRow(notice, action: "OK") { model.notice = nil }
        }
        if model.room == nil, model.isIdle, model.transcript.isUnanswered {
            noticeRow("No reply was received for your last message.", action: "Try again") { model.regenerate() }
        }
        if model.saveFailed {
            noticeRow("The reply could not be saved.", action: "Dismiss") { model.dismissSaveFailed() }
        }
    }

    private func noticeRow(_ text: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            Text(text)
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action, action: perform)
                .font(BobFont.caption)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .buttonStyle(BobPressStyle())
        }
        .padding(.horizontal, pageMargin)
    }

    @ViewBuilder private var emptyState: some View {
        if model.room == nil {
            bobEmptyState
        } else {
            ContentUnavailableView {
                Text("No messages yet").font(BobFont.heading)
            } description: {
                Text(model.room?.requireMention == true ? "Anyone in this chat can start it. Post the first message below. Say @Bob to bring Bob in." : "Anyone in this space can start it. Post the first message below. Say @Bob to bring Bob in.")
            }
            .frame(maxHeight: .infinity)
        }
    }

    // Bob speaks first; tapping a line answers him.
    private var bobEmptyState: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 16)
            VStack(spacing: 12) {
                Image("BobPlayful")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 96, height: 96)
                    .accessibilityHidden(true)
                Text("What can I take off your plate?")
                    .font(BobFont.heading)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, pageMargin)
            Spacer(minLength: 16)
            ForEach(Self.suggestions, id: \.self) { suggestion in
                Button {
                    audio.cancelAll()
                    model.send(suggestion: suggestion)
                } label: {
                    Text(suggestion)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .padding(.horizontal, pageMargin)
                BobDivider().padding(.leading, pageMargin)
            }
        }
    }

    private static let suggestions = ["Plan my evening", "Remind me to call home", "Tell me something fun"]

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: messageSpacing) {
                    ForEach(model.transcript.messages) { message in
                        VStack(alignment: message.isMine ? .trailing : .leading, spacing: 0) {
                            ChatMessageRow(
                                message: message,
                                failureMessage: model.transcript.failureMessage,
                                handles: model.room == nil ? nil : model.roomHandles,
                                onRetry: { model.retry() }
                            )
                            .contextMenu { actions(for: message) }
                            // The same actions in plain sight on the newest of each, which long-press alone would hide.
                            if model.isIdle, isNewestOfItsKind(message), hasText(message) {
                                HStack(spacing: 0) {
                                    if message.role == .bob, message.state != .streaming {
                                        Button { audio.read(message) } label: {
                                            Image(systemName: "speaker.wave.2")
                                                .frame(width: 44, height: 44)
                                        }
                                        .accessibilityLabel("Read Bob's reply aloud")
                                        .disabled(audio.isDictating)
                                    }
                                    if message.traceID != nil {
                                        ChatFeedbackButtons(
                                            rating: message.feedback,
                                            isEnabled: model.canRate(message),
                                            onRate: { model.rate(message, positive: $0) }
                                        )
                                    }
                                    Menu {
                                        actions(for: message)
                                    } label: {
                                        Image(systemName: "ellipsis")
                                            .foregroundStyle(.secondary)
                                            .frame(width: 44, height: 44)
                                            .contentShape(Rectangle())
                                    }
                                    .accessibilityLabel(actionsLabel(message))
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: message.isMine ? .trailing : .leading)
                        .id(message.id)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: model.transcript.messages.count)
                .padding(.horizontal, pageMargin)
                .padding(.vertical, listVerticalPadding)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.syncFromServer() }
            .onAppear {
                scrollToNewest(proxy, animated: false)
            }
            .onChange(of: model.transcript.messages.count) {
                scrollToNewest(proxy, animated: true)
            }
            .onChange(of: model.transcript.messages.last?.id) {
                scrollToNewest(proxy, animated: false)
            }
            .onChange(of: model.transcript.messages.last?.parts) {
                scrollToNewest(proxy, animated: false)
            }
            .onChange(of: model.transcript.failureMessage) {
                scrollToNewest(proxy, animated: true)
            }
            // The list just got shorter: the newest message stays in sight.
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                scrollToNewest(proxy, animated: true)
            }
        }
    }

    private func hasText(_ message: ChatMessage) -> Bool {
        !message.text.isEmpty
    }

    private func isNewestOfItsKind(_ message: ChatMessage) -> Bool {
        model.hasVisibleActions(message)
    }

    private func actionsLabel(_ message: ChatMessage) -> String {
        if message.isMine { return "Actions for your message" }
        if message.role == .bob { return "Actions for Bob's reply" }
        return "Actions for \(message.author?.name ?? "this")'s message"
    }

    @ViewBuilder private func actions(for message: ChatMessage) -> some View {
        if hasText(message) {
            Button("Copy") { UIPasteboard.general.string = message.text }
            Button("Select text") { selecting = message }
        }
        if message.role == .bob {
            if hasText(message), message.state != .streaming {
                Button("Read aloud", systemImage: "speaker.wave.2") { audio.read(message) }
                    .disabled(audio.isDictating)
            }
            if model.canRate(message) {
                Button("Helpful") { model.rate(message, positive: true) }
                Button("Unhelpful") { model.rate(message, positive: false) }
            }
            // The server can only regenerate the newest reply.
            if model.canRegenerate(message) {
                Button("Regenerate") { model.regenerate() }
            }
        } else {
            if model.canEdit(message) {
                Button("Edit") { editing = message }
            }
            if model.canDeleteFrom(message) {
                Button(model.room == nil ? "Delete from here" : "Delete", role: .destructive) { deletingFrom = message }
            }
        }
    }

    private func scrollToNewest(_ proxy: ScrollViewProxy, animated: Bool) {
        guard let lastID = model.transcript.messages.last?.id else {
            return
        }
        if animated, !reduceMotion {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(lastID, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(lastID, anchor: .bottom)
        }
    }
}

// Changing a message resends it, so it asks for Bob again rather than saving quietly.
private struct MessageEditSheet: View {
    let original: String
    var resendsToBob = true
    let onSend: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var text: String
    @State private var confirmingDiscard = false

    init(original: String, resendsToBob: Bool = true, onSend: @escaping (String) -> Void) {
        self.original = original
        self.resendsToBob = resendsToBob
        self.onSend = onSend
        _text = State(initialValue: original)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    BobField(label: "Your message") {
                        TextField("Your message", text: $text, axis: .vertical)
                            .lineLimit(3...12)
                            .focused($focused)
                    }
                    if resendsToBob {
                        Text("Bob answers again, and everything after this message is deleted.")
                            .font(BobFont.subline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.top, 12)
            }
            .bobPage()
            .privacySensitive()
            .bobNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(title: "Edit message", canSave: !trimmed.isEmpty && trimmed != original, saving: false, onCancel: cancel, onSave: {
                    onSend(trimmed)
                    dismiss()
                })
            }
        }
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .task { focused = true }
    }

    private var dismissalPolicy: EditorDismissalPolicy {
        EditorDismissalPolicy(hasUnsavedChanges: text != original, isSaving: false)
    }

    private func cancel() {
        switch dismissalPolicy.cancelAction {
        case .dismiss: dismiss()
        case .confirmDiscard: confirmingDiscard = true
        case .blocked: break
        }
    }
}

private func seededTranscript(failing: Bool) -> ChatTranscript {
    var transcript = ChatTranscript()
    transcript.beginTurn(userMessageID: "p1", replyMessageID: "b1", text: "Can you remind me to call Sam tomorrow?")
    transcript.apply(.messageStart(messageID: "b1", conversationID: "demo-1", title: "Demo chat"))
    if failing {
        transcript.apply(.textDelta(id: "t1", delta: "Sure"))
        transcript.fail(.upstream)
    } else {
        transcript.apply(.textDelta(id: "t1", delta: "Done! I'll remind you to call Sam tomorrow at 10am."))
        transcript.apply(.finish(conversationID: "demo-1", title: "Demo chat"))
    }
    return transcript
}

#Preview("Empty") {
    ChatView(model: ChatViewModel(service: StubChatService()))
}

#Preview("Finished exchange") {
    ChatView(model: ChatViewModel(service: StubChatService(), transcript: seededTranscript(failing: false)))
}

#Preview("Failing") {
    ChatView(model: ChatViewModel(service: StubChatService(mode: .failing(.upstream)), transcript: seededTranscript(failing: true)))
}
