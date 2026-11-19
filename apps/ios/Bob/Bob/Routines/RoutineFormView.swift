import BobKit
import SwiftUI

struct RoutineFormView: View {
    let model: RoutinesModel
    let routine: Routine?
    @State private var draft: RoutineDraft
    @State private var baseline: Routine?
    @State private var initial: RoutineDraft
    @State private var confirmingDiscard = false
    @State private var needsReview = false
    @State private var reviewed = false
    @State private var managingConnections = false
    @Environment(\.dismiss) private var dismiss

    // A deliberate one-time seed: a failed save or background refresh never replaces the person's draft.
    init(model: RoutinesModel, routine: Routine?) {
        self.model = model
        self.routine = routine
        _baseline = State(initialValue: routine)
        let draft = routine.map(RoutineDraft.init) ?? RoutineDraft()
        _draft = State(initialValue: draft)
        _initial = State(initialValue: draft)
    }

    private var canSave: Bool {
        draft.isValid && baseline?.status != .archived && !model.busy && !model.hasConflict && (!needsReview || reviewed) && (!draft.needsConsent || model.eligibleAccounts.contains { $0.id == draft.googleAccountID })
    }

    var body: some View {
        Form {
            Section {
                TextField("Routine name", text: $draft.name)
                Picker("Google account", selection: $draft.googleAccountID) {
                    Text("Choose an account").tag("")
                    ForEach(model.eligibleAccounts) { account in
                        Text("\(account.displayName) · \(account.email)").tag(account.id)
                    }
                    if let routine, !model.eligibleAccounts.contains(where: { $0.id == routine.googleAccountID }) {
                        Text("Current account · connection needs attention").tag(routine.googleAccountID)
                    }
                }
                if model.eligibleAccounts.isEmpty {
                    Text("Connect an account with Gmail access in Integrations first. Then return here to choose it.")
                        .foregroundStyle(.secondary)
                    Button { managingConnections = true } label: { Label("Manage connections", systemImage: "link") }
                    Button("Check connections again") { Task { await model.refresh() } }
                }
                TextField("Email filter (optional)", text: $draft.gmailQuery)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("What should Bob focus on?", text: $draft.instructions, axis: .vertical).lineLimit(3...8)
                Picker("Summary detail", selection: $draft.summaryStyle) {
                    ForEach(RoutineSummaryStyle.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                Toggle("Email me when a recap is ready", isOn: $draft.emailResult)
            } header: { Text("Your recap") } footer: {
                Text("The optional email filter uses Gmail search, such as label:work. Notification preferences can mute recap emails.")
            }
            Section {
                ForEach(1...7, id: \.self) { day in
                    Toggle(Self.weekdays[day - 1], isOn: Binding(get: { draft.weekdays.contains(day) }, set: { enabled in
                        draft.weekdays.removeAll { $0 == day }
                        if enabled { draft.weekdays.append(day); draft.weekdays.sort() }
                    }))
                }
                DatePicker("Run at", selection: timeBinding, displayedComponents: .hourAndMinute)
                    .environment(\.timeZone, TimeZone(secondsFromGMT: 0) ?? .current)
                Picker("Time zone", selection: $draft.timeZone) {
                    ForEach(zones, id: \.self) { zone in Text(zone.replacingOccurrences(of: "_", with: " ")).tag(zone) }
                }
                if draft.weekdays.isEmpty { Text("Choose at least one day.").foregroundStyle(BobColor.dangerText) }
            } header: { Text("Schedule") } footer: {
                Text("This time zone stays the same when you travel. Bob runs the routine even when the app is closed.")
            }
            if draft.needsConsent {
                Section {
                    Toggle("Let Bob read this account's emails on this schedule", isOn: $draft.scheduledReadConsent)
                } footer: { Text("Bob reads matching recent messages while you're away. Pause or archive the routine whenever you like.") }
            }
            if let error = model.error { Text(error).foregroundStyle(BobColor.dangerText) }
            if model.hasConflict {
                Button("Load latest version, keep my draft") { Task { await refreshBaseline() } }
            }
            if needsReview, let baseline {
                Section("Changed elsewhere") {
                    Text("Latest account: \(model.accounts.first { $0.id == baseline.googleAccountID }?.displayName ?? "Disconnected account")")
                    Text("Latest status: \(baseline.status.rawValue)")
                    Text("Latest saved name: \(baseline.name)")
                    Text(baseline.scheduleLabel)
                    Text("Latest focus: \(baseline.instructions.isEmpty ? "Important updates and next steps" : baseline.instructions)")
                    Text("Latest filter: \(baseline.gmailQuery.isEmpty ? "All recent emails" : baseline.gmailQuery)")
                    Text("Latest summary: \(baseline.summaryStyle.rawValue); recap email \(baseline.emailResult ? "on" : "off")")
                    Toggle("I've reviewed the latest version and want to save my draft", isOn: $reviewed)
                }
            }
            if draft.name.utf16.count > 100 { Text("Keep the name within 100 characters.").foregroundStyle(BobColor.dangerText) }
            if draft.instructions.utf16.count > 2000 { Text("Keep the focus within 2,000 characters.").foregroundStyle(BobColor.dangerText) }
            if draft.gmailQuery.utf16.count > 500 { Text("Keep the email filter within 500 characters.").foregroundStyle(BobColor.dangerText) }
        }
        .bobForm()
        .bobNavTitle(routine == nil ? "New routine" : "Configure routine")
        .disabled(model.busy)
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
        // Keep this editor and its draft in place. Pushing another screen from
        // its toolbar-bearing form causes a layout loop on iOS 17.
        .fullScreenCover(isPresented: $managingConnections) {
            NavigationStack {
                IntegrationsView()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { managingConnections = false }
                        }
                    }
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel).disabled(model.busy) }
            ToolbarItem(placement: .confirmationAction) {
                Button(model.busy ? "Saving…" : "Save") {
                    Task { if await model.save(draft, editing: baseline) { dismiss() } }
                }.disabled(!canSave)
            }
        }
        .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .onChange(of: draft.googleAccountID) { _, _ in draft.scheduledReadConsent = false }
        .onAppear { Task { await model.refresh() } }
        .privacySensitive()
    }

    private var dismissalPolicy: EditorDismissalPolicy {
        EditorDismissalPolicy(hasUnsavedChanges: draft != initial, isSaving: model.busy)
    }

    private func cancel() {
        switch dismissalPolicy.cancelAction {
        case .dismiss: dismiss()
        case .confirmDiscard: confirmingDiscard = true
        case .blocked: break
        }
    }

    private func refreshBaseline() async {
        guard let id = baseline?.id else { return }
        await model.refresh()
        guard model.error == nil, let latest = model.routines.first(where: { $0.id == id }) else { return }
        baseline = latest
        draft.rebase(on: latest)
        needsReview = true
        reviewed = false
    }

    private static let weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    private var zones: [String] { Array(Set(TimeZone.knownTimeZoneIdentifiers + [draft.timeZone, "UTC"])).sorted() }
    private var timeBinding: Binding<Date> {
        Binding(get: {
            let parts = draft.localTime.split(separator: ":").compactMap { Int($0) }
            return Date(timeIntervalSince1970: TimeInterval((parts.first ?? 8) * 3600 + (parts.last ?? 0) * 60))
        }, set: { date in
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
            let parts = calendar.dateComponents([.hour, .minute], from: date)
            draft.localTime = String(format: "%02d:%02d", parts.hour ?? 8, parts.minute ?? 0)
        })
    }
}
