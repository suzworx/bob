import BobKit
import SwiftUI

struct RoutineRunsView: View {
    let routine: Routine
    let client: RoutinesClient?
    @State private var runs: [RoutineRun] = []
    @State private var loading = true
    @State private var error: String?
    @State private var reload = 0

    var body: some View {
        Group {
            if loading { ProgressView("Opening run history…").bobListRow(divider: false) }
            if let error { RoutineRetry(message: error) { reload += 1 }.bobListRow(divider: false) }
            if !loading, error == nil, runs.isEmpty {
                ContentUnavailableView("Your first recap is ahead", systemImage: "clock", description: Text("Each scheduled run will appear here, including runs that couldn't finish."))
                    .bobListRow(divider: false)
            }
            ForEach(runs) { run in
                NavigationLink {
                    RoutineRunView(routineID: routine.id, runID: run.id, client: client)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(run.result?.title ?? run.status.rawValue.capitalized).font(BobFont.rowTitle)
                        Text(run.scheduledAt, format: .dateTime.month().day().hour().minute()).font(BobFont.subline).foregroundStyle(.secondary)
                        Text(run.status.rawValue.capitalized).font(BobFont.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                }.bobListRow()
            }
            if !loading { Button("Refresh history") { reload += 1 }.bobListRow(divider: false) }
        }
        .task(id: reload) { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            guard let client else { loading = false; return }
            let result = try await client.runs(id: routine.id)
            guard !Task.isCancelled else { return }
            runs = result
            loading = false
        } catch {
            guard !Task.isCancelled else { return }
            loading = false
            self.error = RoutinesModel.message(error)
        }
    }
}

private struct RoutineRunView: View {
    let routineID: String
    let runID: String
    let client: RoutinesClient?
    @State private var run: RoutineRun?
    @State private var error: String?
    @State private var loading = true
    @State private var reload = 0

    var body: some View {
        List {
            if loading { ProgressView("Opening recap…").bobListRow(divider: false) }
            if let error { RoutineRetry(message: error) { reload += 1 }.bobListRow(divider: false) }
            if let run {
                VStack(alignment: .leading, spacing: 12) {
                    Text(run.result?.title ?? run.status.rawValue.capitalized).font(BobFont.greeting).accessibilityAddTraits(.isHeader)
                    Text(run.scheduledAt, format: .dateTime.month().day().year().hour().minute()).font(BobFont.subline).foregroundStyle(.secondary)
                    if let start = run.coverageStart, let end = run.coverageEnd {
                        Text("Coverage: \(ProductivityText.moment(start)) – \(ProductivityText.moment(end))").font(BobFont.subline).foregroundStyle(.secondary)
                    }
                    if let explanation = run.explanation { Text(explanation).font(BobFont.body) }
                    if let result = run.result {
                        if result.partial { Label("Partial recap: some sources couldn't be included.", systemImage: "info.circle").font(BobFont.subline) }
                        ChatMarkdownView(text: result.summary).textSelection(.enabled)
                    } else {
                        Text(run.status == .pending || run.status == .running ? "Bob is still preparing this run. Pull down to check again." : "No recap was saved for this run.").font(BobFont.body)
                    }
                    if let outcome = run.emailOutcome { Text(outcome == "queued" ? "Recap email queued" : "Recap email muted by your preferences").font(BobFont.subline).foregroundStyle(.secondary) }
                }.padding(.vertical, 8).bobListRow(divider: false)
                ForEach(run.result?.sources ?? []) { source in
                    if let url = source.safeURL { Link(source.label.isEmpty ? "Source" : source.label, destination: url).bobListRow() }
                    else { Text(source.label.isEmpty ? "Source" : source.label).bobListRow() }
                }
            }
        }
        .bobList().bobNavTitle("Recap").privacySensitive()
        .task(id: reload) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            guard let client else { throw ApiError.unauthenticated }
            let result = try await client.run(id: routineID, runID: runID)
            guard !Task.isCancelled else { return }
            run = result
            loading = false
        } catch {
            guard !Task.isCancelled else { return }
            loading = false
            self.error = RoutinesModel.message(error)
        }
    }
}
