import BobKit
import SwiftUI

struct IntegrationsView: View {
    private let chat: ChatRouting?
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: GoogleAccountsModel
    private let preview: Bool
    @State private var handoff: IntegrationHandoff?

    init(chat: ChatRouting? = nil) {
        self.chat = chat
        let services = IntegrationServices.make()
        _model = State(initialValue: services.model)
        preview = services.preview
    }

    var body: some View {
        List {
            BobGroupHeader(title: "On this iPhone")
            NavigationLink { HealthView(chat: chat) } label: {
                Label("Apple Health", systemImage: "heart.fill")
                    .padding(.vertical, 8)
            }.bobListRow()
            Text("Read-only summaries. You choose what to share with Bob.")
                .font(BobFont.caption).foregroundStyle(.secondary).bobListRow(divider: false)
            VStack(alignment: .leading, spacing: 10) {
                Text("Choose what Bob can use from your Google accounts. Your connections are private.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                if preview {
                    Label("Preview accounts · changes stay in this demo", systemImage: "eye")
                        .font(BobFont.caption).foregroundStyle(.secondary)
                }
            }.padding(.vertical, 12).bobListRow(divider: false)
            if let error = model.error {
                BobLoadFailure(title: "Couldn't load your Google accounts", error: error) { await model.refresh() }
                    .bobListRow(divider: false)
            }
            if !model.loaded && model.error == nil {
                ProgressView("Opening your connections…").bobListRow(divider: false)
            }
            if model.loaded {
                if model.accounts.isEmpty {
                    ContentUnavailableView("A little connection goes a long way", systemImage: "link", description: Text("Connect Google so Bob can help with your mail and calendar."))
                        .bobListRow(divider: false)
                }
                BobGroupHeader(title: "Google")
                ForEach(model.accounts) { account in
                    NavigationLink {
                        GoogleAccountView(accountID: account.id, model: model)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(account.displayName).font(BobFont.rowTitle)
                            if account.customName != nil { Text(account.email).font(BobFont.subline).foregroundStyle(.secondary) }
                            if account.needsReconnect {
                                Label("Needs reconnecting", systemImage: "exclamationmark.circle").font(BobFont.caption)
                            } else {
                                Label(account.selected ? "Connected · Default" : "Connected", systemImage: "checkmark.circle").font(BobFont.caption).foregroundStyle(.secondary)
                            }
                        }.padding(.vertical, 8)
                    }.bobListRow()
                }
                Button { handoff = IntegrationHandoff(account: nil) } label: {
                    Label(model.accounts.isEmpty ? "Connect Google" : "Connect another Google account", systemImage: "plus")
                        .padding(.vertical, 8)
                }.bobListRow(divider: false)
            }
        }
        .bobList().bobNavTitle("Integrations").privacySensitive()
        .task { await model.refresh() }
        .refreshable { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refresh() } } }
        .onDisappear { model.cancelReads() }
        .sheet(item: $handoff) { value in GoogleConnectionHandoff(account: value.account, onRefresh: { Task { await model.refresh() } }) }
    }
}

private struct IntegrationHandoff: Identifiable {
    let account: GoogleIntegrationAccount?
    var id: String { account?.id ?? "new" }
}

private struct GoogleAccountView: View {
    let accountID: String
    @Bindable var model: GoogleAccountsModel
    @State private var renaming: GoogleIntegrationAccount?
    @State private var handoff: IntegrationHandoff?
    @State private var removing = false
    @Environment(\.dismiss) private var dismiss
    private var account: GoogleIntegrationAccount? { model.accounts.first { $0.id == accountID } }

    var body: some View {
        List {
            if let account {
                VStack(alignment: .leading, spacing: 10) {
                    Text(account.displayName).font(BobFont.heading)
                    Text(account.email).font(BobFont.body).foregroundStyle(.secondary)
                    Text(account.needsReconnect ? "Reconnect before Bob can use this account." : account.selected ? "Used for Bob's Google actions by default." : "Connected to Bob.")
                        .font(BobFont.subline).foregroundStyle(.secondary)
                }.padding(.vertical, 12).bobListRow(divider: false)
                if let error = model.error {
                    Text(integrationMessage(error)).foregroundStyle(.secondary).bobListRow(divider: false)
                }
                BobGroupHeader(title: "Access you've requested")
                ForEach(account.access, id: \.rawValue) { capability in
                    Text(capability.title).font(BobFont.body).bobListRow()
                }
                if account.access.isEmpty { Text("No access yet").bobListRow() }
                Text("Google permissions are checked again whenever Bob uses this account.")
                    .font(BobFont.caption).foregroundStyle(.secondary).bobListRow(divider: false)
                BobGroupHeader(title: "Manage")
                NavigationLink { ToolsView(context: .integration(account.id), title: "Tools for \(account.displayName)") } label: {
                    Label("Tools", systemImage: "wrench.and.screwdriver")
                }.bobListRow()
                Button { renaming = account } label: { Label("Rename", systemImage: "pencil") }.bobListRow()
                NavigationLink { GoogleCalendarsView(account: account, service: model.service) } label: {
                    Label("Calendars in your agenda", systemImage: "calendar")
                }.bobListRow()
                if !account.selected {
                    Button { Task { _ = await model.makeDefault(account) } } label: { Label("Make default", systemImage: "star") }.bobListRow()
                }
                Button { handoff = IntegrationHandoff(account: account) } label: {
                    Label(account.needsReconnect ? "Reconnect" : "Change access", systemImage: "key")
                }.bobListRow()
                Button(role: .destructive) { removing = true } label: { Label("Remove account", systemImage: "trash") }.bobListRow(divider: false)
                if model.busy { ProgressView("Saving…").bobListRow(divider: false) }
            } else {
                ContentUnavailableView("This account is no longer connected", systemImage: "link", description: Text("Go back to connect another account."))
                    .bobListRow(divider: false)
            }
        }
        .bobList().bobNavTitle("Google account").privacySensitive()
        .disabled(model.busy)
        .sheet(item: $renaming) { account in GoogleAccountRename(account: account, model: model).bobSheet() }
        .sheet(item: $handoff) { value in GoogleConnectionHandoff(account: value.account, onRefresh: { Task { await model.refresh() } }) }
        .confirmationDialog("Remove \(account?.displayName ?? "this account")?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove account", role: .destructive) {
                if let account { Task { if await model.remove(account) { dismiss() } } }
            }
        } message: {
            Text("Bob will stop reading this account's mail and calendars. You can connect it again later.")
        }
    }
}

private struct GoogleAccountRename: View {
    let account: GoogleIntegrationAccount
    @Bindable var model: GoogleAccountsModel
    @State private var name: String
    @State private var initialName: String
    @State private var confirmingDiscard = false
    @Environment(\.dismiss) private var dismiss
    init(account: GoogleIntegrationAccount, model: GoogleAccountsModel) {
        self.account = account; self.model = model
        let name = account.customName ?? ""
        _name = State(initialValue: name)
        _initialName = State(initialValue: name)
    }
    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Account name", text: $name).textInputAutocapitalization(.words)
                Text("Leave this empty to use \(account.email). Up to 60 characters.").font(.footnote).foregroundStyle(.secondary)
                if let error = model.error { Text(integrationMessage(error)).foregroundStyle(.secondary) }
            }
            .disabled(model.busy)
            .bobForm()
            .bobNavTitle("Rename account")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel).disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { if await model.rename(account, name: trimmed.isEmpty ? nil : trimmed) { dismiss() } } }
                        .disabled(model.busy || trimmed.utf16.count > 60)
                }
            }
            .confirmationDialog("Discard your changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(dismissalPolicy.preventsInteractiveDismissal)
        .privacySensitive()
    }
    private var dismissalPolicy: EditorDismissalPolicy {
        EditorDismissalPolicy(hasUnsavedChanges: name != initialName, isSaving: model.busy)
    }
    private func cancel() {
        switch dismissalPolicy.cancelAction {
        case .dismiss: dismiss()
        case .confirmDiscard: confirmingDiscard = true
        case .blocked: break
        }
    }
}

func integrationMessage(_ error: ApiError) -> String {
    if error == .forbidden { return "Reconnect this account and check its Google permissions." }
    return ApiErrorMapper.userMessage(error)
}
