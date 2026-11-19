import BobKit
import SwiftUI

// One line for a thread, with its unread count.
struct ThreadRow: View {
    let thread: SpaceThread

    var body: some View {
        NavigationLink(value: ProductivityRoute.thread(id: thread.id, spaceID: thread.spaceID)) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(thread.title).font(BobFont.rowTitle)
                    Text(thread.updatedAt, format: .relative(presentation: .named))
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                Spacer(minLength: 8)
                if thread.unreadCount > 0 { BobBadge(count: thread.unreadCount) }
            }
        }
        .accessibilityValue(thread.unreadCount > 0 ? "\(thread.unreadCount) unread" : "")
    }
}

// One space as a room: its threads, its lists, its week and its people.
struct SpaceView: View {
    let spaces: SpacesModel
    let store: ProductivityStore

    @State private var model: SpaceDetailModel
    @State private var renaming = false
    @State private var creatingThread = false
    @State private var inviting = false
    @State private var creatingEvent = false
    @State private var showingTools = false
    @State private var leaving = false
    @State private var openedThread: SpaceThread?
    @Environment(\.dismiss) private var dismiss

    private static let previewCount = 3

    init(id: String, spaces: SpacesModel, store: ProductivityStore) {
        self.spaces = spaces
        self.store = store
        _model = State(initialValue: SpaceDetailModel(spaceID: id, shared: store.shared))
    }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading the space")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't open this space", error: error) { await model.load() }
                    .bobListRow(divider: false)
            case .loaded:
                if let space = model.space { content(space) }
            }
        }
        .bobList()
        .privacySensitive()
        .bobNavTitle(model.space?.name ?? "Space")
        .toolbar {
            if let space = model.space {
                ToolbarItem(placement: .primaryAction) { actions(space) }
            }
        }
        .refreshable { await model.load() }
        .task { await model.load() }
        .sheet(isPresented: $showingTools) {
            ToolsSheet(context: .space(model.spaceID), title: "Space tools")
        }
        .sheet(isPresented: $renaming) {
            if let space = model.space {
                BobNameSheet(title: "Rename space", label: "Space name", limit: SpaceRules.spaceNameLimit, initial: space.name) { name in
                    try await spaces.rename(space, to: name)
                    await model.load()
                }
                .bobSheet()
            }
        }
        .sheet(isPresented: $creatingThread) {
            BobNameSheet(title: "New thread", label: "Thread title", limit: SpaceRules.threadTitleLimit) { title in
                openedThread = try await model.createThread(title: title)
            } 
            .bobSheet()
            .onDisappear {
                if let thread = openedThread {
                    openedThread = nil
                    store.path.append(ProductivityRoute.thread(id: thread.id, spaceID: thread.spaceID))
                }
            }
        }
        .sheet(isPresented: $inviting) {
            SpaceInviteSheet(model: model, linkBase: store.shared.linkBase).bobSheet()
        }
        .sheet(isPresented: $creatingEvent, onDismiss: { Task { await model.load() } }) {
            EventEditorSheet(mode: .create(day: WallClock.day(Date(), zone: TimeZone.current.identifier)), model: store.calendar, spaceID: model.spaceID).bobSheet()
        }
        .confirmationDialog("Leave \(model.space?.name ?? "this space")?", isPresented: $leaving, titleVisibility: .visible) {
            Button("Leave space", role: .destructive) { leave() }
            Button("Stay", role: .cancel) {}
        } message: {
            Text("You lose its threads, tasks and notes. Only a new invite brings you back.")
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    @ViewBuilder private func content(_ space: SpaceSummary) -> some View {
        Text(SpaceRules.subline(space) + (SpaceRules.isShared(space) ? " · \(model.members.count) \(model.members.count == 1 ? "person" : "people")" : ""))
            .font(BobFont.subline)
            .foregroundStyle(.secondary)
            .bobListRow(divider: false)
        if SpaceRules.isShared(space) { threadsSection(space) }
        BobGroupHeader(title: "In this space")
        listRow("Tasks", .tasks)
        listRow("Notes", .notes)
        listRow("Reminders", .reminders)
        NavigationLink("Apps", value: ProductivityRoute.apps(spaceID: space.id, canManage: space.role == .owner || space.role == .admin))
            .font(BobFont.rowTitle).bobListRow()
        agendaSection
        if SpaceRules.isShared(space) { peopleSection(space) }
    }

    private func threadsSection(_ space: SpaceSummary) -> some View {
        Group {
            headerRow("Threads", action: "New thread") { creatingThread = true }
            if model.threads.isEmpty {
                Text("Nothing here yet. Start a thread for everyone in \(space.name).")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .bobListRow()
            }
            ForEach(model.threads.prefix(Self.previewCount)) { thread in
                ThreadRow(thread: thread).bobListRow()
            }
            if model.threads.count > Self.previewCount {
                NavigationLink("View all threads", value: ProductivityRoute.threads(spaceID: space.id))
                    .font(BobFont.rowTitle)
                    .bobListRow()
            }
        }
    }

    private var agendaSection: some View {
        Group {
            headerRow("This week", action: "New event") {
                Task {
                    await store.calendar.refresh()
                    creatingEvent = true
                }
            }
            SpaceAgendaRows(model: model, calendar: store.calendar, limit: Self.previewCount)
            if !model.agenda.isEmpty {
                NavigationLink {
                    SpaceAgendaView(model: model, calendar: store.calendar)
                } label: {
                    Text("View all events").font(BobFont.rowTitle)
                }
                .bobListRow()
            }
        }
    }

    private func peopleSection(_ space: SpaceSummary) -> some View {
        Group {
            if SpaceRules.canInvite(space) {
                headerRow("People", action: "Invite") { inviting = true }
            } else {
                BobGroupHeader(title: "People")
            }
            ForEach(model.members.prefix(Self.previewCount)) { member in
                HStack(spacing: 10) {
                    BobAvatar(initials: SpaceRules.initials(SpaceRules.displayName(member)), fillIndex: model.members.firstIndex(of: member) ?? 0)
                    Text(SpaceRules.displayName(member)).font(BobFont.rowTitle)
                    Spacer(minLength: 8)
                    Text(member.role.title).font(BobFont.subline).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .bobListRow()
            }
            NavigationLink(value: ProductivityRoute.members(spaceID: space.id)) {
                Text("All people and invitations").font(BobFont.rowTitle)
            }
            .bobListRow()
        }
    }

    private func headerRow(_ title: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack {
            Text(title)
                .font(BobFont.caption)
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button(action, action: perform)
                .font(BobFont.caption)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .buttonStyle(.borderless)
        }
        .padding(.top, 8)
        .bobListRow(divider: false)
    }

    private func listRow(_ title: String, _ route: ProductivityRoute) -> some View {
        Button {
            store.openList(route, in: model.spaceID)
        } label: {
            HStack {
                Text(title).font(BobFont.rowTitle).foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary).accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .bobListRow()
    }

    private func actions(_ space: SpaceSummary) -> some View {
        Menu {
            Button("Tools") { showingTools = true }
            if SpaceRules.canInvite(space) { Button("Invite people") { inviting = true } }
            if SpaceRules.canRename(space) { Button("Rename") { renaming = true } }
            if SpaceRules.canArchive(space) {
                Button("Archive", role: .destructive) {
                    Task {
                        if await spaces.archive(space) { dismiss() }
                    }
                }
            }
            if SpaceRules.canLeave(space) { Button("Leave space", role: .destructive) { leaving = true } }
        } label: {
            Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("Actions for \(space.name)")
    }

    private func leave() {
        guard let space = model.space, let me = model.me else { return }
        Task {
            if await spaces.leave(space, me: me) { dismiss() }
        }
    }
}

// Every open thread in a space.
struct ThreadsView: View {
    let store: ProductivityStore

    @State private var model: SpaceDetailModel
    @State private var creating = false
    @State private var renaming: SpaceThread?
    @State private var archiving: SpaceThread?
    @State private var created: SpaceThread?

    init(spaceID: String, store: ProductivityStore) {
        self.store = store
        _model = State(initialValue: SpaceDetailModel(spaceID: spaceID, shared: store.shared))
    }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading threads")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load threads", error: error) { await model.load() }
                    .bobListRow(divider: false)
            case .loaded:
                if model.threads.isEmpty {
                    ContentUnavailableView {
                        Text("No threads yet").font(BobFont.heading)
                    } description: {
                        Text("A thread is one conversation with everyone in this space.")
                    } actions: {
                        Button("Start a thread") { creating = true }.buttonStyle(BobSecondaryButtonStyle())
                    }
                    .bobListRow(divider: false)
                }
                ForEach(model.threads) { row($0) }
            }
        }
        .bobList()
        .privacySensitive()
        .bobNavTitle("Threads")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New thread")
            }
        }
        .refreshable { await model.load() }
        .task { await model.load() }
        .sheet(isPresented: $creating) {
            BobNameSheet(title: "New thread", label: "Thread title", limit: SpaceRules.threadTitleLimit) { title in
                created = try await model.createThread(title: title)
            }
            .bobSheet()
            .onDisappear {
                if let thread = created {
                    created = nil
                    store.path.append(ProductivityRoute.thread(id: thread.id, spaceID: thread.spaceID))
                }
            }
        }
        .sheet(item: $renaming) { thread in
            BobNameSheet(title: "Rename thread", label: "Thread title", limit: SpaceRules.threadTitleLimit, initial: thread.title) { title in
                try await model.rename(thread, to: title)
            }
            .bobSheet()
        }
        .confirmationDialog("Archive \(archiving?.title ?? "this thread")?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }), titleVisibility: .visible, presenting: archiving) { thread in
            Button("Archive", role: .destructive) { Task { await model.archive(thread) } }
            Button("Keep it", role: .cancel) {}
        } message: { _ in
            Text("It leaves this list for everyone in the space.")
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private func row(_ thread: SpaceThread) -> some View {
        ThreadRow(thread: thread)
            .bobListRow()
            .swipeActions(edge: .leading) {
                Button("Rename") { renaming = thread }.tint(BobColor.accent)
            }
            .swipeActions(edge: .trailing) {
                if model.canArchive(thread) {
                    Button("Archive", role: .destructive) { archiving = thread }
                }
            }
            .contextMenu {
                Button("Rename") { renaming = thread }
                if model.canArchive(thread) {
                    Button("Archive", role: .destructive) { archiving = thread }
                }
            }
    }
}

// Who's in a space, what they can do, and who's been asked.
struct MembersView: View {
    let store: ProductivityStore

    @State private var model: SpaceDetailModel
    @State private var inviting = false
    @State private var removing: SpaceMember?
    @State private var promoting: SpaceMember?
    @Environment(\.dismiss) private var dismiss

    init(spaceID: String, store: ProductivityStore) {
        self.store = store
        _model = State(initialValue: SpaceDetailModel(spaceID: spaceID, shared: store.shared))
    }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading members")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load members", error: error) { await model.load() }
                    .bobListRow(divider: false)
            case .loaded:
                if let space = model.space {
                    BobGroupHeader(title: "In this space, \(model.members.count)")
                    ForEach(model.members) { row($0, in: space) }
                    invitations(space)
                }
            }
        }
        .bobList()
        .privacySensitive()
        .bobNavTitle("People")
        .toolbar {
            if let space = model.space, SpaceRules.canInvite(space) {
                ToolbarItem(placement: .primaryAction) {
                    Button { inviting = true } label: {
                        Image(systemName: "person.badge.plus").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Invite people")
                }
            }
        }
        .refreshable { await model.load() }
        .task { await model.load() }
        .sheet(isPresented: $inviting) {
            SpaceInviteSheet(model: model, linkBase: store.shared.linkBase).bobSheet()
        }
        .confirmationDialog(removeTitle, isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { member in
            if member.userID == model.me {
                Button("Leave space", role: .destructive) {
                    Task {
                        await model.remove(member)
                        guard model.message == nil else { return }
                        await store.spaces.refresh()
                        // Everything further in this space is gone for them too.
                        store.path = NavigationPath()
                    }
                }
            } else {
                Button("Remove", role: .destructive) { Task { await model.remove(member) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: { member in
            Text(member.userID == model.me ? "You lose its threads, tasks and notes. Only a new invite brings you back." : "They lose access to this space. Only a new invite brings them back.")
        }
        .confirmationDialog("Make \(promoting.map(SpaceRules.displayName) ?? "them") the owner?", isPresented: Binding(get: { promoting != nil }, set: { if !$0 { promoting = nil } }), titleVisibility: .visible, presenting: promoting) { member in
            Button("Make owner") { Task { await model.makeOwner(member) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("You stay in the space as an admin. Only the new owner can give it back.")
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private var removeTitle: String {
        guard let removing else { return "" }
        return removing.userID == model.me ? "Leave this space?" : "Remove \(SpaceRules.displayName(removing))?"
    }

    @ViewBuilder private func row(_ member: SpaceMember, in space: SpaceSummary) -> some View {
        let canChange = SpaceRules.canChangeRole(of: member, in: space, me: model.me)
        let canOwn = SpaceRules.canMakeOwner(member, in: space, me: model.me)
        let canRemove = SpaceRules.canRemove(member: member, in: space, me: model.me)
        let text = memberText(member)
        if canChange || canOwn || canRemove {
            Menu {
                if canChange {
                    let next: InviteRole = member.role == .admin ? .member : .admin
                    Button("Make \(next.title.lowercased())") { Task { await model.setRole(member, role: next) } }
                }
                if canOwn { Button("Make owner") { promoting = member } }
                if canRemove {
                    Button(member.userID == model.me ? "Leave space" : "Remove", role: .destructive) { removing = member }
                }
            } label: {
                text.contentShape(Rectangle())
            }
            .disabled(model.busy)
            .accessibilityHint("Shows what you can change")
            .bobListRow()
        } else {
            text.bobListRow()
        }
    }

    private func memberText(_ member: SpaceMember) -> some View {
        HStack(spacing: 10) {
            BobAvatar(initials: SpaceRules.initials(SpaceRules.displayName(member)), fillIndex: model.members.firstIndex(of: member) ?? 0)
            VStack(alignment: .leading, spacing: 2) {
                Text(SpaceRules.displayName(member) + (member.userID == model.me ? " (you)" : ""))
                    .font(BobFont.rowTitle)
                    .foregroundStyle(.primary)
                if let email = member.email {
                    Text(email).font(BobFont.subline).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            Spacer(minLength: 8)
            Text(member.role.title).font(BobFont.subline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func invitations(_ space: SpaceSummary) -> some View {
        if SpaceRules.canInvite(space) {
            BobGroupHeader(title: "Pending invites")
            if model.invitations.isEmpty {
                Text("Nobody is waiting to join.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            }
            ForEach(model.invitations) { invitation in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(invitation.invitedEmail).font(BobFont.rowTitle)
                        Text("\(invitation.role.title) · expires \(invitation.expiresAt.formatted(date: .abbreviated, time: .omitted))")
                            .font(BobFont.subline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    Spacer(minLength: 8)
                    Button("Revoke") { Task { await model.revoke(invitation) } }
                        .buttonStyle(.borderless)
                        .frame(minHeight: 44)
                        .accessibilityLabel("Revoke invitation for \(invitation.invitedEmail)")
                }
                .bobListRow()
                .swipeActions(edge: .trailing) {
                    Button("Revoke", role: .destructive) { Task { await model.revoke(invitation) } }
                }
            }
        }
    }
}

// Archived spaces wait here; only their owner can bring them back.
struct ArchivedSpacesView: View {
    let model: SpacesModel

    var body: some View {
        List {
            switch model.archivedPhase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading archived spaces")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load archived spaces", error: error) { await model.refreshArchived() }
                    .bobListRow(divider: false)
            case .loaded:
                if model.archived.isEmpty {
                    ContentUnavailableView {
                        Text("No archived spaces").font(BobFont.heading)
                    } description: {
                        Text("Spaces you archive wait here until you restore them.")
                    }
                    .bobListRow(divider: false)
                }
                ForEach(model.archived) { space in
                    HStack {
                        Text(space.name).font(BobFont.rowTitle)
                        Spacer(minLength: 8)
                        Button("Restore") { Task { await model.restore(space) } }
                            .buttonStyle(.borderless)
                            .frame(minHeight: 44)
                            .accessibilityLabel("Restore \(space.name)")
                    }
                    .bobListRow()
                }
            }
        }
        .bobList()
        .bobNavTitle("Archived spaces")
        .refreshable { await model.refreshArchived() }
        .bobErrorAlert(model.message) { model.message = nil }
        .task { await model.refreshArchived() }
    }
}
