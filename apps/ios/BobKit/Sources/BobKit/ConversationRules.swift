import Foundation

// The chat list's sections, in the order the web shows them.
public struct ConversationGroup: Equatable, Sendable, Identifiable {
    public let title: String
    public let rows: [ConversationSummary]

    public var id: String { title }
}

public enum ConversationRules {
    // Pinned, then Today, then Earlier, keeping the server's order within each.
    public static func groups(_ conversations: [ConversationSummary], now: Date, calendar: Calendar = .current) -> [ConversationGroup] {
        let startOfToday = calendar.startOfDay(for: now)
        let unpinned = conversations.filter { !$0.pinned }
        let groups = [
            ConversationGroup(title: "Pinned", rows: conversations.filter(\.pinned)),
            ConversationGroup(title: "Today", rows: unpinned.filter { $0.updatedAt >= startOfToday }),
            ConversationGroup(title: "Earlier", rows: unpinned.filter { $0.updatedAt < startOfToday })
        ]
        return groups.filter { !$0.rows.isEmpty }
    }

    // A chat row's time: the clock today, then Yesterday, the weekday for the past week, and a short date after that.
    public static func rowTime(_ date: Date, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        switch days {
        case ...0:
            style = style.hour().minute()
        case 1:
            return String(localized: "Yesterday", locale: locale)
        case 2...6:
            style = style.weekday(.wide)
        default:
            style = style.year(.twoDigits).month(.defaultDigits).day(.defaultDigits)
        }
        return date.formatted(style)
    }

    // A chat as plain text to share, in the form of the web's download: only text and a placeholder per attachment.
    public static func markdown(_ detail: ConversationDetail, exportedAt: Date = Date()) -> String {
        let day = exportedAt.formatted(.iso8601.year().month().day())
        var blocks = ["# \(detail.title)", "Exported from Bob on \(day)."]
        for message in detail.messages {
            let pieces: [String] = message.parts.compactMap { part in
                switch part {
                case .text(let text): text
                case .file(let attachment): "[Image: \(attachment.name ?? "image")]"
                case .reasoning, .tool, .other: nil
                }
            }
            guard !pieces.isEmpty else {
                continue
            }
            blocks.append(message.role == .user ? "**You**" : "**Bob**")
            blocks += pieces
        }
        return blocks.joined(separator: "\n\n") + "\n"
    }
}

public enum SearchRules {
    // The server's minimum for a useful search; one letter only filters the commands.
    public static let minimumQuery = 2

    public static func shouldSearch(_ query: String) -> Bool {
        query.trimmingCharacters(in: .whitespacesAndNewlines).count >= minimumQuery
    }

    // Results by type, in the web's order.
    public static func groups(_ results: [SearchResult]) -> [(kind: SearchResult.Kind, rows: [SearchResult])] {
        SearchResult.Kind.allCases.compactMap { kind in
            let rows = results.filter { $0.kind == kind }
            return rows.isEmpty ? nil : (kind, rows)
        }
    }

    // A note's whole body comes back as its snippet, so this cuts it down to one line around the words that matched.
    public static func excerpt(_ snippet: String, around query: String, radius: Int = 40) -> String {
        let flat = snippet.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !flat.isEmpty else {
            return ""
        }
        guard !needle.isEmpty, let match = flat.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) else {
            return flat.count > radius * 2 ? String(flat.prefix(radius * 2)) + "…" : flat
        }
        let start = flat.index(match.lowerBound, offsetBy: -radius, limitedBy: flat.startIndex) ?? flat.startIndex
        let end = flat.index(match.upperBound, offsetBy: radius, limitedBy: flat.endIndex) ?? flat.endIndex
        return (start > flat.startIndex ? "…" : "") + flat[start..<end] + (end < flat.endIndex ? "…" : "")
    }
}
