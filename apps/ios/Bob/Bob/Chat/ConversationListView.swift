import BobKit
import SwiftUI
import UIKit

private struct SharedChat: Identifiable {
    let id = UUID()
    let text: String
}

// Every past chat: pinned, today, earlier, and archived last.
struct ConversationListView: View {
    let model: ConversationListModel
    let chat: ChatViewModel
    let onOpen: (String) -> Void
    let onNew: () -> Void
    var onShared: (() -> Void)? = nil
    var onGlobalSearch: (() -> Void)? = nil

    @State private var renaming: ConversationSummary?
    @State private var deleting: ConversationSummary?
    @State private var sharing: SharedChat?
    @State private var toolsConversation: ConversationSummary?
    @State private var handoff: DeviceHandoffRequest?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        @Bindable var model = model
        List {
            if let onGlobalSearch, model.isSearching {
                Button(action: onGlobalSearch) {
                    Label("Search everything", systemImage: "magnifyingglass")
                        .font(BobFont.rowTitle)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .accessibilityHint("Search chats, tasks, notes and memories")
                .bobListRow()
            }
            content
        }
        .bobList()
        .toolbar {
            // Only the Chats tab composes here; other uses of this list bring their own New chat.
            if onShared != nil {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("New chat", systemImage: "square.and.pencil", action: onNew)
                        Button("New conversation on device", systemImage: "desktopcomputer") {
                            handoff = DeviceHandoffRequest(title: "New conversation on device", target: .newConversation(spaceID: nil))
                        }
                    } label: {
                        Image(systemName: "square.and.pencil").frame(minWidth: 44, minHeight: 44)
                    } primaryAction: {
                        onNew()
                    }
                    .accessibilityLabel("New chat")
                    .accessibilityHint("Touch and hold to start on a device")
                }
            }
        }
        .privacySensitive()
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats")
        .task(id: model.query) {
            if model.phase != .loading { try? await Task.sleep(for: .milliseconds(250)) }
            guard !Task.isCancelled else { return }
            await model.refresh()
        }
        .refreshable { await model.refresh() }
        .bobNavTitle("Chats")
        .bobUndoBar(model.undo) { model.undo = nil }
        .bobErrorAlert(model.message) { model.message = nil }
        .sheet(item: $renaming) { row in
            ConversationRenameSheet(row: row, model: model) { chat.conversationRenamed(row.id, title: $0) }.bobSheet()
        }
        .sheet(item: $handoff) { request in DeviceHandoffSheet(request: request) }
        .sheet(item: $toolsConversation) { row in
            ToolsSheet(context: .conversation(row.id), title: "Chat tools")
        }
        .sheet(item: $sharing) { ShareSheet(text: $0.text) }
        .alert(
            "Delete this chat?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { row in
            Button("Delete", role: .destructive) {
                Task {
                    if await model.delete(row) { chat.conversationDeleted(row.id) }
                }
            }
            Button("Keep it", role: .cancel) {}
        } message: { row in
            Text("“\(row.displayTitle)” and its messages will be deleted. Memories saved from it stay.")
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .accessibilityLabel("Loading chats")
                .frame(minHeight: 200)
                .frame(maxWidth: .infinity)
                .bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load your chats", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loaded:
            loaded
        }
    }

    @ViewBuilder private var loaded: some View {
        if let onShared, !model.isSearching {
            Button(action: onShared) {
                HStack(spacing: 12) {
                    Image(systemName: "person.2")
                        .font(.body)
                        .foregroundStyle(BobColor.accent)
                        .accessibilityHidden(true)
                    Text("Group chats").font(BobFont.rowTitle)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(BobColor.muted)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .bobListRow()
        }
        if model.conversations.isEmpty, model.isSearching {
            ContentUnavailableView.search(text: model.query).bobListRow(divider: false)
        } else if model.conversations.isEmpty, model.archived.isEmpty {
            ContentUnavailableView {
                Text("No chats yet").font(BobFont.heading)
            } description: {
                Text("Your conversations with Bob stay here.")
            } actions: {
                Button("New chat", action: onNew).buttonStyle(BobSecondaryButtonStyle())
            }
            .bobListRow(divider: false)
        } else {
            ForEach(model.groups(now: Date())) { group in
                BobGroupHeader(title: group.title)
                ForEach(group.rows) { row($0) }
            }
            if !model.isSearching { archivedSection }
        }
    }

    @ViewBuilder private var archivedSection: some View {
        @Bindable var model = model
        if !model.archived.isEmpty {
            Button {
                model.showsArchived.toggle()
            } label: {
                HStack {
                    Text("Archived, \(model.archived.count)").font(BobFont.caption).foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: model.showsArchived ? "chevron.up" : "chevron.down")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .padding(.top, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityValue(model.showsArchived ? "Shown" : "Hidden")
            .bobListRow(divider: false)
            if model.showsArchived {
                ForEach(model.archived) { row($0) }
            }
        }
    }

    private func row(_ row: ConversationSummary) -> some View {
        let isOpen = row.id == chat.transcript.conversationID
        return Button {
            onOpen(row.id)
        } label: {
            HStack(spacing: 12) {
                if dynamicTypeSize.isAccessibilitySize {
                    // At the largest sizes the title gets the whole width, and the time sits under it.
                    VStack(alignment: .leading, spacing: 4) {
                        rowTitle(row, isOpen: isOpen)
                        rowMeta(row)
                    }
                } else {
                    rowTitle(row, isOpen: isOpen)
                    VStack(alignment: .trailing, spacing: 4) { rowMeta(row) }
                }
            }
            .padding(.vertical, 10)
            .frame(minHeight: 64)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityValue(isOpen ? "Open now" : "")
        .accessibilityHint("Opens this chat")
        .bobListRow()
        .swipeActions(edge: .leading) {
            if row.archived {
                Button("Unarchive") { Task { await model.unarchive(row) } }.tint(BobColor.accent)
            } else {
                Button(row.pinned ? "Unpin" : "Pin") { Task { await model.setPinned(row, pinned: !row.pinned) } }.tint(BobColor.accent)
            }
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) { deleting = row }
            if !row.archived {
                Button("Archive") { Task { await model.archive(row) } }
            }
        }
        .contextMenu {
            if row.archived {
                Button("Unarchive") { Task { await model.unarchive(row) } }
            } else {
                Button(row.pinned ? "Unpin" : "Pin") { Task { await model.setPinned(row, pinned: !row.pinned) } }
                Button("Rename") { renaming = row }
            }
            if !row.archived {
                Button("Tools") { toolsConversation = row }
                Button("Use on device") { handoff = DeviceHandoffRequest(title: row.displayTitle, target: .conversation(id: row.id, spaceID: nil)) }
            }
            Button("Share") { share(row) }
            if !row.archived {
                Button("Archive") { Task { await model.archive(row) } }
            }
            Button("Delete", role: .destructive) { deleting = row }
        }
    }

    private func rowTitle(_ row: ConversationSummary, isOpen: Bool) -> some View {
        Text(row.displayTitle)
            .font(BobFont.rowTitle.weight(isOpen ? .semibold : .regular))
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func rowMeta(_ row: ConversationSummary) -> some View {
        Text(ConversationRules.rowTime(row.updatedAt, now: Date()))
            .font(.footnote)
            .foregroundStyle(BobColor.muted)
            .lineLimit(1)
            .fixedSize()
        if row.pinned {
            Image(systemName: "pin.fill")
                .font(.caption2)
                .foregroundStyle(BobColor.muted)
                .accessibilityLabel("Pinned")
        }
    }

    private func share(_ row: ConversationSummary) {
        Task {
            if let text = await model.markdown(row) { sharing = SharedChat(text: text) }
        }
    }
}

// A failed save says so beside the words and keeps them.
private struct ConversationRenameSheet: View {
    let row: ConversationSummary
    let model: ConversationListModel
    let onRenamed: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var title: String
    @State private var saving = false
    @State private var failed = false
    @State private var confirmingDiscard = false

    init(row: ConversationSummary, model: ConversationListModel, onRenamed: @escaping (String) -> Void) {
        self.row = row
        self.model = model
        self.onRenamed = onRenamed
        _title = State(initialValue: row.title)
    }

    private var trimmed: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if failed {
                        Text("Couldn't rename it. Try again.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "Chat name") {
                        TextField("Chat name", text: Binding(get: { title }, set: { title = String($0.prefix(ConversationsClient.titleLimit)) }))
                            .focused($focused)
                            .submitLabel(.done)
                            .onSubmit { if canSave { save() } }
                    }
                }
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.top, 12)
            }
            .disabled(saving)
            .bobPage()
            .privacySensitive()
            .bobNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(title: "Rename chat", canSave: canSave, saving: saving, onCancel: cancel, onSave: save)
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
        EditorDismissalPolicy(hasUnsavedChanges: title != row.title, isSaving: saving)
    }

    private func cancel() {
        switch dismissalPolicy.cancelAction {
        case .dismiss: dismiss()
        case .confirmDiscard: confirmingDiscard = true
        case .blocked: break
        }
    }

    private var canSave: Bool { !trimmed.isEmpty && trimmed != row.title && !saving }

    private func save() {
        saving = true
        failed = false
        Task {
            defer { saving = false }
            do {
                try await model.rename(row, title: trimmed)
                onRenamed(trimmed)
                dismiss()
            } catch {
                failed = !isCancelled(error)
            }
        }
    }
}

// The system share sheet, given the text itself so no file is written.
private struct ShareSheet: UIViewControllerRepresentable {
    let text: String

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [text], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
