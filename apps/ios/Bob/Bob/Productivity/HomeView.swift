import BobKit
import SwiftUI

// The Spaces tab keeps shared places together; feature routes retain their existing state.
struct HomeView: View {
    @Bindable var store: ProductivityStore
    var chat = ChatRouting()
    var notifications: NotificationsModel?
    var onNotifications: () -> Void = {}

    private var spaces: SpacesModel { store.spaces }

    var body: some View {
        NavigationStack(path: $store.path) {
            SpacesBrowserView(store: store)
            .task { await store.scope.load() }
            .toolbar {
                if store.path.isEmpty, let notifications {
                    ToolbarItem(placement: .topBarTrailing) {
                        BobNotificationsButton(model: notifications, action: onNotifications)
                    }
                }
            }
            .navigationDestination(for: ProductivityRoute.self) { route in
                ProductivityDestinationView(route: route, store: store, chat: chat)
            }
            .bobUndoBar(spaces.undo) { spaces.undo = nil }
            .bobErrorAlert(spaces.message) { spaces.message = nil }
        }
        .tint(BobColor.accent)
    }
}

// Reuses the same feature screens while each tab keeps its own navigation history.
struct ProductivityDestinationView: View {
    let route: ProductivityRoute
    @Bindable var store: ProductivityStore
    var chat = ChatRouting()

    @State private var appError: String?
    @State private var appOpenTask: Task<Void, Never>?
    @State private var appOpenID: UUID?

    private var spaces: SpacesModel { store.spaces }

    var body: some View {
        destination(route)
            .bobErrorAlert(appError) { appError = nil }
            .onChange(of: store.path) { cancelAppOpen() }
            .onDisappear { cancelAppOpen() }
    }

    private func cancelAppOpen() {
        appOpenTask?.cancel()
        appOpenTask = nil
        appOpenID = nil
    }

    private func openAppConversation(_ anchor: BobAppConversation, spaceID: String?) {
        cancelAppOpen()
        guard anchor.spaceId == spaceID else { appError = ApiErrorMapper.userMessage(.forbidden); return }
        let requestID = UUID()
        appOpenID = requestID
        appOpenTask = Task {
            do {
                let thread = try await store.shared.threads.thread(id: anchor.conversationId)
                guard !Task.isCancelled, appOpenID == requestID else { return }
                guard thread.id == anchor.conversationId, thread.spaceID == anchor.spaceId, thread.archivedAt == nil else { throw ApiError.forbidden }
                appOpenTask = nil
                appOpenID = nil
                store.path.append(ProductivityRoute.thread(id: thread.id, spaceID: thread.spaceID))
            } catch {
                guard !Task.isCancelled, appOpenID == requestID else { return }
                appError = ApiErrorMapper.userMessage((error as? ApiError) ?? .unknown(status: 0))
            }
        }
    }

    @ViewBuilder private func destination(_ route: ProductivityRoute) -> some View {
        switch route {
        case .tools: ToolsView()
        case .integrations: IntegrationsView(chat: chat)
        case .routines: RoutinesView(chat: chat)
        case .apps(let spaceID, let canManage):
            BobAppsView(spaceID: spaceID, canManage: canManage, askBob: { chat.new($0) }, openConversation: { anchor in
                openAppConversation(anchor, spaceID: spaceID)
            }, onMarketingAsk: chat.marketing)
        case .insights: InsightsView()
        case .timeline: ActivityTimelineView(store: store, chat: chat)
        case .search: SearchView(model: store.search, store: store, chat: chat)
        case .tasks: TasksView(model: store.tasks, store: store, path: $store.path)
        case .notes: NotesView(model: store.notes, store: store, path: $store.path)
        case .reminders: RemindersView(model: store.reminders, store: store)
        case .memory: MemoryView(model: store.memory, onViewConversation: chat.open)
        case .suggestions: SuggestionsView(model: store.memory)
        case .task(let id): TaskDetailView(id: id, model: store.tasks)
        case .note(let id): NoteDetailView(id: id, model: store.notes, path: $store.path)
        case .noteHistory(let id): NoteHistoryView(noteID: id, service: store.notes.service)
        case .noteRevision(let revision): NoteRevisionView(revision: revision)
        case .deletedTasks: DeletedTasksView(model: store.tasks)
        case .trashedNotes: TrashedNotesView(model: store.notes)
        case .spaces: SpacesBrowserView(store: store)
        case .archivedSpaces: ArchivedSpacesView(model: spaces)
        case .groupChats: GroupChatsView(store: store)
        case .space(let id): SpaceView(id: id, spaces: spaces, store: store)
        case .threads(let spaceID): ThreadsView(spaceID: spaceID, store: store)
        case .thread(let id, let spaceID): ThreadScreen(threadID: id, spaceID: spaceID, store: store)
        case .members(let spaceID): MembersView(spaceID: spaceID, store: store)
        case .groupChat(let id): GroupChatScreen(store: store, chatID: id)
        }
    }
}

#Preview {
    HomeView(store: ProductivityStore(services: .demo()))
        .environment(ShellStore())
}
