import Foundation

public enum MemoryTab: String, CaseIterable, Identifiable, Sendable {
    case all, people, preferences, facts

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: "All"
        case .people: "People"
        case .preferences: "Preferences"
        case .facts: "Facts"
        }
    }
}

// Memories are stored as "User is vegetarian."; the screen says the same thing to the person. Display only: an edit goes back to the stored voice.
public enum MemoryVoice {
    private static let toReader: [(String, String)] = [
        ("^User's\\b", "Your"),
        ("^User is\\b", "You're"),
        ("^User has\\b", "You have"),
        ("^User was\\b", "You were"),
        ("^User does\\b", "You do"),
        ("(?i)^I am\\b", "You're"),
        ("(?i)^I['’]m\\b", "You're"),
        ("(?i)^I['’]ve\\b", "You've"),
        ("(?i)^I have\\b", "You have"),
        ("(?i)^I was\\b", "You were"),
        ("(?i)^My\\b", "Your"),
        ("(?i)^I\\b", "You")
    ]

    private static let toStored: [(String, String)] = [
        ("(?i)^You['’]re\\b", "User is"),
        ("(?i)^You are\\b", "User is"),
        ("(?i)^You['’]ve\\b", "User has"),
        ("(?i)^You have\\b", "User has"),
        ("(?i)^You were\\b", "User was"),
        ("(?i)^Your\\b", "User's")
    ]

    private static let conjugateWithS: Set<String> = [
        "like", "love", "prefer", "hate", "dislike", "enjoy", "live", "work", "own", "drive",
        "eat", "drink", "play", "speak", "use", "need", "want", "read", "cook", "run", "support"
    ]

    private static let people = "(?i)\\b(" + [
        "wife", "husband", "partner", "spouse", "girlfriend", "boyfriend", "fiance", "fiancee", "fiancé", "fiancée",
        "son", "daughter", "sons", "daughters", "kid", "kids", "child", "children", "baby",
        "mother", "mom", "mum", "father", "dad", "parents", "sister", "brother", "sibling", "siblings",
        "grandmother", "grandma", "grandfather", "grandpa", "aunt", "uncle", "cousin", "niece", "nephew",
        "friend", "friends", "colleague", "coworker", "boss", "manager", "neighbor", "neighbour",
        "mother-in-law", "father-in-law", "roommate"
    ].joined(separator: "|") + ")\\b"

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    private static func replace(_ text: String, _ pattern: String, _ with: String) -> String {
        text.replacingOccurrences(of: pattern, with: with, options: .regularExpression)
    }

    // The word after a leading "User " or "You ", with where it ends.
    private static func leadingVerb(_ text: String, _ pattern: String) -> (verb: String, rest: Substring)? {
        guard let range = text.range(of: pattern, options: .regularExpression),
              let space = text[range].firstIndex(of: " ") else { return nil }
        return (String(text[text.index(after: space)..<range.upperBound]), text[range.upperBound...])
    }

    private static func baseForm(_ verb: String) -> String {
        if matches(verb, "ies$") { return String(verb.dropLast(3)) + "y" }
        if matches(verb, "(ss|sh|ch|x|z|o)es$") { return String(verb.dropLast(2)) }
        if matches(verb, "[^s]s$") { return String(verb.dropLast()) }
        return verb
    }

    public static func forReader(_ content: String) -> String {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        var out = text
        if let (pattern, with) = toReader.first(where: { matches(text, $0.0) }) {
            out = replace(text, pattern, with)
        } else if let (verb, rest) = leadingVerb(text, "^User\\s+[a-z]+\\b") {
            out = "You \(baseForm(verb))\(rest)"
        }
        return replace(replace(out, "\\bUser's\\b", "your"), "\\bUser\\b", "you")
    }

    // Only a leading subject is rewritten; a verb it doesn't know is left as typed rather than guessed at.
    public static func forStorage(_ content: String) -> String {
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if let (pattern, with) = toStored.first(where: { matches(text, $0.0) }) {
            return replace(text, pattern, with)
        }
        if let (verb, rest) = leadingVerb(text, "(?i)^You\\s+[a-z]+\\b"), conjugateWithS.contains(verb.lowercased()) {
            return "User \(verb.lowercased())s\(rest)"
        }
        return text
    }

    public static func isAboutPeople(_ content: String) -> Bool {
        matches(content, people)
    }
}

public enum MemoryRules {
    public static let contentLimit = 2000
    public static let taskTitleLimit = 200
    // Below this the extractor was unsure, and the row says so.
    public static let lowConfidence = 0.6

    // Facts and preferences. Intents and to-dos aren't listed: to-dos are suggestions instead.
    public static func listed(_ memories: [Memory]) -> [Memory] {
        memories.filter { $0.kind == .fact || $0.kind == .preference }
    }

    private static func tab(of memory: Memory) -> MemoryTab {
        if memory.kind == .preference { return .preferences }
        return MemoryVoice.isAboutPeople(memory.content) ? .people : .facts
    }

    public static func groups(_ memories: [Memory], tab selected: MemoryTab) -> [ProductivityGroup<Memory>] {
        let current = listed(memories).filter { $0.supersededBy == nil }
        return [MemoryTab.people, .preferences, .facts]
            .filter { selected == .all || selected == $0 }
            .map { tab in
                let rows = current.filter { self.tab(of: $0) == tab }
                return ProductivityGroup(title: "\(tab.title), \(rows.count)", rows: rows)
            }
            .filter { !$0.rows.isEmpty }
    }

    // Versions a newer memory replaced; only the All tab shows them.
    public static func older(_ memories: [Memory]) -> [Memory] {
        listed(memories).filter { $0.supersededBy != nil }
    }

    public static func subline(_ memory: Memory, now: Date, locale: Locale = .current) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        var parts = [memory.kind == .preference ? "Preference" : "Fact", formatter.localizedString(for: memory.createdAt, relativeTo: now)]
        if memory.confidence < lowConfidence { parts.append("Not sure") }
        if memory.sensitive { parts.append("Sensitive") }
        return parts.joined(separator: " · ")
    }

    public static func taskTitle(_ item: ActionItem) -> String {
        String(item.content.trimmingCharacters(in: .whitespacesAndNewlines).prefix(taskTitleLimit))
    }

    public static func isOverdue(_ item: ActionItem, now: Date) -> Bool {
        guard item.status == .open, let due = item.dueAt else { return false }
        return due < now
    }
}
