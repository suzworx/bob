import BobKit
import SwiftUI

// A shared conversation is the one chat view, set up for more than one person. The dock leaves so the composer has the bottom of the screen.
private struct RoomChrome: ViewModifier {
    @Environment(ShellStore.self) private var shell

    func body(content: Content) -> some View {
        content
            .onAppear { shell.setDockHidden(true) }
            .onDisappear { shell.setDockHidden(false) }
    }
}

// A space's thread.
struct ThreadScreen: View {
    let store: ProductivityStore

    private let threadID: String
    private let spaceID: String
    @State private var chat: ChatViewModel
    @State private var thread: SpaceThread?
    @State private var space: SpaceSummary?
    @State private var me: String?
    @State private var renaming = false
    @State private var archiving = false
    @State private var message: String?
    @Environment(\.dismiss) private var dismiss

    init(threadID: String, spaceID: String, store: ProductivityStore) {
        self.store = store
        self.threadID = threadID
        self.spaceID = spaceID
        _chat = State(initialValue: ChatViewModel(room: ChatRoom(threadID: threadID, spaceID: spaceID, title: nil, requireMention: false, threads: store.shared.threads, spaces: store.shared.spaces)))
    }

    private var canArchive: Bool {
        guard let thread, let space else { return false }
        return SpaceRules.canArchive(thread: thread, in: space, me: me)
    }

    var body: some View {
        ChatView(model: chat)
            .bobNavTitle(thread?.title ?? "Thread")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Rename") { renaming = true }
                        Button("People") { store.path.append(ProductivityRoute.members(spaceID: spaceID)) }
                        if canArchive {
                            Button("Archive", role: .destructive) { archiving = true }
                        }
                    } label: {
                        Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Thread actions")
                }
            }
            .modifier(RoomChrome())
            .task {
                thread = try? await store.shared.threads.thread(id: threadID)
                space = try? await store.shared.spaces.space(id: spaceID)
                me = try? await store.shared.spaces.selfUserID()
                await store.spaces.refresh()
            }
            .sheet(isPresented: $renaming) {
                BobNameSheet(title: "Rename thread", label: "Thread title", limit: SpaceRules.threadTitleLimit, initial: thread?.title ?? "") { title in
                    thread = try await store.shared.threads.rename(threadID: threadID, title: title)
                }
                .bobSheet()
            }
            .confirmationDialog("Archive this thread?", isPresented: $archiving, titleVisibility: .visible) {
                Button("Archive", role: .destructive) {
                    Task {
                        do {
                            _ = try await store.shared.threads.archive(threadID: threadID)
                            dismiss()
                        } catch {
                            message = productivityMessage(error)
                        }
                    }
                }
                Button("Keep it", role: .cancel) {}
            } message: {
                Text("It leaves the list for everyone in the space.")
            }
            .bobErrorAlert(message) { message = nil }
    }
}

// A chat shared with people, outside any space. Only @Bob brings Bob in.
struct GroupChatScreen: View {
    let store: ProductivityStore
    let chatID: String

    @State private var chat: GroupChat?
    @State private var phase: LoadPhase = .loading

    var body: some View {
        Group {
            if let chat {
                GroupChatRoom(chat: chat, store: store, onRenamed: { self.chat?.title = $0 })
            } else if case .failed(let error) = phase {
                BobLoadFailure(title: "This chat isn't available", error: error) { await load() }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .bobPage()
                    .bobNavTitle("Chat")
            } else {
                ProgressView()
                    .accessibilityLabel("Opening chat")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .bobPage()
                    .bobNavTitle("Chat")
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            chat = try await store.shared.groupChats.chat(id: chatID)
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            phase = .failed(apiError(error))
        }
    }
}

private struct GroupChatRoom: View {
    let chat: GroupChat
    let store: ProductivityStore
    let onRenamed: (String) -> Void

    @State private var model: ChatViewModel
    @State private var showingPeople = false
    @Environment(\.dismiss) private var dismiss

    init(chat: GroupChat, store: ProductivityStore, onRenamed: @escaping (String) -> Void) {
        self.chat = chat
        self.store = store
        self.onRenamed = onRenamed
        _model = State(initialValue: ChatViewModel(room: ChatRoom(threadID: chat.id, spaceID: chat.spaceID, title: chat.title, requireMention: true, threads: store.shared.threads, spaces: store.shared.spaces)))
    }

    var body: some View {
        ChatView(model: model)
            .bobNavTitle(chat.title)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showingPeople = true } label: {
                        Image(systemName: "person.2").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("People")
                }
            }
            .modifier(RoomChrome())
            .sheet(isPresented: $showingPeople) {
                GroupPeopleSheet(chat: chat, store: store, onRenamed: onRenamed, onLeft: {
                    store.chats.removed(chat.id)
                    dismiss()
                })
                .bobSheet()
            }
    }
}

// Who's in a shared chat and how others get in, as on the web's People dialog.
private struct GroupPeopleSheet: View {
    let chat: GroupChat
    let store: ProductivityStore
    let onRenamed: (String) -> Void
    let onLeft: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var members: [GroupChatMember] = []
    @State private var me: String?
    @State private var title: String
    @State private var email = ""
    @State private var link: String?
    @State private var busy = false
    @State private var notice: String?
    @State private var leaving: GroupChatMember?

    init(chat: GroupChat, store: ProductivityStore, onRenamed: @escaping (String) -> Void, onLeft: @escaping () -> Void) {
        self.chat = chat
        self.store = store
        self.onRenamed = onRenamed
        self.onLeft = onLeft
        _title = State(initialValue: chat.title)
    }

    private var service: GroupChatsService { store.shared.groupChats }
    private var isOwner: Bool { members.first { $0.userID == me }?.role == .owner }
    private var canSaveName: Bool {
        guard let clean = SpaceRules.cleanName(title, limit: SpaceRules.threadTitleLimit) else { return false }
        return clean != chat.title
    }

    var body: some View {
        NavigationStack {
            List {
                if let notice {
                    Text(notice).font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
                }
                if isOwner { nameSection }
                inviteSection
                linkSection
                BobGroupHeader(title: "Participants, \(members.count)")
                ForEach(members) { member in row(member) }
            }
            .bobList()
            .privacySensitive()
            .bobNavTitle("People")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await load() }
            .confirmationDialog(leaving?.userID == me ? "Leave this chat?" : "Remove this participant?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible, presenting: leaving) { member in
                Button(member.userID == me ? "Leave chat" : "Remove", role: .destructive) { remove(member) }
                Button("Cancel", role: .cancel) {}
            } message: { member in
                Text(member.userID == me
                    ? "You will need a fresh invitation to return. If you own it, ownership passes to the longest-standing participant; an empty chat closes."
                    : "They will lose access and need a fresh invitation to return.")
            }
        }
    }

    private var nameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            BobField(label: "Chat name") {
                TextField("Chat name", text: $title)
            }
            Button("Save name") { perform("Chat name saved.") {
                let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
                _ = try await store.shared.threads.rename(threadID: chat.id, title: clean)
                onRenamed(clean)
                await store.chats.refresh()
            } }
            .buttonStyle(BobSecondaryButtonStyle())
            .disabled(busy || !canSaveName)
        }
        .bobListRow(divider: false)
    }

    private var inviteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            BobField(label: "Invite by email") {
                TextField("Email", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Text("Anyone with a working link can join and read the chat's earlier messages. Nothing is sent automatically.")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
            Button("Send invitation") { perform("Invitation sent. They can choose whether to join.") {
                try await service.invite(chatID: chat.id, email: email.trimmingCharacters(in: .whitespacesAndNewlines))
                email = ""
            } }
            .buttonStyle(BobSecondaryButtonStyle())
            .disabled(busy || !SpaceRules.isValidEmail(email))
        }
        .bobListRow(divider: false)
    }

    private var linkSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let link {
                BobInviteLinkRow(link: link, intro: "Share this link with people you want to invite. It works for seven days.")
            }
            Button(link == nil ? "Create invite link" : "Create another link") { perform(nil) {
                let created = try await service.createLink(chatID: chat.id)
                link = InvitationCode.groupChatLink(token: created.token, base: store.shared.linkBase)
            } }
            .buttonStyle(BobSecondaryButtonStyle())
            .disabled(busy)
            if isOwner {
                Button("Disable invite links") { perform("All invite links are disabled. You can create a fresh one.") {
                    try await service.disableLinks(chatID: chat.id)
                    link = nil
                } }
                .buttonStyle(BobSecondaryButtonStyle())
                .disabled(busy)
            }
        }
        .bobListRow(divider: false)
    }

    private func row(_ member: GroupChatMember) -> some View {
        let name = SpaceRules.name(displayName: member.displayName)
        return HStack {
            Text(name + (member.role == .owner ? " (owner)" : "")).font(BobFont.rowTitle)
            Spacer(minLength: 8)
            if isOwner || member.userID == me {
                Button(member.userID == me ? "Leave" : "Remove") { leaving = member }
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
                    .accessibilityLabel(member.userID == me ? "Leave chat" : "Remove \(name)")
                    .disabled(busy)
            }
        }
        .bobListRow()
    }

    private func load() async {
        me = try? await store.shared.spaces.selfUserID()
        do {
            members = try await service.members(chatID: chat.id)
        } catch where isCancelled(error) {
            return
        } catch {
            notice = "Couldn't load participants. Close this and try again."
        }
    }

    private func perform(_ success: String?, _ work: @escaping () async throws -> Void) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await work()
                notice = success
            } catch {
                notice = productivityMessage(error) ?? "Couldn't finish that. Please try again."
            }
        }
    }

    private func remove(_ member: GroupChatMember) {
        perform(nil) {
            try await service.removeMember(chatID: chat.id, userID: member.userID)
            if member.userID == me {
                dismiss()
                onLeft()
            } else {
                members = try await service.members(chatID: chat.id)
            }
        }
    }
}

// Every shared chat the person is in.
struct GroupChatsView: View {
    let store: ProductivityStore
    var onOpen: ((String) -> Void)? = nil

    @State private var confirmingNew = false
    @State private var joining = false
    @State private var creating = false

    private var model: GroupChatsModel { store.chats }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading group chats")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load group chats", error: error) { await model.refresh() }
                    .bobListRow(divider: false)
            case .loaded:
                if model.chats.isEmpty {
                    ContentUnavailableView {
                        Text("No group chats yet").font(BobFont.heading)
                    } description: {
                        Text("Start a chat with Bob and other people, or join one with an invitation.")
                    } actions: {
                        Button("Start a chat") { confirmingNew = true }.buttonStyle(BobSecondaryButtonStyle())
                    }
                    .bobListRow(divider: false)
                }
                ForEach(model.sorted) { chat in
                    Button { open(chat.id) } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(chat.title).font(BobFont.rowTitle)
                                Text(chat.updatedAt, format: .relative(presentation: .named))
                                    .font(BobFont.subline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(BobPressStyle())
                    .bobListRow()
                }
            }
        }
        .bobList()
        .privacySensitive()
        .bobNavTitle("Group chats")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { confirmingNew = true } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New group chat")
                .disabled(creating)
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Join with an invitation") { joining = true }
            }
        }
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .confirmationDialog("Start a group chat?", isPresented: $confirmingNew, titleVisibility: .visible) {
            Button("Create chat") { create() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Start a chat with Bob and other people. Invite them with a link after you create it.")
        }
        .sheet(isPresented: $joining) {
            JoinInvitationSheet(spaces: store.shared.spaces, chats: store.shared.groupChats) { joined in
                switch joined {
                case .space:
                    Task { await store.spaces.refresh() }
                case .chat(let chat):
                    Task { await model.refresh() }
                    open(chat.id)
                }
            }
            .bobSheet()
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private func open(_ id: String) {
        if let onOpen { onOpen(id) }
        else { store.path.append(ProductivityRoute.groupChat(id: id)) }
    }

    private func create() {
        creating = true
        Task {
            defer { creating = false }
            do {
                let chat = try await model.create()
                open(chat.id)
            } catch {
                model.message = productivityMessage(error)
            }
        }
    }
}

// Sharing a private chat with people makes a copy; the original stays as it is.
struct AddPeopleSheet: View {
    let conversationID: String?
    let model: GroupChatsModel
    let onCreated: (GroupChat) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var unsupported = false
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(conversationID == nil
                        ? "Start a chat with Bob and other people. Invite them with a link after you create it."
                        : "Create a copy to chat with other people. Everyone who joins can read the copied history, including personal details in replies. Your original stays private and continues independently.")
                        .font(BobFont.body)
                    if unsupported {
                        Text("Some messages contain attachments or other content that cannot be shared yet. You can copy text only; attachments and tool details will be left out.")
                            .font(BobFont.subline)
                            .foregroundStyle(BobColor.warnText)
                    }
                    if let failed {
                        Text(failed).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    Button(action: create) {
                        if busy {
                            ProgressView().accessibilityLabel("Creating the chat")
                        } else {
                            Text(unsupported ? "Copy text only" : "Create chat")
                        }
                    }
                    .buttonStyle(BobPrimaryButtonStyle())
                    .disabled(busy)
                }
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.top, 12)
            }
            .bobPage()
            .bobNavTitle("Add people")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
            }
        }
        .onDisappear { model.forgetRequest() }
    }

    private func create() {
        busy = true
        failed = nil
        let textOnly = unsupported
        Task {
            defer { busy = false }
            do {
                let chat = try await model.create(sourceConversationID: conversationID, textOnly: textOnly)
                dismiss()
                onCreated(chat)
            } catch ApiError.conflict(code: "unsupported_history") {
                unsupported = true
            } catch {
                failed = productivityMessage(error) ?? "We couldn't create the chat. Please try again."
            }
        }
    }
}
