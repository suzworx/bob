import BobKit
import SwiftUI

// New or changed task. A stale save keeps everything typed, and the next save applies it over the latest version.
struct TaskEditorSheet: View {
    let task: TaskItem?
    let model: TasksModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var titleFocused: Bool
    @State private var draft: TaskDraft
    @State private var hasDue: Bool
    @State private var hasTime: Bool
    @State private var date: Date
    @State private var saving = false
    @State private var confirmingDiscard = false
    @State private var notice: String?
    @State private var assignee: String?
    private let zone: String
    @State private var initial: TaskDraft

    init(task: TaskItem?, model: TasksModel) {
        self.task = task
        self.model = model
        let draft = task.map(TaskDraft.init(task:)) ?? TaskDraft()
        var zone = TimeZone.current.identifier
        if case .instant(_, let own) = task?.due { zone = own }
        self.zone = zone
        _draft = State(initialValue: draft)
        _initial = State(initialValue: draft)
        _assignee = State(initialValue: task?.assigneeUserID)
        _hasDue = State(initialValue: draft.dueDay != nil)
        _hasTime = State(initialValue: draft.dueTime != nil)
        let start = draft.dueDay.flatMap { WallClock.instant(day: $0, time: draft.dueTime ?? "09:00", zone: zone) }
        _date = State(initialValue: start ?? Date())
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice)
                            .font(BobFont.subline)
                            .foregroundStyle(BobColor.warnText)
                            .accessibilityAddTraits(.isStaticText)
                    }
                    BobField(label: "Title") {
                        TextField("Title", text: Binding(get: { draft.title }, set: { draft.title = String($0.prefix(200)) }))
                            .focused($titleFocused)
                    }
                    BobField(label: "Notes") {
                        TextField("Notes", text: Binding(get: { draft.notes }, set: { draft.notes = String($0.prefix(8000)) }), axis: .vertical)
                            .lineLimit(3...10)
                    }
                    dueFields
                    assigneeField
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
                BobSheetBar(title: task == nil ? "New task" : "Edit task", canSave: draft.isValid, saving: saving, onCancel: cancel, onSave: save)
            }
        }
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .task {
            if task == nil { titleFocused = true }
        }
    }

    // Only a shared space has someone else to give it to.
    @ViewBuilder private var assigneeField: some View {
        if let scope = model.scope, scope.isShared {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Assigned to")
                    Spacer()
                    Picker("Assigned to", selection: $assignee) {
                        Text("Nobody").tag(String?.none)
                        ForEach(scope.people) { member in
                            Text(member.userID == scope.me ? "Me" : SpaceRules.displayName(member)).tag(String?.some(member.userID))
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                }
                .frame(minHeight: 44)
                BobDivider()
            }
        }
    }

    @ViewBuilder private var dueFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Due date", isOn: $hasDue).toggleStyle(BobToggleStyle())
            if hasDue {
                DatePicker("Date", selection: $date, displayedComponents: .date)
                    .frame(minHeight: 44)
                Toggle("Time", isOn: $hasTime).toggleStyle(BobToggleStyle())
                if hasTime {
                    DatePicker("Time", selection: $date, displayedComponents: .hourAndMinute)
                        .frame(minHeight: 44)
                }
            }
            BobDivider()
        }
        .environment(\.timeZone, TimeZone(identifier: zone) ?? .current)
    }

    private var currentDraft: TaskDraft {
        var current = draft
        current.dueDay = hasDue ? WallClock.day(date, zone: zone) : nil
        current.dueTime = hasDue && hasTime ? WallClock.time(date, zone: zone) : nil
        return current
    }

    private var isDirty: Bool { currentDraft != initial || assignee != task?.assigneeUserID }

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
        let current = currentDraft
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                if let task {
                    // The list holds the newest revision, including one fetched after a conflict.
                    let base = model.task(id: task.id) ?? task
                    var changes = current.changes(from: base, defaultZone: zone)
                    if assignee != base.assigneeUserID { changes.assigneeUserID = .some(assignee) }
                    if !changes.isEmpty {
                        try await model.update(base, changes: changes)
                    }
                } else {
                    try await model.create(current, assignee: assignee)
                }
                dismiss()
            } catch is RevisionConflict {
                notice = "This task changed elsewhere. Your edits are kept. Save again to apply them."
            } catch {
                notice = productivityMessage(error)
            }
        }
    }
}
