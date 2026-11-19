import BobKit
import SwiftUI

struct MarketingWorkspaceView: View {
    @Bindable var model: MarketingWorkspaceModel
    let onAsk: (MarketingChatTarget, String) -> Void
    @State private var editing: MarketingDraft?
    @State private var showingConfig = false
    @State private var showingBrand = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            header
            if let error = model.error {
                VStack(alignment: .leading, spacing: 8) {
                    Text(marketingError(error)).font(BobFont.body).foregroundStyle(.secondary)
                    Button("Refresh workspace") { Task { await model.refresh() } }
                }.bobListRow(divider: false)
            }
            if model.loading { ProgressView("Opening your saved workspace…").bobListRow(divider: false) }
            if model.ready {
                if let campaign = model.campaign {
                    campaignPlan(campaign)
                    if model.spaceID != nil, model.installation?.spaceId == model.spaceID {
                        NavigationLink {
                            MarketingReviewView(installationID: model.installationID, campaignID: campaign.id, onNote: reviewNoteAction)
                        } label: { Label("Team review", systemImage: "checkmark.bubble") }
                        .bobListRow(divider: false)
                    }
                }
                else { firstCampaign }
                if model.selectedCampaignID != nil { board }
            }
        }
        .bobList().bobNavTitle("Bob Marketing").privacySensitive()
        .toolbar { ToolbarItem(placement: .primaryAction) { workspaceMenu } }
        .safeAreaInset(edge: .bottom) {
            if let target = model.target() {
                Button { onAsk(target, "") } label: { Label("Ask Bob", systemImage: "bubble.left.and.bubble.right").frame(maxWidth: .infinity).padding(.vertical, 8) }
                    .buttonStyle(.borderedProminent).padding().background(BobColor.page)
            }
        }
        .task { await model.refresh() }
        .refreshable { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active && editing == nil { Task { await model.refresh() } } }
        .onDisappear { model.cancel() }
        .sheet(item: $editing, onDismiss: { Task { await model.refresh() } }) { draft in
            MarketingDraftEditView(draft: draft, installationID: model.installationID, service: model.service).bobSheet()
        }
        .sheet(isPresented: $showingConfig, onDismiss: { Task { await model.refresh() } }) {
            if let installation = model.installation {
                NavigationStack { MarketingConfigView(installation: installation, service: model.service) }.bobSheet()
            }
        }
        .sheet(isPresented: $showingBrand) {
            NavigationStack { if let package = model.package { MarketingBrandView(package: package) } }.bobSheet()
        }
    }
    private var reviewNoteAction: (() -> Void)? {
        guard let target = model.target() else { return nil }
        return { onAsk(target, "Add a review note on this plan: ") }
    }
    @ViewBuilder private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            #if DEBUG
            if AppConfig.apiBaseURL == nil { Text("Preview workspace · changes stay in this demo").font(BobFont.caption).foregroundStyle(.secondary) }
            #endif
            Text("Drafts only. Nothing posts until you copy or share it.").font(BobFont.subline).foregroundStyle(.secondary)
            if model.installation != nil {
                Picker("Campaign", selection: Binding(get: { model.selectedCampaignID ?? "" }, set: { value in Task { await model.select(value.isEmpty ? nil : value) } })) {
                    Text("New campaign").tag("")
                    ForEach(model.campaigns.filter { $0.status != "archived" }) { Text($0.name).tag($0.id) }
                }.disabled(model.loading || model.busy)
                lifecycle
            }
        }.padding(.vertical, 12).bobListRow(divider: false)
    }
    @ViewBuilder private var lifecycle: some View {
        if let installation = model.installation, installation.state != "active" {
            Text(installation.state == "paused" ? "Marketing is paused. Your saved work is still here." : "Activate Marketing to create and save campaigns.")
                .font(BobFont.subline).foregroundStyle(.secondary)
            if installation.canManage && (installation.state == "paused" || installation.state == "draft") {
                Button(installation.state == "paused" ? "Resume app" : "Activate app") {
                    Task { await model.changeLifecycle(installation.state == "paused" ? .resume : .activate) }
                }.disabled(model.loading || model.busy)
            }
        }
    }
    private var workspaceMenu: some View {
        Menu {
            Button("Improve this app") { showingConfig = true }
            Button("App history") { showingConfig = true }
            Button("Brand & skills") { showingBrand = true }
            if let target = model.target(mode: "refine") { Button("Ask Bob to improve this app") { onAsk(target, "") } }
            if model.installation?.canManage == true && model.installation?.state == "active" {
                Button("Pause app") { Task { await model.changeLifecycle(.pause) } }.disabled(model.busy || model.loading)
            }
        } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("Marketing actions") }
    }
    private var firstCampaign: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image("BobPlayful").resizable().scaledToFit().frame(height: 130).accessibilityHidden(true)
            Text("What should we post?").font(BobFont.heading)
            Text("Bob already knows the product. Start with an idea, rough copy or a goal.").font(BobFont.body).foregroundStyle(.secondary)
            if let target = model.target() {
                Button("A week of posts") { onAsk(target, "Write a week of posts about ") }
                Button("Polish my rough copy") { onAsk(target, "Turn this rough copy into a post: ") }
                Button("Plan a launch") { onAsk(target, "Plan a launch campaign for ") }
            }
        }.padding(.vertical, 12).bobListRow(divider: false)
    }
    private func campaignPlan(_ campaign: MarketingCampaign) -> some View {
        DisclosureGroup("See the full plan") {
            ForEach((campaign.sections ?? []).filter { !$0.content.isEmpty }) { section in
                VStack(alignment: .leading, spacing: 8) {
                    Text(section.section.capitalized).font(BobFont.caption)
                    ChatMarkdownView(text: section.content).textSelection(.enabled)
                }.padding(.vertical, 8)
            }
        }.bobListRow(divider: false)
    }
    @ViewBuilder private var board: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("This week").font(BobFont.heading)
            Picker("Show posts for", selection: $model.channel) {
                Text("All channels").tag(Optional<MarketingChannel>.none)
                ForEach(MarketingChannel.allCases, id: \.self) { Text($0.title).tag(Optional($0)) }
            }.bobChoicePicker()
        }.bobListRow(divider: false)
        if model.visibleDrafts.isEmpty {
            Text(model.nextDraftCursor == nil ? "No posts here yet. Ask Bob for a few." : "No matching posts on this page. Load more to see the rest.")
                .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
        }
        ForEach(model.draftGroups) { group in
            BobGroupHeader(title: group.id)
            ForEach(group.drafts) { draft in
            MarketingDraftCard(draft: draft, package: model.package, writable: model.installation?.writable == true, onEdit: { editing = draft }, onAsk: {
                if let target = model.target() { onAsk(target, "Change \(draft.channel.title) post \(draft.id), \"\(draft.body.prefix(60))\": ") }
            }).bobListRow(divider: false)
        }
        }
        if model.nextDraftCursor != nil {
            Button("Load more posts") { Task { await model.moreDrafts() } }.disabled(model.busy).bobListRow(divider: false)
        }
        if model.busy { ProgressView("Working on it…").bobListRow(divider: false) }
    }
}

private struct MarketingBrandView: View {
    let package: MarketingPackage
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            Text(package.mission).font(BobFont.body).bobListRow(divider: false)
            Text(package.voice).font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            ForEach(package.roles) { role in
                VStack(alignment: .leading, spacing: 6) {
                    Text(role.label).font(BobFont.rowTitle)
                    Text(role.summary).font(BobFont.subline).foregroundStyle(.secondary)
                }.bobListRow()
            }
            BobGroupHeader(title: "Not available yet")
            ForEach(package.capabilities.filter { $0.status == "unavailable" }) { Text($0.reason).font(BobFont.subline).bobListRow() }
        }.bobList().bobNavTitle("Brand & skills")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
    }
}
