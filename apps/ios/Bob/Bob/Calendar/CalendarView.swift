import BobKit
import SwiftUI

// Calendar can be pushed inside Today or presented as a standalone screen.
struct CalendarView: View {
    let model: CalendarModel
    var embedded = false

    @Environment(\.scenePhase) private var scenePhase
    @State private var snoozing: Reminder?
    @State private var cancellingShared: Reminder?
    @State private var timers = RunningTimersSection.makeModel()

    var body: some View {
        Group {
            if embedded { calendarContent }
            else { NavigationStack { calendarContent } }
        }
        .tint(BobColor.accent)
        .task { await timers.refresh() }
        .task(id: scenePhase == .active && !timers.timers.isEmpty) {
            guard scenePhase == .active, !timers.timers.isEmpty else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                await timers.tick()
            }
        }
        .onDisappear { timers.stop() }
    }

    private var calendarContent: some View {
        List {
            RunningTimersSection(model: timers)
            MonthGridView(model: model)
                .padding(.top, 4)
                .bobListRow(divider: false)
            content
        }
        .bobList()
        .refreshable {
            async let calendarRefresh: Void = model.refresh()
            async let timerRefresh: Void = timers.refresh()
            _ = await (calendarRefresh, timerRefresh)
        }
        .bobNavTitle("Calendar")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Event") { model.sheet = .newEvent(day: model.selectedDay) }
                    Button("Reminder") { model.sheet = .newReminder }
                    Button("Task") { model.sheet = .newTask }
                } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("New")
            }
        }
        .sheet(item: Binding(get: { model.sheet }, set: { model.sheet = $0 }), onDismiss: { Task { await model.refresh() } }) { sheet in
            sheetContent(sheet).bobSheet()
        }
        .confirmationDialog(
            "Snooze",
            isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }),
            titleVisibility: .visible,
            presenting: snoozing
        ) { reminder in
            snoozeButtons(reminder)
        }
        .confirmationDialog(
            "Cancel \(cancellingShared?.title ?? "reminder")?",
            isPresented: Binding(get: { cancellingShared != nil }, set: { if !$0 { cancellingShared = nil } }),
            titleVisibility: .visible,
            presenting: cancellingShared
        ) { reminder in
            Button("Cancel reminder", role: .destructive) { Task { await model.cancel(reminder) } }
            Button("Keep it", role: .cancel) {}
        } message: { _ in
            Text("It stops for everyone in that space, not just you.")
        }
        .bobUndoBar(model.undo) { model.undo = nil }
        .bobErrorAlert(model.message) { model.message = nil }
        // Each month is loaded when it comes on screen; picking a day inside it needs nothing new.
        .task(id: model.month) { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await model.refresh() }
                Task { await timers.refresh() }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .failed(let error):
            BobLoadFailure(title: "The calendar could not be loaded", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loading:
            loadingRow
        case .loaded where model.loadedMonth != model.month:
            // A month with no answer yet says it's loading, never that it's empty.
            loadingRow
        case .loaded:
            notices
            BobGroupHeader(title: CalendarDays.groupTitle(model.selectedDay, today: model.today, count: model.selectedEntries.count))
            if model.selectedEntries.isEmpty {
                ContentUnavailableView {
                    Text("Nothing on this day").font(BobFont.heading)
                } description: {
                    Text("Tasks, events and reminders show up here.")
                } actions: {
                    Button("New event") { model.sheet = .newEvent(day: model.selectedDay) }
                        .buttonStyle(BobSecondaryButtonStyle())
                }
                .bobListRow(divider: false)
            }
            ForEach(model.selectedEntries) { row($0) }
            if !model.comingUp.isEmpty {
                Text("Coming up")
                    .font(BobFont.heading)
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 24)
                    .bobListRow(divider: false)
                ForEach(model.comingUp, id: \.day) { group in
                    BobGroupHeader(title: CalendarDays.groupTitle(group.day, today: model.today, count: group.entries.count))
                    ForEach(group.entries) { row($0) }
                }
            }
        }
    }

    private var loadingRow: some View {
        ProgressView()
            .accessibilityLabel("Loading your calendar")
            .frame(minHeight: 120)
            .frame(maxWidth: .infinity)
            .bobListRow(divider: false)
    }

    @ViewBuilder private var notices: some View {
        if !model.unavailableSpaces.isEmpty {
            notice("Could not load \(model.unavailableSpaces.joined(separator: ", ")).", retry: true)
        }
        if model.eventsUnavailable {
            notice("Events could not be loaded.", retry: true)
        }
        switch model.googleNotice {
        case .none:
            EmptyView()
        case .incomplete:
            notice("Some Google events could not be shown. Your other events are still here.", retry: false)
        case .reconnect:
            VStack(alignment: .leading, spacing: 8) {
                Text("Some Google events could not be shown. Reconnect your account in Integrations. Your other events are still here.")
                    .font(BobFont.subline).foregroundStyle(BobColor.warnText)
                NavigationLink("Manage integrations") { IntegrationsView() }
                    .font(BobFont.rowTitle).frame(minHeight: 44)
            }
            .bobListRow(divider: false)
        }
    }

    private func notice(_ text: String, retry: Bool) -> some View {
        HStack(spacing: 12) {
            Text(text).font(BobFont.subline).foregroundStyle(BobColor.warnText)
            if retry {
                Spacer(minLength: 8)
                Button("Try again") { Task { await model.refresh() } }
                    .font(BobFont.caption)
                    .frame(minHeight: 44)
                    .buttonStyle(BobPressStyle())
            }
        }
        .bobListRow(divider: false)
    }

    @ViewBuilder private func row(_ entry: CalendarEntry) -> some View {
        switch entry.kind {
        case .event(let item):
            eventRow(entry, item)
        case .google(let item):
            openRow(entry, hint: "Shows this Google event") { model.sheet = .google(item) }
        case .task(let task):
            taskRow(entry, task)
        case .reminder(let reminder, _):
            reminderRow(entry, reminder)
        }
    }

    private func openRow(_ entry: CalendarEntry, hint: String, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            rowText(entry)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityHint(hint)
        .bobListRow()
    }

    private func rowText(_ entry: CalendarEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.title).font(BobFont.rowTitle)
            Text(CalendarRules.subline(entry, zone: model.zone))
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func eventRow(_ entry: CalendarEntry, _ item: AgendaItem) -> some View {
        let editable = item.origin == "native" && item.canEdit
        return openRow(entry, hint: editable ? "Edits this event" : "Shows this event") {
            model.sheet = editable ? .editEvent(item) : .viewEvent(item)
        }
    }

    private func taskRow(_ entry: CalendarEntry, _ task: TaskItem) -> some View {
        HStack(spacing: 12) {
            Button {
                Task { await model.complete(task) }
            } label: {
                Image(systemName: "circle")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityLabel("Complete \(task.title)")
            Button { model.sheet = .editTask(task) } label: {
                rowText(entry)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityHint("Edits this task")
        }
        .bobListRow()
        .swipeActions(edge: .leading) {
            Button("Complete") { Task { await model.complete(task) } }
                .tint(BobColor.accent)
        }
    }

    private func reminderRow(_ entry: CalendarEntry, _ reminder: Reminder) -> some View {
        openRow(entry, hint: "Edits this reminder") { model.sheet = .editReminder(reminder) }
            .swipeActions(edge: .leading) {
                if reminder.rule == nil {
                    Button("Snooze") { snoozing = reminder }
                        .tint(BobColor.accent)
                }
            }
            .swipeActions(edge: .trailing) {
                Button("Cancel reminder", role: .destructive) { cancel(reminder) }
            }
            .contextMenu {
                Button("Edit") { model.sheet = .editReminder(reminder) }
                if reminder.rule == nil {
                    Menu("Snooze") { snoozeButtons(reminder) }
                }
                Button("Cancel reminder", role: .destructive) { cancel(reminder) }
            }
    }

    // Shared: it stops for everyone it reaches, which an Undo couldn't unsay.
    private func cancel(_ reminder: Reminder) {
        if model.isShared(reminder) {
            cancellingShared = reminder
        } else {
            Task { await model.cancel(reminder) }
        }
    }

    @ViewBuilder private func snoozeButtons(_ reminder: Reminder) -> some View {
        ForEach(SnoozeChoice.choices(now: Date(), zone: reminder.dueZone ?? model.zone)) { choice in
            Button(choice.label) { Task { await model.snooze(reminder, choice: choice) } }
        }
    }

    @ViewBuilder private func sheetContent(_ sheet: CalendarSheet) -> some View {
        switch sheet {
        case .target(let target): CalendarEventTargetSheet(target: target, model: model)
        case .newEvent(let day): EventEditorSheet(mode: .create(day: day), model: model)
        case .editEvent(let item): EventEditorSheet(mode: .edit(item), model: model)
        case .viewEvent(let item): EventDetailSheet(item: item, model: model)
        case .google(let item): GoogleEventSheet(item: item)
        case .newTask: TaskEditorSheet(task: nil, model: model.tasks)
        case .editTask(let task): TaskEditorSheet(task: task, model: model.tasks)
        case .newReminder: ReminderEditorSheet(reminder: nil, model: model.reminders)
        case .editReminder(let reminder): ReminderEditorSheet(reminder: reminder, model: model.reminders)
        }
    }
}

// A Google event can only be read here.
private struct GoogleEventSheet: View {
    let item: GoogleAgendaItem

    @Environment(\.dismiss) private var dismiss

    private var whenText: String {
        if let start = item.startDate {
            let last = item.endDate.map { CalendarDays.add(-1, to: $0) } ?? start
            return last > start ? "All day, \(CalendarDays.dayTitle(start)) to \(CalendarDays.dayTitle(last))" : "All day, \(CalendarDays.dayTitle(start))"
        }
        guard let start = item.startAt else { return "Time unavailable" }
        guard let end = item.endAt else { return ProductivityText.moment(start) }
        return "\(ProductivityText.moment(start)) to \(ProductivityText.moment(end))"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(item.title).font(BobFont.heading).accessibilityAddTraits(.isHeader)
                    Text(whenText).font(BobFont.subline)
                    if let zone = item.zone {
                        Text("Event time zone: \(zone)").font(BobFont.subline).foregroundStyle(.secondary)
                    }
                    if let location = item.location {
                        Text(location)
                    }
                    Text("Last checked \(ProductivityText.moment(item.fetchedAt))").font(BobFont.subline).foregroundStyle(.secondary)
                    Text("Make changes in Google Calendar.").font(BobFont.subline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .bobPage()
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Google Calendar").font(BobFont.caption)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    let services = ProductivityServices.demo()
    CalendarView(model: ProductivityStore(services: services).calendar)
}
