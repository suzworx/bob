import BobKit
import SwiftUI

// New or changed note. A stale save never loses the text: the latest saved version shows beside it, and the next save goes over that version.
struct NoteEditorSheet: View {
    let note: Note?
    let model: NotesModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var titleFocused: Bool
    @State private var title: String
    @State private var text: String
    @State private var revision: Int
    @State private var saving = false
    @State private var notice: String?
    @State private var latest: Note?
    @State private var confirmingDiscard = false

    init(note: Note?, model: NotesModel) {
        self.note = note
        self.model = model
        _title = State(initialValue: note?.title ?? "")
        _text = State(initialValue: note?.body ?? "")
        _revision = State(initialValue: note?.revision ?? 1)
    }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isDirty: Bool { title != (note?.title ?? "") || text != (note?.body ?? "") }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.warnText)
                    }
                    if let latest {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Latest saved").font(BobFont.caption).foregroundStyle(.secondary)
                            Text(latest.title).font(BobFont.rowTitle)
                            Text(latest.body).font(BobFont.subline).foregroundStyle(.secondary).textSelection(.enabled)
                            BobDivider().padding(.top, 8)
                        }
                    }
                    BobField(label: "Title") {
                        TextField("Title", text: Binding(get: { title }, set: { title = String($0.prefix(NoteRules.titleLimit)) }))
                            .focused($titleFocused)
                    }
                    BobField(label: "Note") {
                        TextField("Note", text: Binding(get: { text }, set: { text = String($0.prefix(NoteRules.bodyLimit)) }), axis: .vertical)
                            .lineLimit(8...)
                    }
                }
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .disabled(saving)
            .bobPage()
            .bobNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(
                    title: note == nil ? "New note" : "Edit note",
                    canSave: !trimmedTitle.isEmpty && isDirty,
                    saving: saving,
                    onCancel: cancel,
                    onSave: save
                )
            }
            .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
        .task {
            if note == nil { titleFocused = true }
        }
    }

    private var dismissalPolicy: EditorDismissalPolicy {
        EditorDismissalPolicy(hasUnsavedChanges: isDirty, isSaving: saving)
    }

    private func cancel() {
        switch dismissalPolicy.cancelAction {
        case .dismiss: dismiss()
        case .confirmDiscard: confirmingDiscard = true
        case .blocked: break
        }
    }

    private func save() {
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                if let note {
                    try await model.save(id: note.id, revision: revision, title: trimmedTitle, body: text)
                } else {
                    try await model.create(title: trimmedTitle, body: text)
                }
                dismiss()
            } catch let conflict as RevisionConflict {
                notice = "Someone saved this note while you were editing. Your text is kept. Check the latest version, then save again."
                revision = conflict.currentRevision
                if let note {
                    latest = await model.latest(id: note.id)
                    revision = latest?.revision ?? revision
                }
            } catch {
                notice = productivityMessage(error)
            }
        }
    }
}
