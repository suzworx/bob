import BobKit
import SwiftUI

// The root view: sign-in when signed out, otherwise the shell. Leaving the shell drops its state, so each sign-in starts on Chats with nothing from the last person.
struct AppShell: View {
    private let gate = AppSession.gate

    var body: some View {
        Group {
            switch gate.state {
            case .checking:
                BobColor.page.ignoresSafeArea()
            case .signedOut:
                if let client = AppSession.authClient {
                    SignInView(client: client, onSignedIn: gate.signIn)
                }
            case .signedIn:
                SignedInShell()
            }
        }
        .preferredColorScheme(BobAppearanceStore.shared.colorScheme)
        .task { await gate.check() }
        .onChange(of: gate.state, initial: true) { _, state in
            if state == .signedOut {
                Task {
                    guard gate.state == .signedOut else { return }
                    await TimerNotifications.shared.signedOut()
                    guard gate.state == .signedOut else { return }
                    await PushNotifications.shared.signedOut()
                }
            }
        }
    }
}

// The selected tab's screen above the Bob tab bar, the chat sheet and full-screen moments.
private struct SignedInShell: View {
    @State private var store = ShellStore()
    // Owned here so the conversation survives closing and reopening the sheet.
    @State private var chat: ChatViewModel
    // Owned here so chat history is ready when opened again.
    @State private var chats: ConversationListModel
    // Owned here so the last result survives switching tabs.
    @State private var today: TodayViewModel
    // Owned here so lists and where the person had got to survive switching tabs.
    @State private var productivity: ProductivityStore
    @State private var todayProductivity: ProductivityStore
    @State private var bobProductivity: ProductivityStore
    @State private var chatsProductivity: ProductivityStore
    @State private var youProductivity: ProductivityStore
    // Owned here so the unread count can show on the tab bar.
    @State private var account = AccountStore(services: AccountServices.make())
    @State private var destinations = ShellDestinations.shared
    @State private var push = PushNotifications.shared
    @State private var marketingSession = MarketingChatSession()
    @State private var appConversation: AppConversationPresentation?
    @State private var marketingRequest: (MarketingChatTarget, String)?
    @State private var marketingTask: Task<Void, Never>?
    @State private var marketingOpening = false
    @State private var marketingError: String?
    @State private var showsInbox = false
    @State private var pendingInboxTarget: (NotificationTarget, String?)?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let services = ChatServiceFactory.make()
        _chat = State(initialValue: ChatViewModel(service: services.chat, conversations: services.conversations))
        _chats = State(initialValue: ConversationListModel(service: services.conversations))
        let productivity = ProductivityStore(services: ProductivityServices.make(conversations: services.conversations))
        _productivity = State(initialValue: productivity)
        _todayProductivity = State(initialValue: ProductivityStore(sharing: productivity))
        _bobProductivity = State(initialValue: ProductivityStore(sharing: productivity))
        _chatsProductivity = State(initialValue: ProductivityStore(sharing: productivity))
        _youProductivity = State(initialValue: ProductivityStore(sharing: productivity))
        _today = State(initialValue: TodayViewModel(provider: CalendarTodayProvider(service: productivity.calendar.service), clock: Date.init))
    }

    // How Home, Search and Memory reach the chat sheet.
    private var routing: ChatRouting {
        ChatRouting(
            open: { id in
                chat.open(id)
                store.openChat()
            },
            new: { draft in
                chat.newChat()
                if let draft {
                    if chat.draft.isEmpty && chat.attachments.isEmpty { chat.draft = draft }
                    else { chat.notice = "Your unfinished message is still here. Send or clear it before starting something new." }
                }
                store.openChat()
            },
            marketing: openMarketing
        )
    }

    private func openMarketing(_ target: MarketingChatTarget, prefill: String) {
        marketingTask?.cancel()
        marketingSession.cancel()
        marketingRequest = (target, prefill)
        marketingError = nil
        marketingOpening = true
        marketingTask = Task {
            do {
                let model = try await marketingSession.open(target, prefill: prefill, services: ChatServiceFactory.make(), shared: productivity.shared)
                guard !Task.isCancelled else { return }
                appConversation = AppConversationPresentation(model: model)
            } catch {
                guard !Task.isCancelled, (error as? ApiError) != .cancelled else { return }
                marketingError = ApiErrorMapper.userMessage((error as? ApiError) ?? .unknown(status: 0))
            }
            marketingOpening = false
        }
    }

    // How the You tab reaches the rest of the app.
    private var youRouting: YouRouting {
        YouRouting(
            openTarget: { open($0, spaceID: $1) },
            openMemory: { account.path.append(ProductivityRoute.memory) },
            openChat: routing.open,
            openDestination: { account.path.append($0) }
        )
    }

    private func open(_ target: NotificationTarget, spaceID: String?) {
        switch target {
        case .task(let id): openItem(.task(id), in: spaceID)
        case .note(let id): openItem(.note(id), in: spaceID)
        case .reminders: openItem(.reminders, in: spaceID)
        case .calendar: store.openCalendar()
        case .device(let id):
            store.select(.you)
            account.path.append(YouRoute.device(id))
        case .devices:
            store.select(.you)
            account.path.append(YouRoute.devices)
        case .thread(let id, let spaceID): activeProductivity.path.append(ProductivityRoute.thread(id: id, spaceID: spaceID))
        case .members(let spaceID): activeProductivity.path.append(ProductivityRoute.members(spaceID: spaceID))
        }
    }

    private func openItem(_ route: ProductivityRoute, in spaceID: String?) {
        activeProductivity.openItem(route, in: spaceID)
    }

    private func openHome(_ route: ProductivityRoute) {
        store.select(.spaces)
        productivity.path = NavigationPath([route])
    }

    // Somewhere Siri asked to go.
    private func go(to destination: ShellDestination) {
        guard destination != .voice || store.moment != .voice else { return }
        store.go(to: destination)
        switch destination {
        case .home: productivity.path = NavigationPath()
        case .search: openHome(.search)
        case .tasks: openHome(.tasks)
        case .notes: openHome(.notes)
        case .reminders: openHome(.reminders)
        case .memory: openHome(.memory)
        case .you: account.path = NavigationPath()
        case .notifications: account.path = NavigationPath([YouRoute.notifications])
        case .devices: account.path = NavigationPath([YouRoute.devices])
        case .today, .calendar, .chat, .voice: break
        }
    }

    private var activeProductivity: ProductivityStore {
        switch store.selectedTab {
        case .chats: chatsProductivity
        case .today: todayProductivity
        case .bob: bobProductivity
        case .spaces: productivity
        case .you: youProductivity
        }
    }

    private func openNotifications() {
        showsInbox = true
    }

    private var todayRoot: some View {
        NavigationStack(path: $todayProductivity.path) {
            TodayView(model: today, onGetStarted: { step in
                switch step {
                case .connectCalendar: todayProductivity.path.append(ProductivityRoute.integrations)
                case .inviteFamily: todayProductivity.path.append(ProductivityRoute.spaces)
                case .tellBobInterests: store.openChat()
                }
            }, onBob: { store.openChat() }, onEvent: { target in
                productivity.calendar.eventTarget = target
                store.showsCalendar = true
            }, onCalendar: { store.showsCalendar = true }, onDestination: { route in
                todayProductivity.path.append(route)
            }, notifications: account.notifications, onNotifications: openNotifications)
            .navigationDestination(for: ProductivityRoute.self) { route in
                ProductivityDestinationView(route: route, store: todayProductivity, chat: routing)
            }
            .navigationDestination(isPresented: $store.showsCalendar) {
                CalendarView(model: productivity.calendar, embedded: true)
            }
        }
    }

    var body: some View {
        TabView(selection: Binding(get: { store.selectedTab }, set: { store.select($0) })) {
            ChatsRootView(model: chats, chat: chat, productivity: chatsProductivity, routing: routing,
                          notifications: account.notifications, onOpen: routing.open,
                          onNew: { routing.new(nil) }, onNotifications: openNotifications)
                .tag(ShellTab.chats)
                .toolbar(.hidden, for: .tabBar)

            todayRoot
                .tag(ShellTab.today)
                .toolbar(.hidden, for: .tabBar)

            BobRootView(productivity: bobProductivity, routing: routing, chat: chat, chats: chats,
                        notifications: account.notifications, onVoice: store.requestVoiceFromBob,
                        onChat: store.openChat, onNotifications: openNotifications,
                        onDestination: { bobProductivity.path.append($0) }, onDevices: {
                            store.select(.you)
                            account.path.append(YouRoute.devices)
                        })
                .tag(ShellTab.bob)
                .toolbar(.hidden, for: .tabBar)

            HomeView(store: productivity, chat: routing, notifications: account.notifications, onNotifications: openNotifications)
                .tag(ShellTab.spaces)
                .toolbar(.hidden, for: .tabBar)

            YouView(store: account, routing: youRouting, productivity: youProductivity, chat: routing)
                .tag(ShellTab.you)
                .toolbar(.hidden, for: .tabBar)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !store.dockHidden {
                BobDock(selectedTab: store.selectedTab, unread: account.notifications.unread, onSelect: { store.select($0) })
            }
        }
        .tint(BobColor.accent)
        .sheet(isPresented: $showsInbox, onDismiss: {
            if let target = pendingInboxTarget {
                pendingInboxTarget = nil
                open(target.0, spaceID: target.1)
            }
        }) {
            NavigationStack {
                NotificationsView(model: account.notifications, zone: account.account.zone, open: { target, spaceID in
                    pendingInboxTarget = (target, spaceID)
                    showsInbox = false
                })
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { showsInbox = false }
                    }
                }
            }
            .bobSheet()
        }
        .fullScreenCover(isPresented: chatBinding) {
            ChatSheet(model: chat, chats: chats, groupChats: productivity.chats, openHomeRoute: { route in
                store.closeChat()
                chatsProductivity.path.append(route)
                store.select(.chats)
            })
                .environment(store)
        }
        .fullScreenCover(item: $appConversation) { presentation in
            NavigationStack {
                ChatView(model: presentation.model)
                    .bobNavTitle("Bob Marketing")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { appConversation = nil }
                        }
                    }
            }
        }
        .overlay {
            if marketingOpening {
                VStack(spacing: 12) {
                    ProgressView("Opening your app conversation…")
                    Button("Cancel") {
                        marketingTask?.cancel()
                        marketingSession.cancel()
                        marketingOpening = false
                    }
                }.padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .alert("Couldn't open the app conversation", isPresented: Binding(get: { marketingError != nil }, set: { if !$0 { marketingError = nil } })) {
            Button("Try again") { if let request = marketingRequest { openMarketing(request.0, prefill: request.1) } }
            Button("Cancel", role: .cancel) { marketingError = nil }
        } message: { Text(marketingError ?? "Please try again.") }
        .onDisappear { marketingTask?.cancel(); marketingSession.cancel() }
        .fullScreenCover(item: momentBinding) { moment in
            MomentPlaceholderView(moment: moment)
                .environment(store)
        }
        .environment(store)
        .environment(\.healthChatRouting, routing)
        .onChange(of: destinations.pending, initial: true) {
            if let destination = destinations.take() { go(to: destination) }
        }
        .onChange(of: push.pendingTap, initial: true) { _, payload in
            guard let payload else { return }
            Task {
                guard let accountID = try? await AppSession.manager?.userID(),
                      payload.belongs(to: accountID), push.pendingTap == payload else { return }
                push.clearPendingTap()
                store.closeChat()
                store.dismissMoment()
                appConversation = nil
                showsInbox = false
                if let target = payload.target { open(target, spaceID: payload.spaceID) }
                else { openNotifications() }
            }
        }
        // The unread dot, looked at once a minute and on coming back to the app. A failure keeps the last count.
        .task {
            while !Task.isCancelled {
                await account.notifications.refreshCount()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await account.notifications.refreshCount() } }
        }
        // iOS owns delivery after scheduling. Poll only while active to pick up
        // changes made elsewhere; this is not a substitute for remote push.
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await TimerNotifications.shared.refresh()
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .onChange(of: store.isChatOpen) { _, isOpen in
            if !isOpen {
                Task { await chats.refresh() }
                if store.selectedTab == .today { Task { await today.refresh() } }
            }
        }
    }

    // Closing the full-screen conversation updates the shared shell state.
    private var chatBinding: Binding<Bool> {
        Binding(
            get: { store.isChatOpen },
            set: { isOpen in
                if !isOpen { store.closeChat() }
            }
        )
    }

    private var momentBinding: Binding<ShellMoment?> {
        Binding(
            // The chat sheet shows voice over itself.
            get: { store.moment == .voice ? nil : store.moment },
            set: { moment in
                if moment == nil { store.dismissMoment() }
            }
        )
    }
}

private struct AppConversationPresentation: Identifiable {
    let id = UUID()
    let model: ChatViewModel
}

#Preview {
    AppShell()
}
