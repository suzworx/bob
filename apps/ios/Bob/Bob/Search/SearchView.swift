import BobKit
import SwiftUI

// One box for everything: places to go, chats, what's in spaces, and memories.
struct SearchView: View {
    let model: SearchModel
    let store: ProductivityStore
    let chat: ChatRouting

    @Environment(ShellStore.self) private var shell

    private struct Command: Identifiable {
        let title: String
        let perform: () -> Void
        var id: String { title }
    }

    var body: some View {
        @Bindable var model = model
        List {
            let commands = shownCommands
            if !commands.isEmpty {
                BobGroupHeader(title: "Go to")
                ForEach(commands) { command in
                    plainRow(title: command.title, action: command.perform)
                }
            }
            results
        }
        .bobList()
        .privacySensitive()
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats, tasks, notes…")
        .autocorrectionDisabled()
        .task(id: model.query) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.search()
        }
        .bobNavTitle("Search")
    }

    private var allCommands: [Command] {
        [
            Command(title: "New chat") { chat.new(nil) },
            Command(title: "Today") { shell.select(.today) },
            Command(title: "Calendar") { shell.openCalendar() },
            Command(title: "Group chats") { store.path.append(ProductivityRoute.groupChats) },
            Command(title: "Tasks") { store.path.append(ProductivityRoute.tasks) },
            Command(title: "Notes") { store.path.append(ProductivityRoute.notes) },
            Command(title: "Reminders") { store.path.append(ProductivityRoute.reminders) },
            Command(title: "Memory") { store.path.append(ProductivityRoute.memory) }
        ]
    }

    private var shownCommands: [Command] {
        let text = model.trimmedQuery
        return text.isEmpty ? allCommands : allCommands.filter { $0.title.localizedCaseInsensitiveContains(text) }
    }

    @ViewBuilder private var results: some View {
        if model.failed {
            VStack(alignment: .leading, spacing: 8) {
                Text("Some results couldn't be loaded.")
                    .font(BobFont.subline)
                    .foregroundStyle(BobColor.dangerText)
                Button("Try again") { Task { await model.search() } }
                    .buttonStyle(BobSecondaryButtonStyle())
                    .disabled(model.searching)
            }
            .bobListRow(divider: false)
        }
        if !model.chats.isEmpty {
            BobGroupHeader(title: "Chats")
            ForEach(model.chats) { row in
                plainRow(title: row.displayTitle) { chat.open(row.id) }
            }
        }
        ForEach(SearchRules.groups(model.results), id: \.kind) { group in
            BobGroupHeader(title: group.kind.groupTitle)
            ForEach(group.rows) { self.result($0) }
        }
        if !model.memories.isEmpty {
            BobGroupHeader(title: "Memory")
            ForEach(model.memories) { memory in
                plainRow(title: MemoryVoice.forReader(memory.content)) {
                    store.memory.query = model.trimmedQuery
                    store.path.append(ProductivityRoute.memory)
                }
            }
        }
        if model.searching, model.hasNothing {
            ProgressView()
                .accessibilityLabel("Searching")
                .frame(maxWidth: .infinity, minHeight: 88)
                .bobListRow(divider: false)
        } else if model.searched, model.hasNothing, !model.failed {
            ContentUnavailableView {
                Text("Nothing found").font(BobFont.heading)
            } description: {
                Text("Bob might still know. Ask him.")
            } actions: {
                Button("Ask Bob") { chat.new(model.trimmedQuery) }
                    .buttonStyle(BobSecondaryButtonStyle())
            }
            .bobListRow(divider: false)
        }
    }

    private func result(_ result: SearchResult) -> some View {
        let excerpt = SearchRules.excerpt(result.snippet, around: model.trimmedQuery)
        return Button { open(result) } label: {
            resultText(result, excerpt: excerpt)
        }
        .buttonStyle(BobPressStyle())
        .bobListRow()
    }

    private func resultText(_ result: SearchResult, excerpt: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(result.displayTitle).font(BobFont.rowTitle)
            if !excerpt.isEmpty {
                Text(excerpt).font(BobFont.subline).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    // Whatever was found opens in its own space.
    private func open(_ result: SearchResult) {
        switch result.kind {
        case .thread:
            store.path.append(ProductivityRoute.thread(id: result.resourceID, spaceID: result.spaceID))
        case .event:
            store.calendar.eventTarget = CalendarEventTarget(eventID: result.resourceID, spaceID: result.spaceID)
            shell.openCalendar()
        case .task:
            store.openItem(.task(result.resourceID), in: result.spaceID)
        case .note:
            store.openItem(.note(result.resourceID), in: result.spaceID)
        }
    }

    private func plainRow(title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(BobFont.rowTitle)
                .lineLimit(2)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .bobListRow()
    }
}

#Preview {
    let store = ProductivityStore(services: .demo())
    return NavigationStack {
        SearchView(model: store.search, store: store, chat: ChatRouting())
    }
    .environment(ShellStore())
}
