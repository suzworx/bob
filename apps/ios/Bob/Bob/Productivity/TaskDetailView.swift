import BobKit
import SwiftUI

// One task: what it is, its checklist, and whether the person is told about changes.
struct TaskDetailView: View {
    let id: String
    let model: TasksModel

    @State private var detail: TaskDetailModel
    @State private var target = DetailLoadState()
    @State private var editing = false
    @Environment(\.dismiss) private var dismiss
    @FocusState private var addFocused: Bool

    init(id: String, model: TasksModel) {
        self.id = id
        self.model = model
        _detail = State(initialValue: TaskDetailModel(taskID: id, service: model.service))
    }

    var body: some View {
        Group {
            switch target.phase {
            case .loading:
                ProgressView("Loading task…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .bobPage()
            case .failed(.notFound):
                ContentUnavailableView {
                    Text("This task is gone").font(BobFont.heading)
                } description: {
                    Text(ApiErrorMapper.userMessage(.notFound))
                }
                .bobPage()
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load this task", error: error) { await load() }
                    .bobPage()
            case .loaded:
                if let task = model.task(id: id), task.trashedAt == nil {
                    content(task)
                } else {
                    BobLoadFailure(title: "Let's refresh this task", error: .upstream) { await load() }
                        .bobPage()
                }
            }
        }
        .bobNavTitle("Task")
        .bobErrorAlert(detail.message) { detail.message = nil }
        .task(id: id) { await load() }
    }

    private func load() async {
        await target.load { try await model.loadTarget(id: id) }
        if target.phase == .loaded { await detail.load() }
    }

    private func content(_ task: TaskItem) -> some View {
        List {
            VStack(alignment: .leading, spacing: 8) {
                TaskRowText(task: task, assignee: model.scope?.isShared == true ? model.scope?.name(of: task.assigneeUserID).map { "Assigned to \($0)" } : nil)
                if let body = task.body {
                    Text(body)
                        .font(BobFont.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .bobListRow()
            if detail.followReady {
                Toggle("Notify me about changes", isOn: Binding(
                    get: { detail.isFollowing },
                    set: { value in Task { await detail.setFollowing(value) } }
                ))
                .toggleStyle(BobToggleStyle())
                .bobListRow()
            }
            BobGroupHeader(title: "Checklist")
            checklist
        }
        .bobList()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { editing = true }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button(task.status == .open ? "Complete" : "Reopen") {
                    Task { await model.toggle(task) }
                }
            }
            ToolbarItem(placement: .secondaryAction) {
                if let others = model.scope?.others, !others.isEmpty {
                    Menu("Move to") {
                        ForEach(others) { space in
                            Button(space.name) {
                                dismiss()
                                Task { await model.move(task, to: space) }
                            }
                        }
                    }
                }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Delete", role: .destructive) {
                    dismiss()
                    Task { await model.delete(task) }
                }
            }
        }
        .sheet(isPresented: $editing) {
            TaskEditorSheet(task: task, model: model).bobSheet()
        }
    }

    @ViewBuilder private var checklist: some View {
        switch detail.phase {
        case .loading:
            ProgressView()
                .accessibilityLabel("Loading checklist")
                .bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load the checklist", error: error) { await detail.load() }
                .bobListRow(divider: false)
        case .loaded:
            ForEach(detail.items) { item in
                itemRow(item)
            }
            @Bindable var detail = detail
            HStack {
                TextField("Add an item", text: $detail.draft)
                    .focused($addFocused)
                    .submitLabel(.done)
                    .onSubmit { Task { await detail.add() } }
                if !detail.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button("Add") { Task { await detail.add() } }
                        .buttonStyle(.borderless)
                        .frame(minWidth: 44, minHeight: 44)
                }
            }
            .bobListRow()
        }
    }

    private func itemRow(_ item: TaskItem) -> some View {
        HStack(spacing: 4) {
            TaskTick(status: item.status, title: item.title) {
                Task { await detail.toggle(item) }
            }
            Text(item.title)
                .font(BobFont.rowTitle)
                .strikethrough(item.status == .completed)
                .foregroundStyle(item.status == .completed ? .secondary : .primary)
        }
        .bobListRow()
        .swipeActions(edge: .trailing) {
            Button("Remove", role: .destructive) {
                Task { await detail.remove(item) }
            }
        }
        .contextMenu {
            if detail.canMove(item, by: -1) {
                Button("Move up") { Task { await detail.move(item, by: -1) } }
            }
            if detail.canMove(item, by: 1) {
                Button("Move down") { Task { await detail.move(item, by: 1) } }
            }
            Button("Remove", role: .destructive) { Task { await detail.remove(item) } }
        }
    }
}
