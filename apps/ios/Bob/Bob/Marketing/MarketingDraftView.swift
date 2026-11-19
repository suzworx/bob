import BobKit
import SwiftUI
import UIKit

struct MarketingDraftCard: View {
    let draft: MarketingDraft
    let package: MarketingPackage?
    let writable: Bool
    let onEdit: () -> Void
    let onAsk: () -> Void
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(draft.channel.title).font(BobFont.caption)
                Spacer()
                if draft.state == "needs_check" { Label("Needs check", systemImage: "eye").font(BobFont.subline).foregroundStyle(BobColor.warnText) }
            }
            if let day = draft.week.day { Text("Day \(day)").font(BobFont.caption).foregroundStyle(.secondary) }
            if let beat = draft.week.beat { Text(beat).font(BobFont.rowTitle) }
            if let pillar = draft.week.pillar { Text(pillar).font(BobFont.subline).foregroundStyle(.secondary) }
            Text(draft.body).font(BobFont.body).textSelection(.enabled)
            MarketingCreativeView(draft: draft, package: package)
            ViewThatFits(in: .horizontal) {
                HStack { actions }
                VStack(alignment: .leading, spacing: 10) { actions }
            }
        }.padding(16).background(BobColor.surface, in: RoundedRectangle(cornerRadius: 18)).padding(.vertical, 8)
    }
    @ViewBuilder private var actions: some View {
        Button(copied ? "Copied" : "Copy post", systemImage: copied ? "checkmark" : "doc.on.doc") {
            UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: draft.body]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)])
            copied = true
        }.buttonStyle(.bordered)
        Button("Edit draft", action: onEdit).disabled(!writable).buttonStyle(.bordered)
        Button("Ask Bob to change it", action: onAsk).disabled(!writable).buttonStyle(.bordered)
    }
}

struct MarketingDraftEditView: View {
    @State private var model: MarketingDraftEditor
    @State private var confirmingDiscard = false
    @Environment(\.dismiss) private var dismiss
    init(draft: MarketingDraft, installationID: String, service: any MarketingService) {
        _model = State(initialValue: MarketingDraftEditor(draft: draft, installationID: installationID, service: service))
    }
    var body: some View {
        NavigationStack {
            Form {
                if let error = model.error {
                    Text(marketingError(error)).foregroundStyle(.secondary)
                }
                if model.conflict {
                    Section("Your edits are still here") {
                        if let latest = model.latest {
                            Text("Latest saved text").font(.caption).foregroundStyle(.secondary)
                            Text(latest.body).textSelection(.enabled)
                            Button("Keep my edits against latest draft") { model.keepEditsAgainstLatest() }
                        } else {
                            Button("Load latest draft") { Task { await model.reloadLatest() } }
                        }
                    }
                }
                Section(model.base.channel == .instagram ? "Caption" : "Post narrative") {
                    TextEditor(text: $model.body).frame(minHeight: 180).disabled(locked)
                }
                Section("Image description") {
                    TextEditor(text: $model.altText).frame(minHeight: 80).disabled(locked)
                }
                Section("Pillar") { TextField("Pillar", text: $model.pillar).disabled(locked) }
                if !model.edit.valid { Text("Keep the post under 8,000 bytes, image description under 2,000 and pillar under 120.").font(.footnote).foregroundStyle(.secondary) }
                if model.submitted != nil && !model.busy {
                    Text("The last save wasn't confirmed. Retry the same save before making more changes.").font(.footnote).foregroundStyle(.secondary)
                }
                if model.busy { ProgressView("Saving your draft…") }
            }
            .bobForm()
            .bobNavTitle("Edit draft")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { if model.hasChanges { confirmingDiscard = true } else { dismiss() } }.disabled(model.busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.submitted == nil ? "Save" : "Retry save") { Task { if await model.save() { dismiss() } } }
                        .disabled(model.busy || model.conflict || !model.edit.valid)
                }
            }
            .interactiveDismissDisabled(model.hasChanges || model.busy)
            .confirmationDialog("Discard your unsaved edits?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard edits", role: .destructive) { dismiss() }
                Button("Keep editing", role: .cancel) {}
            } message: { Text(model.submitted == nil ? "Your last saved draft will stay as it is." : "The last save may have completed. Closing will refresh the saved draft.") }
        }.privacySensitive()
    }
    private var locked: Bool { model.busy || model.submitted != nil }
}
