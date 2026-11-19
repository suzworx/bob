import BobKit
import SwiftUI

struct InsightPreparationView: View {
    let onPrepared: () async -> Void
    @State private var model: InsightsPreparation
    @Environment(\.scenePhase) private var scenePhase

    init(category: InsightCategory, onPrepared: @escaping () async -> Void) {
        self.onPrepared = onPrepared
        _model = State(initialValue: InsightServices.preparation(category: category))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.category == .future ? "Prepare an outlook" : "Reflect on summaries")
                .font(BobFont.rowTitle).accessibilityAddTraits(.isHeader)
            Text(model.category == .future
                 ? "Bob can look at the next seven days on your selected calendars to spot busy days and overlaps."
                 : "Bob can compare saved email summaries to reflect on the periods they cover. No new emails are read for this.")
                .font(BobFont.subline).foregroundStyle(.secondary)
            accounts
            if model.busy {
                ProgressView("Preparing your perspective…").font(BobFont.subline)
            }
            if let error = model.error {
                Text(error == .unknown(status: 409) && model.category == .future
                     ? "Check your calendar selection in Integrations, then try again."
                     : "Couldn't prepare this insight. \(ApiErrorMapper.userMessage(error))")
                    .font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                integrations
            }
            if let notice = model.notice {
                Text(notice).font(BobFont.subline).accessibilityAddTraits(.updatesFrequently)
            }
        }
        .padding(.vertical, 12)
        .bobListRow()
        .task { await model.loadAccounts() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.loadAccounts() } }
        }
        .onDisappear { model.cancel() }
    }
    @ViewBuilder private var accounts: some View {
        switch model.accountsPhase {
        case .loading:
            ProgressView("Checking connected accounts…").font(BobFont.subline)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load your Google accounts", error: error) { await model.loadAccounts() }
        case .loaded:
            if model.eligibleAccounts.isEmpty {
                Text("Connect an account with \(model.category == .future ? "Calendar" : "Gmail") access.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                integrations
            } else {
                Picker("Google account", selection: $model.selectedAccountID) {
                    Text("Choose an account").tag(String?.none)
                    ForEach(model.eligibleAccounts) { account in
                        Text(account.displayName).tag(Optional(account.id))
                    }
                }
                .disabled(model.busy)
                Button(model.category == .future ? "Prepare outlook" : "Reflect on summaries") {
                    Task { if await model.prepare() { await onPrepared() } }
                }
                .buttonStyle(BobPrimaryButtonStyle())
                .disabled(!model.canPrepare)
            }
        }
    }
    private var integrations: some View {
        NavigationLink("Manage integrations") { IntegrationsView() }
            .font(BobFont.subline).frame(minHeight: 44)
    }
}
