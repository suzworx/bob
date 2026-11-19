import BobKit
import Charts
import SwiftUI

// A few counts and one chart. Counts and times only, never what was said. Held in this screen only.
struct UsageView: View {
    let service: AccountService
    var openMemory: () -> Void = {}

    @Environment(\.scenePhase) private var scenePhase
    @State private var range: UsageRange = .week
    @State private var phase: LoadPhase = .loading
    @State private var usage: UsageReport?
    @State private var usageRange: UsageRange?

    var body: some View {
        List {
            Text("Only you can see this.")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .bobListRow(divider: false)
            Picker("Range", selection: $range) {
                ForEach(UsageRange.allCases) { Text($0.title).tag($0) }
            }
            .bobChoicePicker()
            .frame(minHeight: 44)
            .bobListRow(divider: false)
            content
        }
        .bobList()
        .bobNavTitle("Usage")
        .task(id: range) { await load(quiet: usageRange == range) }
        .refreshable { await load(quiet: true) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load(quiet: true) } }
        }
    }

    @ViewBuilder private var content: some View {
        if let usage, usageRange == range {
            if UsageRules.hasNoActivity(usage) {
                ContentUnavailableView {
                    Text("Nothing here yet").font(BobFont.heading)
                } description: {
                    Text("Talk to Bob and your counts will show up here.")
                }
                .bobListRow(divider: false)
            } else {
                numbers(usage)
            }
        } else if case .failed(let error) = phase {
            BobLoadFailure(title: "Couldn't load your usage", error: error) { await load(quiet: false) }
                .bobListRow(divider: false)
        } else {
            ProgressView()
                .accessibilityLabel("Loading your usage")
                .frame(maxWidth: .infinity, minHeight: 200)
                .bobListRow(divider: false)
        }
    }

    @ViewBuilder private func numbers(_ usage: UsageReport) -> some View {
        BobFactRow(title: "Days you talked to Bob", value: "\(usage.activeDays) of \(range.days)")
        BobFactRow(title: "Messages", value: String(usage.turns.total))
        BobFactRow(title: "New conversations", value: String(usage.conversationsCreated))
        BobFactRow(title: "To-dos done", value: String(usage.todosDone))
        if let memories = usage.memories {
            Button(action: openMemory) {
                HStack(spacing: 12) {
                    Text("New memories").font(BobFont.rowTitle).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    Text("\(memories.newInRange) of \(memories.total) total").font(BobFont.subline).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.secondary).accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityHint("Opens Memory")
            .bobListRow()
        }
        if let minutes = usage.gameMinutes, minutes > 0 {
            BobFactRow(title: "Game minutes", value: String(minutes))
        }
        if let sentence = UsageRules.busiestSentence(usage) {
            Text(sentence).padding(.top, 8).bobListRow(divider: false)
        }
        UsageChart(usage: usage).padding(.top, 8).bobListRow(divider: false)
    }

    // A failed refetch of the range on screen keeps its numbers.
    private func load(quiet: Bool) async {
        let asked = range
        if !quiet { phase = .loading }
        do {
            let report = try await service.usage(asked)
            guard asked == range, !Task.isCancelled else { return }
            usage = report
            usageRange = asked
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard asked == range, usageRange != asked else { return }
            phase = .failed(apiError(error))
        }
    }
}

private struct UsageChart: View {
    let usage: UsageReport

    private struct Bar: Identifiable {
        let id: String
        let date: Date
        let surface: String
        let count: Int
    }

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }()

    private static let device = "Bob device"
    private static let voice = "Voice"
    private static let typed = "Typed"

    private var bars: [Bar] {
        usage.turns.byDay.flatMap { day -> [Bar] in
            guard let date = UsageRules.date(ofDay: day.day) else { return [] }
            return [
                Bar(id: "\(day.day)d", date: date, surface: Self.device, count: day.counts.device),
                Bar(id: "\(day.day)v", date: date, surface: Self.voice, count: day.counts.voice),
                Bar(id: "\(day.day)t", date: date, surface: Self.typed, count: day.counts.typed)
            ]
        }
    }

    private var summary: String {
        let counts = usage.turns.bySurface
        return "\(Self.device) \(counts.device), \(Self.voice) \(counts.voice), \(Self.typed) \(counts.typed)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Messages per day").font(BobFont.caption).accessibilityAddTraits(.isHeader)
            Chart(bars) { bar in
                BarMark(x: .value("Day", bar.date, unit: .day), y: .value("Messages", bar.count))
                    .foregroundStyle(by: .value("From", bar.surface))
            }
            .chartForegroundStyleScale([Self.device: BobColor.accent, Self.voice: BobColor.warnText, Self.typed: BobColor.okText])
            // The days are the account's already, so they must not shift by this phone's zone.
            .environment(\.timeZone, Self.utc.timeZone)
            .environment(\.calendar, Self.utc)
            .frame(height: 220)
            .accessibilityHidden(true)
            Text(summary).font(BobFont.subline).foregroundStyle(.secondary)
        }
    }
}
