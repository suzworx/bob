import BobKit
import SwiftUI

struct NoteDetailView: View {
    let id: String
    let model: NotesModel
    @Binding var path: NavigationPath

    @State private var target = DetailLoadState()
    @State private var editing = false
    @State private var copying = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            switch target.phase {
            case .loading:
                ProgressView("Loading note…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .bobPage()
            case .failed(.notFound):
                ContentUnavailableView {
                    Text("This note is gone").font(BobFont.heading)
                } description: {
                    Text(ApiErrorMapper.userMessage(.notFound))
                }
                .bobPage()
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load this note", error: error) { await load() }
                    .bobPage()
            case .loaded:
                if let note = model.note(id: id), note.trashedAt == nil {
                    content(note)
                } else {
                    BobLoadFailure(title: "Let's refresh this note", error: .upstream) { await load() }
                        .bobPage()
                }
            }
        }
        .bobNavTitle("Note")
        .bobErrorAlert(model.message) { model.message = nil }
        .task(id: id) { await load() }
    }

    private func load() async {
        await target.load { try await model.loadTarget(id: id) }
    }

    private func content(_ note: Note) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(note.title)
                    .font(BobFont.heading)
                    .accessibilityAddTraits(.isHeader)
                Text((note.pinned ? "Pinned · " : "") + "Edited \(ProductivityText.moment(note.updatedAt))")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                if !note.body.isEmpty {
                    Text(note.body)
                        .font(BobFont.body)
                        .textSelection(.enabled)
                        .padding(.top, 12)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .bobPage()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { editing = true }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button(note.pinned ? "Unpin" : "Pin") {
                    Task { await model.togglePin(note) }
                }
            }
            ToolbarItem(placement: .secondaryAction) {
                // A private note may be copied into a shared space; a shared one stays where it is.
                if model.scope?.current?.kind == .private {
                    Button("Copy to another space") { copying = true }
                }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("History") { path.append(ProductivityRoute.noteHistory(note.id)) }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Move to trash", role: .destructive) {
                    dismiss()
                    Task { await model.trash(note) }
                }
            }
        }
        .sheet(isPresented: $editing) {
            NoteEditorSheet(note: note, model: model).bobSheet()
        }
        .sheet(isPresented: $copying) {
            NoteCopySheet(note: note, model: model).bobSheet()
        }
    }
}

// The person picks the space and the fields, and sees exactly what will be copied. The private note stays as it is.
private struct NoteCopySheet: View {
    let note: Note
    let model: NotesModel

    @Environment(\.dismiss) private var dismiss
    @State private var spaceID: String?
    @State private var withBody = true
    @State private var saving = false
    @State private var notice: String?

    private var targets: [SpaceSummary] { model.scope?.sharedSpaces ?? [] }
    private var target: SpaceSummary? { targets.first { $0.id == spaceID } ?? targets.first }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    if targets.isEmpty {
                        Text("Join or create a shared space first.").font(BobFont.body)
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("Space")
                                Spacer()
                                Picker("Space", selection: Binding(get: { target?.id }, set: { spaceID = $0 })) {
                                    ForEach(targets) { Text($0.name).tag(String?.some($0.id)) }
                                }
                                .labelsHidden()
                                .pickerStyle(.menu)
                            }
                            .frame(minHeight: 44)
                            BobDivider()
                        }
                        Toggle("Include the note's text", isOn: $withBody).toggleStyle(BobToggleStyle())
                        VStack(alignment: .leading, spacing: 4) {
                            Text("What will be copied").font(BobFont.caption).foregroundStyle(.secondary)
                            Text(note.title).font(BobFont.rowTitle)
                            if withBody, !note.body.isEmpty {
                                Text(note.body).font(BobFont.subline).foregroundStyle(.secondary).lineLimit(6)
                            }
                        }
                        Text("Everyone in \(target?.name ?? "the space") will see this copy. Your note stays private.")
                            .font(BobFont.subline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .bobPage()
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(title: "Copy to another space", canSave: target != nil, saving: saving, onCancel: { dismiss() }, onSave: save)
            }
        }
        .task { await model.scope?.load() }
    }

    private func save() {
        guard let target else { return }
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                _ = try await model.service.publish(noteID: note.id, toSpace: target.id, includingBody: withBody)
                AccessibilityAnnouncer.say("Copied to \(target.name)")
                dismiss()
            } catch {
                notice = productivityMessage(error)
            }
        }
    }
}

// The saved versions of a note, newest as the server orders them.
struct NoteHistoryView: View {
    let noteID: String
    let service: NotesService

    @State private var revisions: [NoteRevision] = []
    @State private var phase: LoadPhase = .loading

    var body: some View {
        List {
            switch phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading history")
                    .frame(minHeight: 200)
                    .frame(maxWidth: .infinity)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load the history", error: error) { await load() }
                    .bobListRow(divider: false)
            case .loaded:
                if revisions.isEmpty {
                    ContentUnavailableView {
                        Text("No earlier versions").font(BobFont.heading)
                    } description: {
                        Text("Each save adds a version here.")
                    }
                    .bobListRow(divider: false)
                }
                ForEach(revisions) { revision in
                    NavigationLink(value: ProductivityRoute.noteRevision(revision)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Version \(revision.revision)").font(BobFont.rowTitle)
                            Text(ProductivityText.moment(revision.createdAt) + (revision.aiAssisted ? " · AI assisted" : ""))
                                .font(BobFont.subline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                    .bobListRow()
                }
            }
        }
        .bobList()
        .bobNavTitle("History")
        .task { await load() }
    }

    private func load() async {
        do {
            revisions = try await service.revisions(noteID: noteID)
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            phase = .failed(apiError(error))
        }
    }
}

struct NoteRevisionView: View {
    let revision: NoteRevision

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(revision.title).font(BobFont.heading).accessibilityAddTraits(.isHeader)
                Text(ProductivityText.moment(revision.createdAt)).font(BobFont.subline).foregroundStyle(.secondary)
                Text(revision.body).font(BobFont.body).textSelection(.enabled).padding(.top, 12)
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .bobPage()
        .bobNavTitle("Version \(revision.revision)")
    }
}
