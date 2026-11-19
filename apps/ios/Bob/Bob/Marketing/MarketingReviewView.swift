import BobKit
import SwiftUI

struct MarketingReviewView: View {
    let installationID: String
    let campaignID: String
    let onNote: (() -> Void)?
    @State private var model: MarketingReviewModel?
    @State private var confirmingApproval = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            if let model {
                content(model)
            } else {
                Text("Team review is available when connected to your account.")
                    .foregroundStyle(.secondary).bobListRow(divider: false)
            }
        }
        .bobList().bobNavTitle("Team review").privacySensitive()
        .task {
            if model == nil, let service = AppSession.make({ MarketingReviewClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) {
                model = MarketingReviewModel(installationID: installationID, campaignID: campaignID, service: service)
            }
            await model?.refresh()
        }
        .refreshable { await model?.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model?.checkForChanges() } }
        }
        .onDisappear { model?.cancel() }
        .confirmationDialog("Approve this saved plan?", isPresented: $confirmingApproval, titleVisibility: .visible) {
            Button("Approve this plan") { Task { await model?.approve() } }
        } message: {
            Text("Approval covers every saved post across all channels in this version. Publishing is not connected.")
        }
    }

    @ViewBuilder private func content(_ model: MarketingReviewModel) -> some View {
        if model.loading { ProgressView("Opening the complete saved plan…").bobListRow(divider: false) }
        if model.changed {
            Text("The plan or your access changed. Refresh, then review the latest version before approving.")
                .font(BobFont.body).foregroundStyle(.secondary).bobListRow(divider: false)
        }
        if let error = model.error {
            Text(model.changed ? marketingError(error) : "Couldn’t confirm this request. Your saved plan is still here. Try again to check the same approval.")
                .font(BobFont.body).foregroundStyle(.secondary).bobListRow(divider: false)
        }
        Button("Refresh plan review") { Task { await model.refresh() } }
            .disabled(model.loading || model.busy).bobListRow(divider: false)
        if let review = model.review {
            Section {
                Text(review.snapshot.campaign.name).font(BobFont.heading)
                Text(review.state == .approved && !model.changed ? "Plan approved" : "This plan needs review")
                    .font(BobFont.rowTitle)
                Text("\(review.snapshot.drafts.count) saved posts · all channels. Publishing is not connected.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                if review.canApprove {
                    Button("Approve this plan") { confirmingApproval = true }
                        .disabled(!model.canApprove)
                }
                if model.busy { ProgressView("Confirming approval…") }
            }
            Section("Complete saved plan") {
                Text(review.snapshot.campaign.goal.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(BobFont.subline).foregroundStyle(.secondary)
                if let note = review.snapshot.campaign.goalNote, !note.isEmpty { Text(note).textSelection(.enabled) }
                ForEach(review.snapshot.campaign.sections ?? []) { section in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(section.section.capitalized).font(BobFont.rowTitle)
                        ChatMarkdownView(text: section.content).textSelection(.enabled)
                    }.padding(.vertical, 4)
                }
            }
            Section("Every saved post") {
                if review.snapshot.drafts.isEmpty { Text("There are no saved posts to approve yet.").foregroundStyle(.secondary) }
                ForEach(review.snapshot.drafts) { draft in ReviewPostRow(draft: draft) }
            }
            Section("Team notes") {
                if review.notes.isEmpty { Text("No review notes yet.").foregroundStyle(.secondary) }
                ForEach(review.notes) { note in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(note.author?.label ?? "A team member") · Bob’s summary").font(BobFont.caption).foregroundStyle(.secondary)
                        Text(note.text).textSelection(.enabled)
                        Text(note.createdAt, format: .dateTime.month().day().hour().minute()).font(BobFont.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
                if let onNote {
                    Button("Add a review note with Bob", action: onNote)
                        .disabled(model.loading || model.busy || model.changed)
                }
            }
            Section("Approval history") {
                if review.history.isEmpty { Text("No approvals yet.").foregroundStyle(.secondary) }
                ForEach(review.history) { decision in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Approved by \(decision.author?.label ?? "a team member")").font(BobFont.rowTitle)
                        Text(decision.id == review.approval?.id ? "Current saved plan" : "Earlier saved plan")
                            .font(BobFont.caption).foregroundStyle(.secondary)
                        Text(decision.createdAt, format: .dateTime.month().day().hour().minute()).font(BobFont.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }
            }
        }
    }
}

private struct ReviewPostRow: View {
    let draft: MarketingDraft
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(draft.channel.title) · \(draft.format.capitalized)").font(BobFont.rowTitle)
            if let pillar = draft.pillar { Text(pillar).font(BobFont.caption).foregroundStyle(.secondary) }
            Text(draft.body).textSelection(.enabled)
            if let alt = draft.altText, !alt.isEmpty { Text("Alt text: \(alt)").font(BobFont.subline).foregroundStyle(.secondary) }
            Text(draft.state.replacingOccurrences(of: "_", with: " ").capitalized).font(BobFont.caption).foregroundStyle(.secondary)
            if draft.cta != "none" { Text("Call to action: \(draft.cta.replacingOccurrences(of: "_", with: " "))").font(BobFont.caption) }
            if !draft.approvedAssetIds.isEmpty || !draft.claimIds.isEmpty {
                Text("\(draft.approvedAssetIds.count) approved assets · \(draft.claimIds.count) supported claims").font(BobFont.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 6)
    }
}
