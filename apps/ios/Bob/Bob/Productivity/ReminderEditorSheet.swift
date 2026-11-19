import BobKit
import SwiftUI

// New or changed reminder, in the reminder's own zone, with the server's preview of the next rings before saving.
struct ReminderEditorSheet: View {
    let reminder: Reminder?
    let model: RemindersModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var titleFocused: Bool
    @State private var title: String
    @State private var when: Date
    @State private var repeatChoice: ReminderRepeat
    @State private var everyHours: Int
    @State private var from: String
    @State private var until: String
    @State private var saving = false
    @State private var confirmingDiscard = false
    @State private var notice: String?
    @State private var preview: PreviewState = .idle
    @State private var recipients: Set<String> = []
    private let zone: String
    @State private var initialWhen: Date
    @State private var initialRecipients: Set<String>

    private enum PreviewState: Equatable {
        case idle, failed
        case ready([ReminderOccurrencePreview])
    }

    private struct PreviewKey: Hashable {
        let at: Date
        let rule: ReminderRule?
    }

    init(reminder: Reminder?, model: RemindersModel) {
        self.reminder = reminder
        self.model = model
        zone = reminder?.dueZone ?? TimeZone.current.identifier
        _title = State(initialValue: reminder?.title ?? "")
        let when = reminder?.dueAt ?? Self.defaultWhen(now: Date())
        _when = State(initialValue: when)
        _initialWhen = State(initialValue: when)
        let recipients = Set([model.scope?.me].compactMap { $0 })
        _recipients = State(initialValue: recipients)
        _initialRecipients = State(initialValue: recipients)
        _repeatChoice = State(initialValue: ReminderRepeat(rule: reminder?.rule))
        let rule = reminder?.rule
        let isHourly = rule?.freq == .hourly
        _everyHours = State(initialValue: isHourly ? rule?.interval ?? 1 : 1)
        _from = State(initialValue: isHourly ? rule?.window?.start ?? "00:00" : "08:00")
        _until = State(initialValue: isHourly ? rule?.window?.end ?? "23:59" : "22:00")
    }

    // 9:00 AM if that is still ahead today, otherwise the next half-hour: never a time already past.
    private static func defaultWhen(now: Date) -> Date {
        let calendar = Calendar.current
        if let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: now), nine > now {
            return nine
        }
        let halfHour: TimeInterval = 1800
        return Date(timeIntervalSince1970: (now.timeIntervalSince1970 / halfHour).rounded(.down) * halfHour + halfHour)
    }

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var windowIsValid: Bool { repeatChoice != .hourly || from < until }
    private var canSave: Bool { !trimmedTitle.isEmpty && windowIsValid }

    // A rule the picker can't fully show, such as an end date or every two weeks, survives an edit that leaves it alone.
    private var rule: ReminderRule? {
        let chosen = repeatChoice.rule(everyHours: everyHours, from: from, until: until)
        guard let original = reminder?.rule, ReminderRepeat(rule: original) == repeatChoice else { return chosen }
        if repeatChoice == .hourly {
            let sameHours = (original.interval ?? 1) == everyHours
            let sameWindow = (original.window?.start ?? "00:00") == from && (original.window?.end ?? "23:59") == until
            return sameHours && sameWindow ? original : chosen
        }
        return original
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "Title") {
                        TextField("Title", text: Binding(get: { title }, set: { title = String($0.prefix(200)) }))
                            .focused($titleFocused)
                    }
                    whenField
                    repeatFields
                    if windowIsValid { previewRows }
                    recipientFields
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
                BobSheetBar(title: reminder == nil ? "New reminder" : "Edit reminder", canSave: canSave && !(needsRecipients && recipients.isEmpty), saving: saving, onCancel: cancel, onSave: save)
            }
            .task(id: PreviewKey(at: when, rule: rule)) {
                await loadPreview()
            }
        }
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .task {
            if reminder == nil { titleFocused = true }
        }
    }

    // Who it reaches is chosen when it's made, in a shared space. Editing doesn't change that, here or on the web.
    @ViewBuilder private var recipientFields: some View {
        if reminder == nil, let scope = model.scope, scope.isShared {
            VStack(alignment: .leading, spacing: 8) {
                Text("Remind").font(BobFont.caption).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
                ForEach(scope.people) { member in
                    Toggle(member.userID == scope.me ? "Me" : SpaceRules.displayName(member), isOn: Binding(
                        get: { recipients.contains(member.userID) },
                        set: { isOn in
                            if isOn { recipients.insert(member.userID) } else { recipients.remove(member.userID) }
                        }
                    ))
                    .toggleStyle(BobToggleStyle())
                    .frame(minHeight: 44)
                }
                if recipients.isEmpty {
                    Text("Pick at least one person.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                }
                BobDivider()
            }
        }
    }

    private var needsRecipients: Bool {
        reminder == nil && (model.scope?.isShared ?? false)
    }

    private var whenField: some View {
        VStack(alignment: .leading, spacing: 4) {
            DatePicker("When", selection: $when)
                .environment(\.timeZone, TimeZone(identifier: zone) ?? .current)
                .frame(minHeight: 44)
            if zone != TimeZone.current.identifier {
                Text("Time in \(zone)").font(BobFont.subline).foregroundStyle(.secondary)
            }
            BobDivider()
        }
    }

    private var repeatFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Repeat")
                Spacer()
                Picker("Repeat", selection: $repeatChoice) {
                    ForEach(ReminderRepeat.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }
            .frame(minHeight: 44)
            if repeatChoice == .hourly {
                Stepper("Every \(everyHours) \(everyHours == 1 ? "hour" : "hours")", value: $everyHours, in: 1...12)
                    .frame(minHeight: 44)
                DatePicker("From", selection: timeBinding($from), displayedComponents: .hourAndMinute)
                    .frame(minHeight: 44)
                DatePicker("Until", selection: timeBinding($until), displayedComponents: .hourAndMinute)
                    .frame(minHeight: 44)
                if !windowIsValid {
                    Text("Must end after it starts.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                }
            }
            BobDivider()
        }
        .environment(\.timeZone, TimeZone(identifier: "UTC") ?? .current)
    }

    @ViewBuilder private var previewRows: some View {
        switch preview {
        case .idle:
            EmptyView()
        case .failed:
            Text("The next reminders could not be previewed.").font(BobFont.subline).foregroundStyle(.secondary)
        case .ready(let rings) where rings.isEmpty:
            Text("This reminder will not ring again.").font(BobFont.subline).foregroundStyle(.secondary)
        case .ready(let rings):
            VStack(alignment: .leading, spacing: 4) {
                Text(rule == nil ? "Rings" : "Next reminders")
                    .font(BobFont.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(rings, id: \.at) { ring in
                    Text(ProductivityText.moment(ring.at, zone: zone)).font(BobFont.subline)
                }
            }
        }
    }

    // An "HH:mm" as a picker's date, on a fixed day in UTC: only the clock matters.
    private func timeBinding(_ text: Binding<String>) -> Binding<Date> {
        Binding(
            get: { WallClock.instant(day: "2000-01-01", time: text.wrappedValue, zone: "UTC") ?? Date(timeIntervalSince1970: 0) },
            set: { text.wrappedValue = WallClock.time($0, zone: "UTC") }
        )
    }

    private func loadPreview() async {
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled, windowIsValid else { return }
        do {
            let rings = try await model.service.preview(due: ReminderDue(at: when, zone: zone), rule: rule)
            guard !Task.isCancelled else { return }
            preview = .ready(rings)
        } catch where isCancelled(error) {
            return
        } catch {
            preview = .failed
        }
    }

    private var isDirty: Bool {
        title != (reminder?.title ?? "") || when != initialWhen || rule != reminder?.rule
            || (needsRecipients && recipients != initialRecipients)
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
        let due = ReminderDue(at: when, zone: zone)
        let rule = self.rule
        Task {
            defer { saving = false }
            do {
                if let reminder {
                    var changes = ReminderChanges()
                    if trimmedTitle != reminder.title { changes.title = trimmedTitle }
                    if when != reminder.dueAt { changes.due = due }
                    if rule != reminder.rule { changes.rule = .some(rule) }
                    if !changes.isEmpty {
                        try await model.update(id: reminder.id, changes: changes)
                    }
                } else {
                    try await model.create(title: trimmedTitle, due: due, rule: rule, recipients: needsRecipients ? Array(recipients) : nil)
                }
                dismiss()
            } catch {
                notice = productivityMessage(error)
            }
        }
    }
}
