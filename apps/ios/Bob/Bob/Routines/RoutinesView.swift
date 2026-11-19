import BobKit
import SwiftUI

struct RoutinesView: View {
    let chat: ChatRouting
    @State private var model = RoutinesModel()
    @State private var archived = false
    @State private var creating = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 12) {
                Text("Bob prepares your recap while you're away. Every run has a home here, just for you.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                Picker("Routines", selection: $archived) {
                    Text("Current").tag(false)
                    Text("Archived").tag(true)
                }.bobChoicePicker()
            }.padding(.vertical, 12).bobListRow(divider: false)
            if let error = model.error {
                RoutineRetry(message: error) { await model.refresh() }.bobListRow(divider: false)
            }
            if model.loading {
                ProgressView("Opening your routines…").bobListRow(divider: false)
            } else {
                let visible = model.routines.filter { ($0.status == .archived) == archived }
                if visible.isEmpty, model.error == nil {
                    ContentUnavailableView(archived ? "No archived routines" : "Make room for a recap", systemImage: "repeat", description: Text(archived ? "Archived routines keep their past recaps here." : "Choose an email account and a schedule. Bob will gather the highlights for you."))
                        .bobListRow(divider: false)
                }
                ForEach(visible) { routine in
                    NavigationLink {
                        RoutineDetailView(id: routine.id, model: model)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(routine.name).font(BobFont.rowTitle)
                            Text(routine.status.rawValue.capitalized).font(BobFont.caption).foregroundStyle(.secondary)
                            Text(routine.scheduleLabel).font(BobFont.subline).foregroundStyle(.secondary)
                        }.padding(.vertical, 8)
                    }.bobListRow()
                }
            }
            Button { chat.new(nil) } label: {
                Label("Ask Bob about routines", systemImage: "bubble.left")
            }.bobListRow(divider: false)
        }
        .bobList().bobNavTitle("Routines").privacySensitive()
        .toolbar { ToolbarItem(placement: .primaryAction) { Button("New routine", systemImage: "plus") { creating = true }.disabled(model.loading || model.busy) } }
        .task { await model.refresh() }
        .refreshable { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refresh() } } }
        .sheet(isPresented: $creating) {
            NavigationStack { RoutineFormView(model: model, routine: nil) }.bobSheet()
        }
    }
}

struct RoutineRetry: View {
    let message: String
    let retry: () async -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(message).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
            Button("Try again") { Task { await retry() } }.frame(minHeight: 44)
        }
    }
}

private enum RoutineTab: String, CaseIterable { case overview = "Overview", timeline = "Timeline", configuration = "Configuration" }

private struct RoutineDetailView: View {
    let id: String
    let model: RoutinesModel
    @State private var tab: RoutineTab = .overview
    @State private var editing = false
    @State private var confirmArchive = false
    private var routine: Routine? { model.routines.first { $0.id == id } }

    var body: some View {
        List {
            if let routine {
                Picker("Routine detail", selection: $tab) {
                    ForEach(RoutineTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.bobChoicePicker().bobListRow(divider: false)
                if let error = model.error { RoutineRetry(message: error) { await model.refresh() }.bobListRow(divider: false) }
                if tab == .timeline {
                    RoutineRunsView(routine: routine, client: model.client)
                } else {
                    overview(routine)
                    if tab == .configuration { configuration(routine) }
                    controls(routine)
                }
            } else {
                ContentUnavailableView("This routine isn't here", systemImage: "repeat", description: Text("Pull down to check again."))
            }
        }
        .bobList().bobNavTitle(routine?.name ?? "Routine").privacySensitive()
        .refreshable { await model.refresh() }
        .sheet(isPresented: $editing) {
            if let routine { NavigationStack { RoutineFormView(model: model, routine: routine) }.bobSheet() }
        }
        .confirmationDialog("Archive this routine?", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("Archive routine", role: .destructive) { if let routine { Task { await model.archive(routine) } } }
        } message: { Text("Future runs will stop. Your past recaps stay available in Archived.") }
    }

    private func overview(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(routine.status.rawValue.capitalized).font(BobFont.rowTitle)
            Text(model.accounts.first { $0.id == routine.googleAccountID }?.displayName ?? "Disconnected Google account").font(BobFont.body)
            Text(routine.scheduleLabel).font(BobFont.subline).foregroundStyle(.secondary)
            if let next = routine.nextRunAt {
                Text("Next: \(ProductivityText.moment(next, zone: routine.timeZone))").font(BobFont.subline)
            } else { Text("No run scheduled").font(BobFont.subline).foregroundStyle(.secondary) }
            if !model.eligibleAccounts.contains(where: { $0.id == routine.googleAccountID }), routine.status != .archived {
                Text("Your Google connection needs attention. Reconnect with Gmail access in Integrations.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                NavigationLink { IntegrationsView() } label: { Label("Manage connections", systemImage: "link") }
            }
        }.padding(.vertical, 8).bobListRow(divider: false)
    }

    private func configuration(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            LabeledContent("Email filter", value: routine.gmailQuery.isEmpty ? "All recent emails" : routine.gmailQuery)
            Text(routine.instructions.isEmpty ? "Focus on important updates and next steps" : routine.instructions)
            LabeledContent("Summary", value: routine.summaryStyle.rawValue.capitalized)
            LabeledContent("Email recap", value: routine.emailResult ? "Requested" : "Off")
        }.font(BobFont.body).bobListRow(divider: false)
    }

    @ViewBuilder private func controls(_ routine: Routine) -> some View {
        if routine.status != .archived {
            Button(routine.status == .active ? "Pause routine" : "Resume routine") { Task { await model.toggle(routine) } }
                .disabled(model.busy || (routine.status == .paused && !model.eligibleAccounts.contains { $0.id == routine.googleAccountID })).bobListRow()
            Button("Configure routine") { editing = true }.disabled(model.busy).bobListRow()
            Button("Archive routine", role: .destructive) { confirmArchive = true }.disabled(model.busy).bobListRow()
        }
        if tab == .overview { Button("Run history") { tab = .timeline }.bobListRow() }
    }
}
