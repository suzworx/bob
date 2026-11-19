import Foundation

/// Local-only summaries. No networking or persistence belongs in this model.
public struct HealthSummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let hasData: Bool

    public init(id: String, title: String, detail: String, hasData: Bool) {
        self.id = id; self.title = title; self.detail = detail; self.hasData = hasData
    }
}

public struct HealthReadWindow: Sendable {
    public let start: Date
    public let end: Date
    public let timeZone: TimeZone

    public init(days: Int, now: Date, calendar: Calendar = .current) {
        end = now
        timeZone = calendar.timeZone
        start = calendar.date(byAdding: .day, value: -(max(1, min(days, 30)) - 1), to: calendar.startOfDay(for: now)) ?? now
    }

    public func clippedDuration(start: Date, end: Date) -> TimeInterval {
        max(0, min(end, self.end).timeIntervalSince(max(start, self.start)))
    }

    public var description: String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = timeZone
        return "\(formatter.string(from: start)) through \(formatter.string(from: end)) (\(timeZone.identifier)); read as of \(formatter.string(from: end))"
    }

    /// Multiple Health sources can record the same session. Count overlap once.
    public func mergedDuration(_ intervals: [DateInterval]) -> TimeInterval {
        let clipped = intervals.compactMap { interval -> DateInterval? in
            let lower = max(start, interval.start)
            let upper = min(end, interval.end)
            return lower < upper ? DateInterval(start: lower, end: upper) : nil
        }.sorted { $0.start < $1.start }
        guard var current = clipped.first else { return 0 }
        var total: TimeInterval = 0
        for interval in clipped.dropFirst() {
            if interval.start <= current.end {
                current = DateInterval(start: current.start, end: max(current.end, interval.end))
            } else {
                total += current.duration
                current = interval
            }
        }
        return total + current.duration
    }
}

public enum HealthShareDraft {
    public static let maximumSelections = 30

    /// The caller reviews this exact text before creating an UNSENT chat draft.
    public static func make(rows: [HealthSummary], selected: Set<String>, window: HealthReadWindow) -> String? {
        let included = rows.filter { $0.hasData && selected.contains($0.id) }
        guard !included.isEmpty, included.count <= maximumSelections else { return nil }
        let lines = included.map { "• \($0.title): \($0.detail)" }.joined(separator: "\n")
        let draft = "My selected Apple Health summaries:\nRead window: \(window.description). Profile, medication-list and one-time selections are labeled separately.\n\(lines)\n\nHelp me understand these summaries. Missing readings do not mean zero. These are personal wellness records, not a diagnosis."
        guard draft.count <= 12_000 else { return nil }
        return draft
    }
}
