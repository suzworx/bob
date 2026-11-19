import Foundation

// Why Siri or a shortcut couldn't finish, beyond what the server can say.
public enum SiriFailure: Error, Equatable, Sendable {
    // The wait ran out. The server keeps going without a reader, so the reply still lands in the chat.
    case stillThinking
    // Bob answered with something other than words, such as a card to approve.
    case nothingToSay
    case nothingGiven
    case reminderInThePast
}

// Everything Siri says when something goes wrong. Only these words and ApiErrorMapper's ever reach the person.
public enum SiriLines {
    public static let signedOut = "Open Bob and sign in first."
    public static let offline = "I can't reach Bob right now. Check your connection and try again."

    public static func failure(_ error: Error) -> String {
        switch error {
        case let failure as SiriFailure:
            switch failure {
            case .stillThinking: return "Bob's still thinking. The answer will be waiting in your chat."
            case .nothingToSay: return "Bob answered in your chat. Open Bob to see it."
            case .nothingGiven: return "I didn't catch that. Try again."
            case .reminderInThePast: return "That time has already passed. Pick a later one."
            }
        case let api as ApiError:
            switch api {
            case .unauthenticated: return signedOut
            case .offline: return offline
            default: return ApiErrorMapper.userMessage(api)
            }
        default:
            return ApiErrorMapper.userMessage(.unknown(status: 0))
        }
    }

    public static func isCancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? ApiError) == .cancelled
    }

    public static func taskAdded(_ title: String, due: TaskDue?, locale: Locale = .current) -> String {
        guard let due else { return "Added \(title) to your tasks." }
        return "Added \(title), due \(ProductivityText.due(due, locale: locale))."
    }

    public static func noteSaved(_ title: String) -> String {
        "Saved your note, \(title)."
    }

    public static func reminderSet(_ title: String, at date: Date, zone: String? = nil, locale: Locale = .current) -> String {
        "I'll remind you about \(title), \(ProductivityText.moment(date, zone: zone, locale: locale))."
    }

    public static func openTasks(_ titles: [String]) -> String {
        switch titles.count {
        case 0: return "No open tasks. Nice."
        case 1: return "One open task: \(titles[0])."
        case 2: return "Two open tasks: \(titles[0]) and \(titles[1])."
        default: return "\(titles.count) open tasks, starting with \(titles[0]) and \(titles[1])."
        }
    }
}

// A reply ready for both ears and shortcuts: all of it as plain words, and a short piece to say aloud.
public struct SiriReply: Equatable, Sendable {
    public static let spokenLimit = 280
    static let restOfReply = "The rest is in your chat with Bob."

    public let full: String
    public let spoken: String

    // Whole sentences up to the limit, as nobody wants a long reply read out by Siri.
    public init(reply: String, spokenLimit: Int = SiriReply.spokenLimit) {
        var splitter = VoiceSentenceSplitter()
        let sentences = splitter.push(reply) + splitter.flush()
        full = sentences.joined(separator: " ")
        var said = ""
        for sentence in sentences {
            let next = said.isEmpty ? sentence : "\(said) \(sentence)"
            if next.count > spokenLimit { break }
            said = next
        }
        if said.isEmpty {
            said = Self.cut(full, to: spokenLimit)
        }
        spoken = said.count < full.count ? "\(said) \(Self.restOfReply)" : said
    }

    private static func cut(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        let head = text.prefix(limit)
        guard let space = head.lastIndex(where: \.isWhitespace) else { return String(head) }
        return String(head[..<space])
    }
}

// One question to Bob, waited out to the end. The same transcript rules as the chat screen decide what the reply was.
public enum SiriAsk {
    // Siri gives up on a slow intent, so this answers first.
    public static let defaultTimeout: Duration = .seconds(25)

    public static func answer(question: String, events: AsyncThrowingStream<ChatStreamEvent, Error>, timeout: Duration = SiriAsk.defaultTimeout) async throws -> SiriReply {
        try await withThrowingTaskGroup(of: SiriReply.self) { group in
            group.addTask { try await read(question: question, events: events) }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw SiriFailure.stillThinking
            }
            defer { group.cancelAll() }
            guard let reply = try await group.next() else { throw SiriFailure.nothingToSay }
            return reply
        }
    }

    private static func read(question: String, events: AsyncThrowingStream<ChatStreamEvent, Error>) async throws -> SiriReply {
        var transcript = ChatTranscript()
        transcript.beginTurn(userMessageID: "question", replyMessageID: "reply", text: question)
        for try await event in events {
            transcript.apply(event)
        }
        try Task.checkCancellation()
        transcript.apply(.done)
        guard let reply = transcript.messages.last, reply.role == .bob else { throw SiriFailure.nothingGiven }
        switch reply.state {
        case .failed(let error): throw error
        case .stopped: throw ApiError.upstream
        case .complete, .streaming: break
        }
        let answer = SiriReply(reply: reply.text)
        guard !answer.full.isEmpty else { throw SiriFailure.nothingToSay }
        return answer
    }
}

// Turns what was said into what the server accepts, whose limits count UTF-16 units.
public enum SiriDrafts {
    static let maxTitleLength = 200
    static let maxNoteBodyLength = 20000
    // Long enough to recognise a note in the list.
    static let noteTitleLength = 60

    public static func title(_ text: String) throws -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SiriFailure.nothingGiven }
        return bounded(trimmed, to: maxTitleLength)
    }

    public static func taskDue(_ date: Date?, zone: String) -> TaskDue? {
        date.map { .date(WallClock.day($0, zone: zone)) }
    }

    // A short note is all title. A longer one keeps every word in its body, under a title from its first line.
    public static func note(_ text: String) throws -> (title: String, body: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let firstLine = trimmed.split(whereSeparator: \.isNewline).first else { throw SiriFailure.nothingGiven }
        let line = firstLine.trimmingCharacters(in: .whitespaces)
        if line == trimmed, line.utf16.count <= noteTitleLength {
            return (line, "")
        }
        var title = bounded(line, to: noteTitleLength)
        if title.count < line.count, let space = title.lastIndex(where: \.isWhitespace) {
            title = String(title[..<space])
        }
        return (title, bounded(trimmed, to: maxNoteBodyLength))
    }

    public static func reminder(_ text: String, at date: Date, now: Date) throws -> String {
        guard date > now else { throw SiriFailure.reminderInThePast }
        return try title(text)
    }

    private static func bounded(_ text: String, to limit: Int) -> String {
        var text = text
        while text.utf16.count > limit { text.removeLast() }
        return text
    }
}

public enum SiriTasks {
    // The server's order, which is the one the person sees on Home.
    public static func openTitles(_ tasks: [TaskItem]) -> [String] {
        tasks.filter { $0.status == .open && $0.trashedAt == nil && $0.parentTaskID == nil }.map(\.title)
    }
}

// Today in a few spoken words, and written out in full for a shortcut to use.
public struct TodayBrief: Equatable, Sendable {
    static let spokenEvents = 3

    public let spoken: String
    public let text: String

    private struct Entry {
        let title: String
        let isAllDay: Bool
        let start: Date?
        let end: Date?
    }

    public init(page: AgendaPage, tasks: [String], now: Date, calendar: Calendar = .current, locale: Locale = .current) {
        let entries = Self.entries(page: page, now: now, calendar: calendar)
        let ahead = entries.filter { $0.isAllDay || ($0.end ?? $0.start ?? now) >= now }
        let said = Self.spokenAgenda(all: entries, ahead: ahead, calendar: calendar, locale: locale)
        let incomplete = page.googleNotice == .none ? nil : "I couldn't read all of your Google Calendar."
        if entries.isEmpty, tasks.isEmpty, incomplete == nil {
            spoken = "Nothing planned today and no open tasks. Enjoy the room to breathe."
        } else {
            spoken = [said, incomplete, SiriLines.openTasks(tasks)].compactMap { $0 }.joined(separator: " ")
        }
        var lines = ["Today"]
        lines += entries.isEmpty ? ["Nothing planned."] : entries.map { "\(Self.timeText($0, calendar: calendar, locale: locale)): \($0.title)" }
        if let incomplete { lines.append(incomplete) }
        lines += ["", "Open tasks"]
        lines += tasks.isEmpty ? ["None."] : tasks
        text = lines.joined(separator: "\n")
    }

    private static func spokenAgenda(all: [Entry], ahead: [Entry], calendar: Calendar, locale: Locale) -> String {
        if all.isEmpty { return "Nothing on your calendar today." }
        if ahead.isEmpty { return "That's everything on your calendar for today." }
        var parts = ahead.prefix(spokenEvents).map { entry -> String in
            entry.isAllDay ? "\(entry.title), all day" : "\(entry.title) at \(timeText(entry, calendar: calendar, locale: locale))"
        }
        if ahead.count > spokenEvents { parts.append("\(ahead.count - spokenEvents) more") }
        let list = parts.count > 1 ? parts.dropLast().joined(separator: ", ") + " and \(parts[parts.count - 1])" : parts[0]
        return "Today you have \(list)."
    }

    private static func timeText(_ entry: Entry, calendar: Calendar, locale: Locale) -> String {
        if entry.isAllDay { return "All day" }
        return entry.start.map { TodayDateText.time($0, calendar: calendar, locale: locale) } ?? ""
    }

    // The person's own events and Google's, anything touching today, all-day first and then by time. An event that began yesterday still counts.
    private static func entries(page: AgendaPage, now: Date, calendar: Calendar) -> [Entry] {
        let dayStart = calendar.startOfDay(for: now)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        let today = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        func touchesToday(_ start: Date?, _ end: Date?) -> Bool {
            guard let start, start < dayEnd else { return false }
            guard let end, end > start else { return start >= dayStart }
            return end > dayStart
        }
        let own = page.items.filter { !$0.isCancelled && touchesToday($0.startAt, $0.endAt) }
            .map { Entry(title: named($0.title), isAllDay: $0.isAllDay, start: $0.startAt, end: $0.endAt) }
        let google = page.googleItems.filter { item in
            guard let first = item.startDate else { return touchesToday(item.startAt, item.endAt) }
            return first <= today && (item.endDate.map { today < $0 } ?? (first == today))
        }.map { Entry(title: named($0.title), isAllDay: $0.isAllDay, start: $0.startAt, end: $0.endAt) }
        return (own + google).sorted { lhs, rhs in
            if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
            return (lhs.start ?? dayStart) < (rhs.start ?? dayStart)
        }
    }

    private static func named(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "An event" : trimmed
    }
}
