import BobKit
import SwiftUI

struct SpacesBrowserView: View {
    let store: ProductivityStore
    @State private var query = ""
    @State private var creating = false
    @State private var joining = false
    @State private var created: SpaceSummary?
    private var spaces: SpacesModel { store.spaces }
    private var matches: [SpaceSummary] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? spaces.sorted : spaces.sorted.filter { $0.name.localizedStandardContains(text) }
    }

    var body: some View {
        List {
            Section {
                Button { creating = true } label: { Label("New space", systemImage: "plus") }
                    .frame(minHeight: 44).bobListRow()
                Button { joining = true } label: { Label("Join with an invitation", systemImage: "envelope") }
                    .frame(minHeight: 44).bobListRow()
            }
            Section {
                switch spaces.phase {
                case .loading:
                    ProgressView("Loading spaces…").bobListRow(divider: false)
                case .failed(let error):
                    BobLoadFailure(title: "Couldn't load your spaces", error: error) { await spaces.refresh() }
                        .bobListRow(divider: false)
                case .loaded:
                    if matches.isEmpty {
                        ContentUnavailableView(query.isEmpty ? "A space for your people" : "No matching spaces", systemImage: "person.2", description: Text(query.isEmpty ? "Create a space or join with an invitation." : "Try another name."))
                            .bobListRow(divider: false)
                    }
                    ForEach(matches) { space in
                        NavigationLink(value: ProductivityRoute.space(space.id)) {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(space.name).font(.body)
                                    Text(SpaceRules.subline(space)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 8)
                                if space.unreadCount > 0 { BobBadge(count: space.unreadCount) }
                            }
                            .padding(.vertical, 4)
                            .frame(minHeight: 44)
                        }
                        .accessibilityValue(space.unreadCount > 0 ? "\(space.unreadCount) unread" : "")
                        .bobListRow()
                    }
                }
            }
            Section {
                NavigationLink(value: ProductivityRoute.archivedSpaces) {
                    Label("Archived spaces", systemImage: "archivebox")
                }.bobListRow(divider: false)
            }
        }
        .bobList()
        .bobNavTitle("Spaces")
        .toolbarBackground(BobColor.page, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .privacySensitive()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a space")
        .refreshable { await spaces.refresh() }
        .task { await spaces.refresh() }
        .sheet(isPresented: $creating, onDismiss: openCreatedSpace) {
            BobNameSheet(title: "New space", label: "Name", limit: SpaceRules.spaceNameLimit) { name in
                created = try await spaces.create(name: name)
            }.bobSheet()
        }
        .sheet(isPresented: $joining) {
            JoinInvitationSheet(spaces: store.shared.spaces, chats: store.shared.groupChats) { joined in
                switch joined {
                case .space:
                    Task { await spaces.refresh() }
                case .chat(let chat):
                    Task { await store.chats.refresh() }
                    store.path.append(ProductivityRoute.groupChat(id: chat.id))
                }
            }.bobSheet()
        }
        .bobErrorAlert(spaces.message) { spaces.message = nil }
    }

    private func openCreatedSpace() {
        if let space = created {
            created = nil
            store.path.append(ProductivityRoute.space(space.id))
        }
    }
}
