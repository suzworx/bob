import BobKit
import SwiftUI

struct NotesView: View {
    let model: NotesModel
    var store: ProductivityStore? = nil
    @Binding var path: NavigationPath

    @State private var creating = false

    var body: some View {
        @Bindable var model = model
        List {
            if let store { SpaceScopeRow(store: store) }
            content
        }
        .bobList()
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search notes")
        .task(id: model.query) {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.search()
        }
        .refreshable { await model.refresh() }
        .bobNavTitle("Notes")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New note")
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Trash (\(model.trashed.count))") { path.append(ProductivityRoute.trashedNotes) }
            }
        }
        .sheet(isPresented: $creating) {
            NoteEditorSheet(note: nil, model: model).bobSheet()
        }
        .bobUndoBar(model.undo) { model.undo = nil }
        .bobErrorAlert(model.message) { model.message = nil }
        .task {
            await model.scope?.load()
            await model.refresh()
        }
    }

    @ViewBuilder private var content: some View {
        if model.searchFailed {
            BobLoadFailure(title: "Search failed", error: .unknown(status: 0)) { await model.search() }
                .bobListRow(divider: false)
        } else if let results = model.results {
            if results.isEmpty {
                ContentUnavailableView.search(text: model.query).bobListRow(divider: false)
            }
            ForEach(results) { row($0) }
        } else {
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading notes")
                    .frame(minHeight: 200)
                    .frame(maxWidth: .infinity)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load your notes", error: error) { await model.refresh() }
                    .bobListRow(divider: false)
            case .loaded:
                let groups = model.groups
                if groups.isEmpty {
                    ContentUnavailableView {
                        Text("No notes yet").font(BobFont.heading)
                    } description: {
                        Text("Keep a thought here, or ask Bob to.")
                    } actions: {
                        Button("Add a note") { creating = true }.buttonStyle(BobSecondaryButtonStyle())
                    }
                    .bobListRow(divider: false)
                }
                ForEach(groups) { group in
                    if let title = group.title {
                        BobGroupHeader(title: title)
                    }
                    ForEach(group.rows) { row($0) }
                }
            }
        }
    }

    private func row(_ note: Note) -> some View {
        NavigationLink(value: ProductivityRoute.note(note.id)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(note.title).font(BobFont.rowTitle)
                Text(NoteRules.preview(note) ?? "Edited \(ProductivityText.day(note.updatedAt))")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.vertical, 4)
        }
        .bobListRow()
        .swipeActions(edge: .leading) {
            Button(note.pinned ? "Unpin" : "Pin") {
                Task { await model.togglePin(note) }
            }
            .tint(BobColor.accent)
        }
        .swipeActions(edge: .trailing) {
            Button("Trash", role: .destructive) {
                Task { await model.trash(note) }
            }
        }
    }
}

struct TrashedNotesView: View {
    let model: NotesModel

    var body: some View {
        List {
            if model.trashed.isEmpty {
                ContentUnavailableView {
                    Text("Trash is empty").font(BobFont.heading)
                } description: {
                    Text("Notes you move to trash wait here, so you can bring them back.")
                }
                .bobListRow(divider: false)
            }
            ForEach(model.trashed) { note in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(note.title).font(BobFont.rowTitle)
                        if let trashedAt = note.trashedAt {
                            Text("Moved to trash \(ProductivityText.day(trashedAt))")
                                .font(BobFont.subline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    Button("Restore") {
                        Task { await model.restore(note) }
                    }
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Restore \(note.title)")
                }
                .bobListRow()
            }
        }
        .bobList()
        .bobNavTitle("Trash")
        .bobErrorAlert(model.message) { model.message = nil }
    }
}

#Preview {
    NavigationStack {
        NotesView(model: NotesModel(service: StubNotesService()), path: .constant(NavigationPath()))
    }
}
