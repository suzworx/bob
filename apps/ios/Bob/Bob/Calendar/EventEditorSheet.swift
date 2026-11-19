import BobKit
import SwiftUI

// New or changed event. A stale save keeps everything typed, and saving again replaces what changed.
struct EventEditorSheet: View {
    enum Mode {
        case create(day: String)
        case edit(AgendaItem)
    }

    let mode: Mode
    let model: CalendarModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var titleFocused: Bool
    @State private var draft: EventDraft
    @State private var space: SpaceSummary?
    @State private var event: CalendarEvent?
    @State private var loadFailure: String?
    @State private var scope: RecurrenceScope?
    @State private var saving = false
    @State private var notice: String?
    @State private var noticeIsWarning = false
    @State private var confirmingDiscard = false
    private let initial: EventDraft
    @State private var initialSpaceID: String?
    private var zone: String { model.zone }

    init(mode: Mode, model: CalendarModel, spaceID: String? = nil) {
        self.mode = mode
        self.model = model
        let start: EventDraft
        switch mode {
        case .create(let day): start = EventDraft(day: day, now: Date(), zone: TimeZone.current.identifier)
        case .edit(let item): start = EventDraft(occurrence: item, zone: model.zone)
        }
        initial = start
        _draft = State(initialValue: start)
        let selectedSpace = model.writableSpaces.first { $0.id == spaceID } ?? model.writableSpaces.first
        _space = State(initialValue: selectedSpace)
        _initialSpaceID = State(initialValue: selectedSpace?.id)
    }

    private var item: AgendaItem? {
        if case .edit(let item) = mode { return item }
        return nil
    }

    private var isRecurring: Bool { event?.rule != nil }
    private var timesLocked: Bool { scope == .series }
    private var patch: EventPatch { draft.patch(from: initial, zone: zone) }
    private var isDirty: Bool { draft != initial || space?.id != initialSpaceID }

    private var canSave: Bool {
        guard draft.isValid(zone: zone) else { return false }
        if item == nil { return space != nil }
        return event != nil && !patch.isEmpty && (!isRecurring || scope != nil)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let loadFailure {
                    ContentUnavailableView {
                        Text(loadFailure).font(BobFont.heading)
                    }
                } else if item != nil, event == nil {
                    ProgressView().accessibilityLabel("Loading event").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    form.disabled(saving)
                }
            }
            .bobPage()
            .bobNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(
                    title: item == nil ? "New event" : "Edit event",
                    canSave: canSave,
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
            if let item {
                await load(item)
            } else {
                titleFocused = true
            }
        }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let notice {
                    Text(notice).font(BobFont.subline).foregroundStyle(noticeIsWarning ? BobColor.warnText : BobColor.dangerText)
                }
                BobField(label: "Title") {
                    TextField("Title", text: limited(\.title, EventDraft.titleLimit)).focused($titleFocused)
                }
                if item == nil, model.writableSpaces.count > 1 {
                    spacePicker
                }
                timeFields
                BobField(label: "Location") {
                    TextField("Location", text: limited(\.location, EventDraft.locationLimit))
                }
                BobField(label: "Notes") {
                    TextField("Notes", text: limited(\.notes, EventDraft.notesLimit), axis: .vertical).lineLimit(3...10)
                }
                if isRecurring { scopePicker }
                if let item, let event {
                    EventPeopleSection(event: event, service: model.service, me: model.me, canManage: item.canEdit)
                    EventDeleteButton(item: item, event: event, model: model) { dismiss() }
                }
            }
            .padding(.horizontal, BobLayout.pageMargin)
            .padding(.top, 12)
            .padding(.bottom, 32)
        }
    }

    private var spacePicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Space")
                Spacer()
                Picker("Space", selection: Binding(get: { space?.id ?? "" }, set: { id in space = model.writableSpaces.first { $0.id == id } })) {
                    ForEach(model.writableSpaces) { Text($0.name).tag($0.id) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
            .frame(minHeight: 44)
            BobDivider()
        }
    }

    private var timeFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("All day", isOn: Binding(get: { draft.allDay }, set: { draft = draft.settingAllDay($0) }))
                .toggleStyle(BobToggleStyle())
            if draft.allDay {
                DatePicker("Starts", selection: dayBinding(\.startDate), displayedComponents: .date).frame(minHeight: 44)
                DatePicker("Ends", selection: dayBinding(\.endDateInclusive), displayedComponents: .date).frame(minHeight: 44)
            } else {
                DatePicker("Starts", selection: localBinding(\.startLocal)).frame(minHeight: 44)
                DatePicker("Ends", selection: localBinding(\.endLocal)).frame(minHeight: 44)
            }
            if draft.timing(zone: zone) == nil {
                Text("It must end after it starts.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
            } else if item == nil, draft.startsBeforeToday(now: Date(), zone: zone) {
                Text("This date is in the past. You can still save it.").font(BobFont.subline).foregroundStyle(BobColor.warnText)
            }
            if timesLocked {
                Text("A repeating series keeps its times here. Choose Only this event to move one date.")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
            }
            BobDivider()
        }
        .disabled(timesLocked)
    }

    private var scopePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Change which events?").font(BobFont.caption).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
            scopeRow("Only this event", detail: "Changes this one date; the rest of the series stays as it is.", value: .this)
            scopeRow("Every event in the series", detail: "Changes the title, place and notes of every date. Times stay as they are.", value: .series)
            BobDivider()
        }
    }

    private func scopeRow(_ title: String, detail: String, value: RecurrenceScope) -> some View {
        Button {
            scope = value
            if value == .series { draft = draft.restoringTimes(from: initial) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(BobFont.rowTitle)
                    Text(detail).font(BobFont.subline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if scope == value {
                    Image(systemName: "checkmark").foregroundStyle(BobColor.accent).accessibilityHidden(true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityAddTraits(scope == value ? .isSelected : [])
    }

    private func limited(_ field: WritableKeyPath<EventDraft, String>, _ limit: Int) -> Binding<String> {
        Binding(get: { draft[keyPath: field] }, set: { draft[keyPath: field] = String($0.prefix(limit)) })
    }

    private func dayBinding(_ field: WritableKeyPath<EventDraft, String>) -> Binding<Date> {
        Binding(
            get: { WallClock.instant(day: draft[keyPath: field], zone: zone) ?? Date() },
            set: { draft[keyPath: field] = WallClock.day($0, zone: zone) }
        )
    }

    private func localBinding(_ field: WritableKeyPath<EventDraft, String>) -> Binding<Date> {
        Binding(
            get: { EventDraft.instant(local: draft[keyPath: field], zone: zone) ?? Date() },
            set: { draft[keyPath: field] = EventDraft.local($0, zone: zone) }
        )
    }

    private func load(_ item: AgendaItem) async {
        do {
            let loaded = try await model.service.event(id: item.eventID)
            if loaded.status == .cancelled {
                loadFailure = "This event was deleted."
            } else {
                event = loaded
            }
        } catch where isCancelled(error) {
            return
        } catch {
            loadFailure = "This event could not be loaded."
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
                if let item, let event {
                    let chosen = isRecurring ? (scope ?? .series) : .series
                    _ = try await model.service.update(id: event.id, revision: event.revision, scope: chosen, occurrenceStart: item.originalOccurrenceStart, patch: patch)
                } else if let space, let new = draft.newEvent(zone: zone) {
                    _ = try await model.service.create(space: space, event: new)
                }
                dismiss()
            } catch {
                await show(error)
            }
        }
    }

    private func show(_ error: Error) async {
        noticeIsWarning = false
        switch error as? ApiError {
        case .unknown(status: 409)?:
            noticeIsWarning = true
            notice = "Someone changed this event while you were editing. Your changes are still here; save again to replace theirs."
            if let id = event?.id, let latest = try? await model.service.event(id: id) { event = latest }
        case .invalidRequest?:
            notice = "Check the times: an event must end after it starts."
        case .unknown(status: 403)?, .notFound?:
            notice = "This event can no longer be changed."
        default:
            notice = isCancelled(error) ? nil : "The event could not be saved."
        }
    }
}

// Delete, asking which dates first when it repeats. There is no way back, as on the web.
struct EventDeleteButton: View {
    let item: AgendaItem
    let event: CalendarEvent
    let model: CalendarModel
    let onDeleted: () -> Void

    @State private var confirming = false
    @State private var deleting = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if failed {
                Text("The event could not be deleted.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
            }
            Button("Delete event", role: .destructive) { confirming = true }
                .frame(minHeight: 44)
                .disabled(deleting)
                .buttonStyle(BobPressStyle())
                .foregroundStyle(BobColor.dangerText)
        }
        .confirmationDialog("Delete \(event.title)?", isPresented: $confirming, titleVisibility: .visible) {
            if event.rule != nil {
                Button("Only this event", role: .destructive) { delete(.this) }
                Button("This and every later event", role: .destructive) { delete(.thisAndFollowing) }
                Button("Every event in the series", role: .destructive) { delete(.series) }
            } else {
                Button("Delete", role: .destructive) { delete(.series) }
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("It disappears from everyone's agenda. This can't be undone.")
        }
    }

    private func delete(_ scope: RecurrenceScope) {
        deleting = true
        failed = false
        Task {
            defer { deleting = false }
            do {
                try await model.service.cancel(id: event.id, scope: scope, occurrenceStart: item.originalOccurrenceStart)
                onDeleted()
            } catch {
                failed = !isCancelled(error)
            }
        }
    }
}

// For someone who can't edit: the same event, read-only, with their own answer. Delete shows only if the server allows it.
struct EventDetailSheet: View {
    let item: AgendaItem
    let model: CalendarModel

    @Environment(\.dismiss) private var dismiss
    @State private var event: CalendarEvent?
    @State private var loadFailure: String?

    private var dayTitle: String {
        if let date = item.startDate { return CalendarDays.fullTitle(date) }
        return item.startAt.map { CalendarDays.fullTitle(WallClock.day($0, zone: model.zone)) } ?? ""
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(item.title).font(BobFont.heading).accessibilityAddTraits(.isHeader)
                    Text(dayTitle).font(BobFont.subline)
                    Text(CalendarRules.timeText(item, zone: model.zone)).font(BobFont.subline).foregroundStyle(.secondary)
                    if let location = item.location { Text(location) }
                    if let body = item.body { Text(body) }
                    if let loadFailure {
                        Text(loadFailure).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    } else if let event {
                        EventPeopleSection(event: event, service: model.service, me: model.me, canManage: false)
                            .padding(.top, 8)
                        if item.canDelete {
                            EventDeleteButton(item: item, event: event, model: model) { dismiss() }
                        }
                    } else {
                        ProgressView().accessibilityLabel("Loading event").frame(maxWidth: .infinity)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .bobPage()
            .bobNavigationChrome()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let loaded = try await model.service.event(id: item.eventID)
            if loaded.status == .cancelled {
                loadFailure = "This event was deleted."
            } else {
                event = loaded
            }
        } catch where isCancelled(error) {
            return
        } catch {
            loadFailure = "This event could not be loaded."
        }
    }
}
