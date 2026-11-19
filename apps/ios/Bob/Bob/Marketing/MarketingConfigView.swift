import BobKit
import SwiftUI

struct MarketingConfigView: View {
    @State private var model: MarketingConfigModel
    @State private var preview: String?
    @State private var confirm: ConfigConfirmation?
    @Environment(\.dismiss) private var dismiss
    init(installation: MarketingInstallation, service: any MarketingService) {
        _model = State(initialValue: MarketingConfigModel(installation: installation, service: service))
    }
    var body: some View {
        List {
            Text("Ask Bob for an app change. Review the proposal here before applying it. Your saved posts stay as they are.")
                .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            if model.loading { ProgressView("Opening app history…").bobListRow(divider: false) }
            if let error = model.error {
                VStack(alignment: .leading, spacing: 10) {
                    Text(marketingError(error)).font(BobFont.body).foregroundStyle(.secondary)
                    Button("Refresh configuration") { Task { await model.refresh() } }
                }.bobListRow(divider: false)
            }
            if let detail = model.detail {
                BobGroupHeader(title: "Current app · Version \(detail.installation.configRevision)")
                configSummary(detail.installation.config).bobListRow(divider: false)
                if detail.pending.isEmpty {
                    Text("No proposals to review yet.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
                }
                ForEach(detail.pending) { proposal in proposed(proposal, revision: detail.installation.configRevision) }
                BobGroupHeader(title: "App history")
                ForEach(model.versions) { version in
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Version \(version.revision)").font(BobFont.rowTitle)
                        Text(version.createdAt, format: .dateTime.month().day().year().hour().minute()).font(BobFont.subline).foregroundStyle(.secondary)
                        if let config = version.config { configSummary(config) }
                        if model.installation.configurable && version.restorable && version.revision != detail.installation.configRevision {
                            Button("Restore version \(version.revision)") { confirm = ConfigConfirmation(title: "Restore version \(version.revision)?", action: .restore(version: version.revision)) }.disabled(locked)
                        }
                    }.padding(.vertical, 8).bobListRow()
                }
                if model.next != nil { Button("Load older versions") { Task { await model.more() } }.disabled(locked).bobListRow() }
                BobGroupHeader(title: "Not available yet")
                ForEach(detail.dependencies) { Text($0.reason).font(BobFont.subline).foregroundStyle(.secondary).bobListRow() }
            }
            if model.busy { ProgressView("Saving the app change…").bobListRow(divider: false) }
        }
        .bobList().bobNavTitle("Improve this app").privacySensitive()
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(model.busy) } }
        .task { await model.refresh() }.onDisappear { model.cancel() }
        .interactiveDismissDisabled(model.busy)
        .confirmationDialog(confirm?.title ?? "Apply app change?", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
            if let confirm { Button("Confirm") { Task { await model.act(confirm.action) } } }
        } message: { Text("This changes the workspace layout. It doesn't edit posts or grant permissions.") }
    }
    private var locked: Bool { model.busy || model.loading }
    private func proposed(_ proposal: MarketingConfigDetail.Proposal, revision: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Proposed app change").font(BobFont.heading)
            Text("Based on version \(proposal.baseConfigRevision)").font(BobFont.subline).foregroundStyle(.secondary)
            ForEach(proposal.changes) { change in
                Text("\(fieldTitle(change.field)): \(change.before.display) → \(change.after.display)").font(BobFont.body)
            }
            Button(preview == proposal.id ? "Hide preview" : "Preview changes") { preview = preview == proposal.id ? nil : proposal.id }
            if preview == proposal.id {
                configSummary(proposal.config)
                Text("Preview only. No changes have been applied.").font(BobFont.caption).foregroundStyle(.secondary)
            }
            if proposal.baseConfigRevision != revision {
                Text("This proposal is out of date. Ask Bob for a new one or discard it.").font(BobFont.subline).foregroundStyle(.secondary)
            }
            if model.installation.configurable {
                Button("Apply changes") { confirm = ConfigConfirmation(title: "Apply these changes?", action: .apply(proposalID: proposal.id, hash: proposal.canonicalHash)) }
                    .disabled(locked || proposal.baseConfigRevision != revision)
                Button("Discard proposal", role: .destructive) { confirm = ConfigConfirmation(title: "Discard this proposal?", action: .discard(proposalID: proposal.id)) }.disabled(locked)
            }
        }.padding(.vertical, 12).bobListRow()
    }
    private func configSummary(_ config: MarketingConfig) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Views: \(config.visibleViews.joined(separator: ", "))")
            Text("Grouping: \(config.contentGrouping)")
            Text("Default channels: \(config.defaultChannels.map(\.title).joined(separator: ", "))")
        }.font(BobFont.subline).foregroundStyle(.secondary)
    }
    private func fieldTitle(_ field: String) -> String {
        switch field { case "visibleViews": "Views and order"; case "contentGrouping": "Content grouping"; case "defaultChannels": "Default channels"; default: field }
    }
}
private struct ConfigConfirmation {
    let title: String
    let action: MarketingConfigAction
}
