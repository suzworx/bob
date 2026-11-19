import BobKit
import SwiftUI

struct AdminView: View {
    @State private var model = AdminServices.accounts()
    @State private var selection: AccountActionSelection?
    @State private var invitation: InvitationSelection?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView("Opening administration…").bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Administration isn't available", error: error) { await model.load() }.bobListRow(divider: false)
            case .loaded:
                if model.allowed { content }
            }
        }
        .bobList().bobNavTitle("Administration").privacySensitive()
        .task { await model.load() }
        .onChange(of: model.tab) { _, _ in model.cancel(); Task { await model.load() } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.load() } } }
        .onDisappear { if invitation == nil { model.cancel() } }
        .refreshable { await model.load() }
        .confirmationDialog(selection?.action.title ?? "Change account", isPresented: Binding(get: { selection != nil }, set: { if !$0 { selection = nil } }), titleVisibility: .visible) {
            if let target = selection {
                Button(target.action.title, role: target.action == .disable || target.action == .revokeAdmin ? .destructive : nil) {
                    selection = nil
                    Task { _ = await model.manage(target.account, action: target.action) }
                }
            }
            Button("Cancel", role: .cancel) { selection = nil }
        } message: {
            if let target = selection { Text("\(target.action.title) for \(target.account.email ?? "this account")? Space membership stays the same.") }
        }
        .sheet(item: $invitation, onDismiss: { Task { await model.load() } }) { target in
            AdminInvitationSheet(model: model, initialEmail: target.email).bobSheet()
        }
    }
    private var content: some View {
        Group {
            Text("Manage sign-in and site administration. Space memberships stay the same.")
                .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            Picker("People", selection: $model.tab) {
                Text("Accounts").tag(NativeAdminModel.Tab.accounts)
                Text("Waitlist").tag(NativeAdminModel.Tab.waitlist)
            }.bobChoicePicker().disabled(model.busy).bobListRow()
            Button("Add person") { invitation = InvitationSelection(email: "") }
                .font(BobFont.rowTitle).disabled(model.busy).bobListRow()
            TextField("Search by email prefix", text: $model.query)
                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search).onSubmit { Task { await model.load() } }.bobListRow()
            if model.tab == .waitlist {
                Picker("Waitlist status", selection: $model.filter) {
                    ForEach(AdminWaitlistStatus.allCases, id: \.self) { Text($0.title).tag($0) }
                }.disabled(model.busy).bobListRow()
            }
            Button("Search") { Task { await model.load() } }.disabled(model.busy).bobListRow()
            if let message = model.message {
                Text(message).font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow()
            }
            if model.tab == .accounts { accounts } else { waitlist }
            if model.nextCursor != nil {
                Button(model.busy ? "Loading…" : "Load more") { Task { await model.load(more: true) } }
                    .disabled(model.busy).bobListRow()
            }
        }
    }
    @ViewBuilder private var accounts: some View {
        if let counts = model.accountCounts {
            Text("\(counts.total) accounts · \(counts.enabled) enabled · \(counts.disabled) disabled · \(counts.awaitingConfirmation) awaiting confirmation")
                .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
        }
        if model.accounts.isEmpty { Text("No matching accounts.").font(BobFont.subline).bobListRow() }
        ForEach(model.accounts) { account in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(account.email ?? "Account").font(BobFont.rowTitle)
                    Spacer(minLength: 8)
                    Menu {
                        ForEach(account.actions(selfID: model.selfID), id: \.self) { action in
                            Button(action.title) { selection = AccountActionSelection(account: account, action: action) }
                        }
                    } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                    .accessibilityLabel("Manage \(account.email ?? "account")").disabled(model.busy)
                }
                Text([account.status == .enabled ? "Sign-in enabled" : "Sign-in disabled", account.isAdmin ? "Admin" : nil, account.emailConfirmed ? "Email confirmed" : "Email not confirmed", account.id == model.selfID ? "You" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(BobFont.subline).foregroundStyle(.secondary)
                Text("Joined \(AdminServices.date(account.createdAt))\nLast sign-in: \(AdminServices.date(account.lastSignInAt))")
                    .font(BobFont.caption).foregroundStyle(.secondary)
            }.bobListRow()
        }
    }
    @ViewBuilder private var waitlist: some View {
        if let counts = model.waitlistCounts {
            Text("\(counts.total) waiting list · \(counts.verified) verified · \(counts.pending) pending · \(counts.withAccount) with accounts · \(counts.waitingVerified) verified and waiting")
                .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
        }
        if model.entries.isEmpty { Text("No matching people.").font(BobFont.subline).bobListRow() }
        ForEach(model.entries) { entry in
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.email).font(BobFont.rowTitle)
                Text("Source: \(entry.source) · Joined \(AdminServices.date(entry.createdAt))")
                    .font(BobFont.caption).foregroundStyle(.secondary)
                Text(entry.verifiedAt == nil ? "Awaiting verification" : "Email verified")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                Text(entry.accountStatus == .none ? "No account" : entry.accountStatus == .enabled ? "Sign-in enabled" : "Sign-in disabled")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                if entry.accountStatus == .none {
                    Button("Add person") { invitation = InvitationSelection(email: entry.email) }.disabled(model.busy)
                }
            }.bobListRow()
        }
    }
}
private struct AccountActionSelection { let account: AdminAccount; let action: AdminAccountAction }
private struct InvitationSelection: Identifiable { let id = UUID(); let email: String }
