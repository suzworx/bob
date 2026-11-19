import BobKit
import SwiftUI

private struct ReminderEditTarget: Identifiable {
    let id = UUID()
    let reminder: Reminder?
}

struct RemindersView: View {
    let model: RemindersModel
    var store: ProductivityStore? = nil

    @State private var editing: ReminderEditTarget?
    @State private var snoozing: Reminder?

    var body: some View {
        List {
            if let store { SpaceScopeRow(store: store) }
            content
        }
        .bobList()
        .refreshable { await model.refresh() }
        .bobNavTitle("Reminders")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editing = ReminderEditTarget(reminder: nil) } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New reminder")
            }
        }
        .sheet(item: $editing) { target in
            ReminderEditorSheet(reminder: target.reminder, model: model).bobSheet()
        }
        .confirmationDialog(
            "Snooze",
            isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }),
            titleVisibility: .visible,
            presenting: snoozing
        ) { reminder in
            snoozeButtons(reminder)
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
                .accessibilityLabel("Loading reminders")
                .frame(minHeight: 200)
                .frame(maxWidth: .infinity)
                .bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load your reminders", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loaded:
            let groups = model.groups(now: Date())
            if groups.isEmpty {
                ContentUnavailableView {
                    Text("No reminders yet").font(BobFont.heading)
                } description: {
                    Text("Set one and Bob will nudge you.")
                } actions: {
                    Button("Add a reminder") { editing = ReminderEditTarget(reminder: nil) }
                        .buttonStyle(BobSecondaryButtonStyle())
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

    private func row(_ reminder: Reminder) -> some View {
        Button {
            editing = ReminderEditTarget(reminder: reminder)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(reminder.title).font(BobFont.rowTitle)
                Text(subline(reminder))
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityHint("Edits this reminder")
        .bobListRow()
        .swipeActions(edge: .leading) {
            if reminder.rule == nil {
                Button("Snooze") { snoozing = reminder }
                    .tint(BobColor.accent)
            }
        }
        .swipeActions(edge: .trailing) {
            Button("Cancel reminder", role: .destructive) {
                Task { await model.cancel(reminder) }
            }
        }
        .contextMenu {
            Button("Edit") { editing = ReminderEditTarget(reminder: reminder) }
            if reminder.rule == nil {
                Menu("Snooze") { snoozeButtons(reminder) }
            }
            Button("Cancel reminder", role: .destructive) {
                Task { await model.cancel(reminder) }
            }
        }
    }

    @ViewBuilder private func snoozeButtons(_ reminder: Reminder) -> some View {
        let zone = reminder.dueZone ?? TimeZone.current.identifier
        ForEach(SnoozeChoice.choices(now: Date(), zone: zone)) { choice in
            Button(choice.label) {
                Task { await model.snooze(reminder, choice: choice) }
            }
        }
    }

    // A repeating reminder's stored time is only its first ring, so it reads as a rule and a time of day.
    private func subline(_ reminder: Reminder) -> String {
        guard let due = reminder.dueAt else { return "No time set" }
        let zone = reminder.dueZone
        guard let rule = reminder.rule else { return ProductivityText.moment(due, zone: zone) }
        let words = ReminderRules.describe(rule)
        return rule.freq == .hourly ? words : "\(words), \(ProductivityText.time(due, zone: zone))"
    }
}

#Preview {
    NavigationStack {
        RemindersView(model: RemindersModel(service: StubRemindersService()))
    }
}
