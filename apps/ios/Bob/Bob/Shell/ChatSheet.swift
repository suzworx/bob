import BobKit
import SwiftUI

private enum ChatSheetRoute: Hashable {
    case history
}

// A conversation is the root. History is an explicit destination; Back returns to the conversation.
struct ChatSheet: View {
    let model: ChatViewModel
    let chats: ConversationListModel
    let groupChats: GroupChatsModel
    let openHomeRoute: (ProductivityRoute) -> Void

    @Environment(ShellStore.self) private var store
    @State private var path: [ChatSheetRoute] = []
    @State private var addingPeople = false

    var body: some View {
        NavigationStack(path: $path) {
            ChatView(model: model, onVoice: { store.present(.voice) })
                .bobNavTitle(model.transcript.title ?? "Bob")
                .toolbar {
                    if path.isEmpty {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { store.closeChat() }
                        }
                        ToolbarItem(placement: .primaryAction) {
                            Button { path.append(.history) } label: {
                                Image(systemName: "clock.arrow.circlepath").frame(minWidth: 44, minHeight: 44)
                            }
                            .accessibilityLabel("Chat history")
                        }
                        ToolbarItem(placement: .primaryAction) { conversationMenu }
                    }
                }
                .navigationDestination(for: ChatSheetRoute.self) { _ in
                    ConversationListView(model: chats, chat: model, onOpen: { id in
                        model.open(id)
                        path = []
                    }, onNew: startNewChat, onShared: { openHomeRoute(.groupChats) })
                    .toolbar {
                        ToolbarItem(placement: .primaryAction) { newChatButton }
                    }
                }
        }
        .task(id: store.isVoiceRequested) {
            guard store.isVoiceRequested else { return }
            // Keep the existing presentation pacing, but cancel it when the chat leaves.
            do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
            store.beginRequestedVoice()
        }
        .sheet(isPresented: $addingPeople) {
            AddPeopleSheet(conversationID: model.transcript.conversationID, model: groupChats) { chat in
                openHomeRoute(.groupChat(id: chat.id))
            }
            .bobSheet()
        }
        .fullScreenCover(isPresented: voiceBinding) {
            VoiceMomentView(chat: model, onClose: { store.dismissMoment() })
        }
    }

    // Voice opens from here rather than the shell, so the chat it talks into stays underneath.
    private var voiceBinding: Binding<Bool> {
        Binding(
            get: { store.moment == .voice },
            set: { isOpen in
                if !isOpen { store.dismissMoment() }
            }
        )
    }

    private var newChatButton: some View {
        Button(action: startNewChat) {
            Image(systemName: "square.and.pencil").frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("New chat")
    }

    private var conversationMenu: some View {
        Menu {
            Button(action: startNewChat) { Label("New chat", systemImage: "square.and.pencil") }
            Button { addingPeople = true } label: { Label("Add people", systemImage: "person.badge.plus") }
        } label: {
            Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("Chat actions")
    }

    private func startNewChat() {
        model.newChat()
        path = []
    }
}
