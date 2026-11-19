import BobKit
import SwiftUI

struct BobAppRefreshSection: View {
    let model: BobAppsModel
    let app: SavedBobApp
    @State private var configuring = false
    var body: some View {
        BobGroupHeader(title: "Automatic updates")
        if let error = model.refreshError {
            BobLoadFailure(title: "Couldn't load update history", error: error) { await model.load() }.bobListRow(divider: false)
        }
        if let state = model.refreshState {
            VStack(alignment: .leading, spacing: 6) {
                Text(state.enabled ? "Automatic updates are on." : "Automatic updates are paused.").font(BobFont.rowTitle)
                if let last = state.lastRefreshAt { Text("Last refreshed \(last.formatted(date: .abbreviated, time: .shortened))") } else { Text("No automatic refresh yet.") }
                if let next = state.nextRunAt { Text("Next refresh: \(next.formatted(date: .abbreviated, time: .shortened))") }
                if state.lastError != nil { Text("The last refresh didn't finish. Your last saved data is still here. Check the source and schedule.") }
            }.font(BobFont.subline).padding(.vertical, 8).bobListRow(divider: false)
            if app.lifecycle == .active && app.canManage {
                Button("Configure automatic updates") { configuring = true }.disabled(model.busy).bobListRow()
                if state.enabled { Button("Pause automatic updates") { Task { _ = await model.configure(enabled: false, config: nil) } }.disabled(model.busy).bobListRow() }
            }
        }
        ForEach(model.runs) { run in
            VStack(alignment: .leading, spacing: 4) {
                Text("\(run.scheduledAt.formatted(date: .abbreviated, time: .shortened)) · \(run.status.rawValue)").font(BobFont.rowTitle)
                if run.failureCode != nil { Text("No new data was saved. Check the source and try again.").font(BobFont.subline).foregroundStyle(.secondary) }
            }.bobListRow()
        }
        Color.clear.frame(height: 0).bobListRow(divider: false).sheet(isPresented: $configuring) {
            BobAppRefreshForm(model: model, app: app).bobSheet()
        }
    }
}
private struct BobAppRefreshForm: View {
    let model: BobAppsModel
    let app: SavedBobApp
    @State private var config: BobAppRefreshConfig
    @State private var initialConfig: BobAppRefreshConfig
    @State private var confirmingDiscard = false
    @State private var consent = false
    @State private var spaces: [SpaceSummary] = []
    @State private var loading = true
    @State private var error: ApiError?
    @Environment(\.dismiss) private var dismiss
    private let weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    private var tables: [BobAppDefinition.Table] { app.definition.tables.filter(\.supportsTaskRefresh) }
    init(model: BobAppsModel, app: SavedBobApp) {
        self.model = model; self.app = app
        let config = model.refreshState?.config ?? BobAppRefreshConfig(spaceId: "", targetTable: app.definition.tables.first(where: \.supportsTaskRefresh)?.id ?? "", weekdays: [1, 2, 3, 4, 5], localTime: "08:00", timeZone: TimeZone.current.identifier)
        _config = State(initialValue: config)
        _initialConfig = State(initialValue: config)
    }
    var body: some View {
        NavigationStack {
            Form {
                Text("Bob can copy tasks from one of your spaces into this app. Each refresh replaces the selected table, including local edits. The first run starts now; later runs follow your schedule.")
                if loading { ProgressView("Loading your spaces…") }
                if let error { BobLoadFailure(title: "Couldn't load your spaces", error: error) { await loadSpaces() } }
                Picker("Tasks from space", selection: $config.spaceId) {
                    Text("Choose a space").tag("")
                    ForEach(spaces) { Text($0.name).tag($0.id) }
                }
                Picker("Replace table", selection: $config.targetTable) { ForEach(tables) { Text(BobAppDefinition.label($0.id)).tag($0.id) } }
                if tables.isEmpty { Text("Ask Bob to add a tasks table with a title and completed field first.") }
                Section("Days") {
                    ForEach(Array(weekdays.enumerated()), id: \.offset) { index, day in
                        Toggle(day, isOn: Binding(get: { config.schedule.weekdays.contains(index + 1) }, set: { checked in
                            config.schedule.weekdays.removeAll { $0 == index + 1 }; if checked { config.schedule.weekdays.append(index + 1); config.schedule.weekdays.sort() }
                        }))
                    }
                }
                TextField("Refresh at (24-hour HH:mm)", text: $config.schedule.localTime).keyboardType(.numbersAndPunctuation)
                TextField("Refresh time zone", text: $config.schedule.timeZone).textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("For example, America/Los_Angeles. This stays the same when you travel.").font(BobFont.subline).foregroundStyle(.secondary)
                Toggle("Let Bob read these tasks and replace this table on this schedule", isOn: $consent)
                Text("Runs continue while you're away. Pause automatic updates whenever you like.").font(BobFont.subline).foregroundStyle(.secondary)
                if let message = model.message { Text(message).foregroundStyle(BobColor.dangerText) }
            }
            .bobForm()
            .disabled(model.busy)
            .bobNavTitle("Automatic updates")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel).disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Enable") { Task { if await model.configure(enabled: true, config: config) { dismiss() } } }.disabled(!canSave) }
            }
            .task { await loadSpaces() }
            .onChange(of: config) { _, _ in consent = false }
            .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
    }
    private var dismissalPolicy: EditorDismissalPolicy {
        EditorDismissalPolicy(hasUnsavedChanges: config != initialConfig || consent, isSaving: model.busy)
    }
    private func cancel() {
        switch dismissalPolicy.cancelAction {
        case .dismiss: dismiss()
        case .confirmDiscard: confirmingDiscard = true
        case .blocked: break
        }
    }
    private var canSave: Bool { !model.busy && consent && config.isValid && spaces.contains { $0.id == config.spaceId } && tables.contains { $0.id == config.targetTable } }
    private func loadSpaces() async {
        loading = true; error = nil
        defer { loading = false }
        guard let client = AppSession.make({ SpacesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) else { error = .unauthenticated; return }
        do { let result = try await client.spaces(); guard !Task.isCancelled else { return }; spaces = result }
        catch { if !Task.isCancelled { self.error = (error as? ApiError) ?? .unknown(status: 0) } }
    }
}
