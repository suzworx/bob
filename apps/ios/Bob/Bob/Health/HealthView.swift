import BobKit
import HealthKit
import SwiftUI

struct HealthView: View {
    var chat: ChatRouting?
    @Environment(\.healthChatRouting) private var inheritedChat
    @State private var model = HealthModel()
    @State private var search = ""
    @State private var onlyWithData = true
    @State private var pendingDraft: String?
    @State private var review: HealthDraftReview?
    @Environment(\.scenePhase) private var scenePhase
    private var chatRouting: ChatRouting? { chat ?? inheritedChat }
    private var visibleRows: [HealthSummary] {
        model.rows.filter { (!onlyWithData || $0.hasData) && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search)) }
    }

    var body: some View {
        List {
            introduction
            if model.available {
                controls
                if !model.rows.isEmpty {
                    summaryControls
                    ForEach(visibleRows) { row in summaryRow(row) }
                    if visibleRows.isEmpty {
                        Text("No matching readable summaries. You can show all categories or check access in Health.")
                            .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
                    }
                }
                boundaries
            } else {
                ContentUnavailableView("Apple Health isn't available here", systemImage: "heart", description: Text("Open Bob on a supported iPhone to connect Apple Health."))
                    .bobListRow(divider: false)
            }
        }
        .bobList().bobNavTitle("Apple Health").privacySensitive()
        .searchable(text: $search, prompt: "Find a health category")
        .modifier(HealthPrivacyShield())
        .sheet(item: $review, onDismiss: {
            if let draft = pendingDraft { pendingDraft = nil; chatRouting?.new(draft) }
        }) { draft in
            HealthDraftReviewView(draft: draft.text) { text in
                pendingDraft = text
                review = nil
            }.bobSheet()
        }
        .onDisappear { model.clear() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { pendingDraft = nil; review = nil; model.clear() }
        }
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Your health, in your hands", systemImage: "heart.fill").font(BobFont.heading)
            Text("See summaries from the Apple Health categories you choose. Reading is local to this iPhone. Bob never changes your health records.")
                .font(BobFont.subline).foregroundStyle(BobColor.ink2)
            Text("To discuss a summary with Bob, select it, review the exact text, then send it yourself in chat. Sending shares that text with Bob's service and AI provider as a normal saved chat.")
                .font(BobFont.caption).foregroundStyle(BobColor.ink2)
        }.padding(.vertical, 12).bobListRow(divider: false)
    }

    private var controls: some View {
        Group {
            if let error = model.error { Text(error).font(BobFont.subline).bobListRow() }
            Picker("Period", selection: $model.days) {
                Text("Today").tag(1)
                Text("7 days").tag(7)
                Text("30 days").tag(30)
            }.disabled(model.busy).bobListRow()
                .onChange(of: model.days) { _, _ in model.clear() }
            Button(model.accessRequested ? "Review Health access" : "Connect Apple Health") {
                Task { await model.connect() }
            }.disabled(model.busy).bobListRow()
            ForEach(model.perObjectTypes, id: \.identifier) { type in
                Button("Choose \(HealthTypeCatalog.title(type)) records") {
                    Task { await model.chooseRecords(type) }
                }.disabled(model.busy).bobListRow()
            }
            if model.supportsClinical {
                Button("Choose clinical records access") { Task { await model.connectClinical() } }
                    .disabled(model.busy).bobListRow()
            } else {
                Text("Clinical records aren't supported by Apple Health on this device.")
                    .font(BobFont.caption).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
            }
            Menu("Choose a verifiable health record") {
                Button("Immunization") { Task { await model.chooseVerifiable(.immunization, title: "Verifiable immunization records") } }
                Button("Laboratory") { Task { await model.chooseVerifiable(.laboratory, title: "Verifiable laboratory records") } }
                Button("Recovery") { Task { await model.chooseVerifiable(.recovery, title: "Verifiable recovery records") } }
                Button("COVID-19") { Task { await model.chooseVerifiable(.covid19, title: "Verifiable COVID-19 records") } }
            }.disabled(model.busy).bobListRow()
            if model.accessRequested {
                Button("Read summaries on this iPhone") { Task { await model.refresh() } }
                    .disabled(model.busy).bobListRow()
            }
            if model.busy {
                ProgressView(model.progress == 0 ? "Opening Apple Health…" : "Reading categories · \(model.progress)")
                    .bobListRow(divider: false)
            }
            Text("Apple keeps denied access private. An empty category may mean no records or no read access. You can change permissions in Health → your profile → Apps → Bob.")
                .font(BobFont.caption).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
        }
    }

    private var summaryControls: some View {
        Group {
            BobGroupHeader(title: "\(model.period) · \(model.rows.filter(\.hasData).count) readable categories")
            Toggle("Only categories with data", isOn: $onlyWithData).bobListRow()
            Button("Review \(model.selected.count) selected summaries") {
                if let draft = model.draft { review = HealthDraftReview(text: draft) }
            }.disabled(model.draft == nil || model.busy || chatRouting == nil).bobListRow()
            Text("Select up to \(HealthShareDraft.maximumSelections) categories per draft. None are selected automatically.")
                .font(BobFont.caption).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
        }
    }

    private func summaryRow(_ row: HealthSummary) -> some View {
        Button {
            if model.selected.contains(row.id) { model.selected.remove(row.id) }
            else if model.selected.count < HealthShareDraft.maximumSelections { model.selected.insert(row.id) }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                if row.hasData {
                    Image(systemName: model.selected.contains(row.id) ? "checkmark.circle.fill" : "circle")
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(row.title).font(BobFont.rowTitle)
                    Text(row.detail).font(BobFont.subline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }.padding(.vertical, 8).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!row.hasData || model.busy)
        .accessibilityLabel("\(row.title). \(row.detail)")
        .accessibilityValue(model.selected.contains(row.id) ? "Selected" : "Not selected")
        .accessibilityHint(row.hasData ? "Select for review. Nothing is sent." : "No readable summary")
        .bobListRow()
    }

    private var boundaries: some View {
        Group {
            BobGroupHeader(title: "What's included")
            Text("Available quantity and category records, workouts, activity rings, heart recordings, hearing tests, vision prescriptions, health documents and personal profile. Clinical records have a separate optional access step. Mood and assessments require iOS 18; medication logs require iOS 26. Summaries are bounded to the selected period; some special records show a count and latest date rather than their full contents.")
                .font(BobFont.caption).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
            Text("Precise workout locations, ECG waveforms and document contents are never included in a chat draft. Health reads aren't synced in the background. Leaving this screen clears its summaries; Health permissions remain under your control.")
                .font(BobFont.caption).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
        }
    }
}

private struct HealthDraftReview: Identifiable {
    let id = UUID()
    let text: String
}

private struct HealthDraftReviewView: View {
    let draft: String
    let makeDraft: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("This exact text will go into a new chat draft. Nothing is sent until you tap Send there. Sending shares it with Bob's service and AI provider and saves it in your chat history.")
                        .font(BobFont.subline).foregroundStyle(BobColor.ink2)
                    Text(draft).font(BobFont.body).textSelection(.enabled)
                    Button("Create unsent chat draft") { makeDraft(draft) }
                        .buttonStyle(.borderedProminent)
                }.padding()
            }
            .bobNavTitle("Review health summary")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }.privacySensitive().modifier(HealthPrivacyShield())
    }
}

private struct HealthPrivacyShield: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.overlay {
            if scenePhase != .active {
                ZStack {
                    Color(.systemBackground).ignoresSafeArea()
                    Label("Apple Health", systemImage: "lock.fill").font(BobFont.heading)
                }.accessibilityHidden(true)
            }
        }
    }
}

extension EnvironmentValues {
    @Entry var healthChatRouting: ChatRouting? = nil
}
