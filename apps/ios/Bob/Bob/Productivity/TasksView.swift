import BobKit
import SwiftUI

struct TasksView: View {
    let model: TasksModel
    var store: ProductivityStore? = nil
    @Binding var path: NavigationPath

    @State private var creating = false

    var body: some View {
        @Bindable var model = model
        List {
            if let store { SpaceScopeRow(store: store) }
            Picker("Show tasks", selection: $model.view) {
                ForEach(TaskView.allCases) { Text($0.title).tag($0) }
            }
            .bobChoicePicker()
            .controlSize(.large)
            .bobListRow(divider: false)
            content
        }
        .bobList()
        .refreshable { await model.refresh() }
        .bobNavTitle("Tasks")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New task")
            }
            ToolbarItem(placement: .secondaryAction) {
                Picker("Sort", selection: $model.sort) {
                    ForEach(TaskSort.allCases) { Text($0.title).tag($0) }
                }
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Recently deleted") { path.append(ProductivityRoute.deletedTasks) }
            }
        }
        .sheet(isPresented: $creating) {
            TaskEditorSheet(task: nil, model: model).bobSheet()
        }
        .bobUndoBar(model.undo) { model.undo = nil }
        .bobErrorAlert(model.message) { model.message = nil }
        .task {
            await model.scope?.load()
            await model.refresh()
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView()
                .accessibilityLabel("Loading tasks")
                .frame(minHeight: 200)
                .frame(maxWidth: .infinity)
                .bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load your tasks", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loaded:
            let groups = model.groups(now: Date())
            if groups.isEmpty {
                empty.bobListRow(divider: false)
            }
            ForEach(groups) { group in
                if let title = group.title {
                    BobGroupHeader(title: title)
                }
                ForEach(group.rows) { task in
                    row(task)
                }
            }
        }
    }

    @ViewBuilder private var empty: some View {
        switch model.view {
        case .open:
            ContentUnavailableView {
                Text("No tasks yet").font(BobFont.heading)
            } description: {
                Text("Add one and it shows up here.")
            } actions: {
                Button("Add a task") { creating = true }.buttonStyle(BobSecondaryButtonStyle())
            }
        case .mine:
            ContentUnavailableView {
                Text("Nothing assigned to you").font(BobFont.heading)
            } description: {
                Text("Tasks someone gives you land here.")
            }
        case .done:
            ContentUnavailableView {
                Text("Nothing done yet").font(BobFont.heading)
            } description: {
                Text("Tick a task and it moves here.")
            }
        }
    }

    private func row(_ task: TaskItem) -> some View {
        HStack(spacing: 4) {
            TaskTick(status: task.status, title: task.title) {
                Task { await model.toggle(task) }
            }
            NavigationLink(value: ProductivityRoute.task(task.id)) {
                TaskRowText(task: task, assignee: model.scope?.isShared == true ? model.scope?.name(of: task.assigneeUserID) : nil)
            }
        }
        .bobListRow()
        .swipeActions(edge: .leading) {
            Button(task.status == .open ? "Complete" : "Reopen") {
                Task { await model.toggle(task) }
            }
            .tint(BobColor.okText)
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) {
                Task { await model.delete(task) }
            }
        }
    }
}

// The round tick every task and checklist row shares.
struct TaskTick: View {
    let status: TaskStatus
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: status == .completed ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(status == .completed ? BobColor.okText : Color.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(status == .completed ? "Reopen \(title)" : "Complete \(title)")
    }
}

// Title and due line. Overdue is said in words, never by colour alone.
struct TaskRowText: View {
    let task: TaskItem
    var assignee: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(task.title)
                .font(BobFont.rowTitle)
                .strikethrough(task.status == .completed)
                .foregroundStyle(task.status == .completed ? .secondary : .primary)
            if let due = task.due {
                HStack(spacing: 6) {
                    Text(ProductivityText.due(due)).foregroundStyle(.secondary)
                    if TaskRules.isOverdue(task, now: Date()) {
                        Text("Overdue").foregroundStyle(BobColor.dangerText)
                    }
                }
                .font(BobFont.subline)
            }
            if let assignee {
                Text(assignee).font(BobFont.subline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

struct DeletedTasksView: View {
    let model: TasksModel

    var body: some View {
        List {
            switch model.deletedPhase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading deleted tasks")
                    .frame(minHeight: 200)
                    .frame(maxWidth: .infinity)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load deleted tasks", error: error) { await model.refreshDeleted() }
                    .bobListRow(divider: false)
            case .loaded:
                if model.deleted.isEmpty {
                    ContentUnavailableView {
                        Text("Nothing deleted").font(BobFont.heading)
                    } description: {
                        Text("Tasks you delete wait here, so you can bring them back.")
                    }
                    .bobListRow(divider: false)
                }
                ForEach(model.deleted) { task in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title).font(BobFont.rowTitle)
                            if let trashedAt = task.trashedAt {
                                Text("Deleted \(ProductivityText.day(trashedAt))")
                                    .font(BobFont.subline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Button("Restore") {
                            Task { await model.restore(task.id) }
                        }
                        .buttonStyle(.borderless)
                        .frame(minHeight: 44)
                        .accessibilityLabel("Restore \(task.title)")
                    }
                    .bobListRow()
                }
            }
        }
        .bobList()
        .bobNavTitle("Recently deleted")
        .refreshable { await model.refreshDeleted() }
        .bobErrorAlert(model.message) { model.message = nil }
        .task { await model.refreshDeleted() }
    }
}

#Preview {
    NavigationStack {
        TasksView(model: TasksModel(service: StubTasksService()), path: .constant(NavigationPath()))
    }
}
