import BobKit
import SwiftUI

private struct MemoryEditTarget: Identifiable {
    let id = UUID()
    let memory: Memory?
}

// What Bob knows about the person, and only the person can see it.
struct MemoryView: View {
    let model: MemoryModel
    // Opens the chat a memory came from.
    var onViewConversation: (String) -> Void = { _ in }

    @Environment(\.scenePhase) private var scenePhase
    @State private var editing: MemoryEditTarget?
    @State private var forgetting: Memory?
    @State private var confirmingForgetAll = false

    var body: some View {
        @Bindable var model = model
        List {
            content
        }
        .bobList()
        .privacySensitive()
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search memories")
        .task(id: model.query) {
            // The first run has nothing to wait for; after that this waits for the last key.
            if model.phase != .loading { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.refresh()
        }
        .task { await model.refreshSuggestions() }
        .refreshable {
            await model.refresh(quiet: true)
            await model.refreshSuggestions()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshOnReturn() } }
        }
        .bobNavTitle("Memory")
        .toolbar {
            if model.phase != .unavailable {
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = MemoryEditTarget(memory: nil) } label: {
                        Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Add memory")
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button("Delete all memories", role: .destructive) { confirmingForgetAll = true }
                }
            }
        }
        .sheet(item: $editing) { target in
            MemoryEditorSheet(memory: target.memory, model: model).bobSheet()
        }
        .alert(
            "Delete this memory?",
            isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
            presenting: forgetting
        ) { memory in
            Button("Delete", role: .destructive) { Task { await model.forget(memory) } }
            Button("Keep it", role: .cancel) {}
        } message: { memory in
            Text("“\(MemoryVoice.forReader(memory.content))”\nBob will forget this. This can't be undone.")
        }
        .alert("Delete all memories?", isPresented: $confirmingForgetAll) {
            Button("Delete all", role: .destructive) { Task { await model.forgetAll() } }
            Button("Keep them", role: .cancel) {}
        } message: {
            Text("Bob will forget everything it remembers about you, including its suggested to-dos. This can't be undone.")
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .accessibilityLabel("Loading memories")
                .frame(minHeight: 200)
                .frame(maxWidth: .infinity)
                .bobListRow(divider: false)
        case .unavailable:
            ContentUnavailableView {
                Text("Memory is off").font(BobFont.heading)
            } description: {
                Text("Bob can't remember things on your account right now.")
            }
            .bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load your memories", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loaded:
            loaded
        }
    }

    @ViewBuilder private var loaded: some View {
        @Bindable var model = model
        Text("What Bob knows about you. Only you can see this.")
            .font(BobFont.subline)
            .foregroundStyle(.secondary)
            .bobListRow(divider: false)
        if !model.suggestions.isEmpty {
            NavigationLink(value: ProductivityRoute.suggestions) {
                Text("Suggested by Bob, \(model.suggestions.count)").font(BobFont.rowTitle)
            }
            .bobListRow()
        }
        if model.hasNothing, !model.isSearching {
            ContentUnavailableView {
                Text("Nothing remembered yet").font(BobFont.heading)
            } description: {
                Text("Tell Bob something about you, or add it here.")
            } actions: {
                Button("Add a memory") { editing = MemoryEditTarget(memory: nil) }
                    .buttonStyle(BobSecondaryButtonStyle())
            }
            .bobListRow(divider: false)
        } else if model.hasNothing {
            ContentUnavailableView.search(text: model.query).bobListRow(divider: false)
        } else {
            Picker("Show", selection: $model.tab) {
                ForEach(MemoryTab.allCases) { Text($0.title).tag($0) }
            }
            .bobChoicePicker()
            .frame(minHeight: 44)
            .bobListRow(divider: false)
            if model.groups.isEmpty {
                Text("Nothing here yet.")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .bobListRow(divider: false)
            }
            ForEach(model.groups) { group in
                if let title = group.title {
                    BobGroupHeader(title: title)
                }
                ForEach(group.rows) { row($0) }
            }
            olderSection
            moreRow
        }
    }

    private func row(_ memory: Memory) -> some View {
        Button {
            editing = MemoryEditTarget(memory: memory)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(MemoryVoice.forReader(memory.content)).font(BobFont.rowTitle)
                Text(MemoryRules.subline(memory, now: Date()))
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityHint("Edits this memory")
        .accessibilityAction(named: "Forget") { forgetting = memory }
        .bobListRow()
        .swipeActions(edge: .leading) {
            if let id = memory.source.conversationID {
                Button("View conversation") { onViewConversation(id) }
                    .tint(BobColor.accent)
            }
        }
        .swipeActions(edge: .trailing) {
            Button("Forget", role: .destructive) { forgetting = memory }
        }
        .contextMenu {
            if let id = memory.source.conversationID {
                Button("View conversation") { onViewConversation(id) }
            }
            Button("Edit") { editing = MemoryEditTarget(memory: memory) }
            Button("Forget", role: .destructive) { forgetting = memory }
        }
    }

    @ViewBuilder private var olderSection: some View {
        @Bindable var model = model
        let older = model.older
        if !older.isEmpty {
            Button {
                model.showsOlder.toggle()
            } label: {
                HStack {
                    Text("Older versions, \(older.count)").font(BobFont.caption).foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: model.showsOlder ? "chevron.up" : "chevron.down")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .padding(.top, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityValue(model.showsOlder ? "Shown" : "Hidden")
            .bobListRow(divider: false)
            if model.showsOlder {
                ForEach(older) { memory in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(MemoryVoice.forReader(memory.content)).font(BobFont.rowTitle)
                        Text("Replaced by a newer memory").font(BobFont.subline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                    .accessibilityAction(named: "Forget") { forgetting = memory }
                    .bobListRow()
                    .swipeActions(edge: .trailing) {
                        Button("Forget", role: .destructive) { forgetting = memory }
                    }
                }
            }
        }
    }

    @ViewBuilder private var moreRow: some View {
        if model.nextCursor != nil {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    Task { await model.loadMore() }
                } label: {
                    if model.loadingMore {
                        ProgressView().accessibilityLabel("Loading more memories")
                    } else {
                        Text("Show more")
                    }
                }
                .buttonStyle(BobSecondaryButtonStyle())
                .disabled(model.loadingMore)
                if model.moreFailed {
                    Text("Couldn't load more memories.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                }
            }
            .padding(.top, 12)
            .bobListRow(divider: false)
        }
    }
}

// Adding a memory and correcting one are the same field and the same rules. Errors stay beside the text.
struct MemoryEditorSheet: View {
    let memory: Memory?
    let model: MemoryModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var text: String
    @State private var kind: Memory.Kind = .fact
    @State private var saving = false
    @State private var notice: String?
    private let original: String

    init(memory: Memory?, model: MemoryModel) {
        self.memory = memory
        self.model = model
        let shown = memory.map { MemoryVoice.forReader($0.content) } ?? ""
        original = shown
        _text = State(initialValue: shown)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmed.isEmpty && trimmed != original }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "What should Bob remember?") {
                        TextField("What should Bob remember?", text: Binding(get: { text }, set: { text = String($0.prefix(MemoryRules.contentLimit)) }), axis: .vertical)
                            .lineLimit(3...12)
                            .focused($focused)
                    }
                    if memory == nil {
                        Picker("Kind", selection: $kind) {
                            Text("Fact").tag(Memory.Kind.fact)
                            Text("Preference").tag(Memory.Kind.preference)
                        }
                        .bobChoicePicker()
                        .frame(minHeight: 44)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .bobPage()
            .privacySensitive()
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(title: memory == nil ? "Add a memory" : "Edit memory", canSave: canSave, saving: saving, onCancel: { dismiss() }, onSave: save)
            }
        }
        .task { focused = true }
    }

    private func save() {
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                if let memory {
                    try await model.correct(memory, content: trimmed)
                } else {
                    try await model.create(content: trimmed, kind: kind)
                }
                dismiss()
            } catch ApiError.secretRefused {
                notice = ApiErrorMapper.userMessage(.secretRefused)
            } catch where isCancelled(error) {
                return
            } catch {
                notice = memory == nil ? "Couldn't add the memory. Try again." : "Couldn't save the change. Try again."
            }
        }
    }
}

// To-dos Bob picked up from conversations.
struct SuggestionsView: View {
    let model: MemoryModel

    var body: some View {
        List {
            if model.suggestionsFailed {
                BobLoadFailure(title: "Bob's suggestions could not be loaded", error: .unknown(status: 0)) { await model.refreshSuggestions() }
                    .bobListRow(divider: false)
            } else if model.suggestions.isEmpty {
                ContentUnavailableView {
                    Text("Nothing suggested").font(BobFont.heading)
                } description: {
                    Text("To-dos Bob picks up from your conversations show up here.")
                }
                .bobListRow(divider: false)
            }
            ForEach(model.suggestions) { row($0) }
        }
        .bobList()
        .privacySensitive()
        .refreshable { await model.refreshSuggestions() }
        .bobNavTitle("Suggested by Bob")
        .bobUndoBar(model.undo) { model.undo = nil }
        .bobErrorAlert(model.message) { model.message = nil }
        .task { await model.refreshSuggestions() }
    }

    private func row(_ item: ActionItem) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.content).font(BobFont.rowTitle)
                if let due = item.dueAt {
                    Text(MemoryRules.isOverdue(item, now: Date()) ? "Overdue, \(ProductivityText.day(due))" : "Due \(ProductivityText.day(due))")
                        .font(BobFont.subline)
                        .foregroundStyle(MemoryRules.isOverdue(item, now: Date()) ? BobColor.warnText : .secondary)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            Button("Add") { Task { await model.addAsTask(item) } }
                .font(BobFont.caption)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .buttonStyle(BobPressStyle())
                .accessibilityLabel("Add \(item.content) as a task")
        }
        .bobListRow()
        .swipeActions(edge: .leading) {
            Button("Done") { Task { await model.close(item, status: .done) } }
                .tint(BobColor.accent)
        }
        .swipeActions(edge: .trailing) {
            Button("Dismiss", role: .destructive) { Task { await model.close(item, status: .dropped) } }
        }
        .contextMenu {
            Button("Add as task") { Task { await model.addAsTask(item) } }
            Button("Mark done") { Task { await model.close(item, status: .done) } }
            Button("Dismiss", role: .destructive) { Task { await model.close(item, status: .dropped) } }
        }
    }
}

#Preview {
    NavigationStack {
        MemoryView(model: MemoryModel(service: StubMemoryService()))
    }
}
