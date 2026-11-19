import Foundation

// A file on a past message. Inline bytes stay in memory: nothing here touches the disk or the network.
public struct ChatAttachment: Equatable, Sendable {
    public let name: String?
    public let mediaType: String?
    // Only a `data:` address is kept: an image in a reply is never fetched from elsewhere.
    private let dataURL: String?

    public init(name: String?, mediaType: String?, url: String?) {
        self.name = name
        self.mediaType = mediaType
        self.dataURL = url.flatMap { $0.hasPrefix("data:") ? $0 : nil }
    }

    public var isImage: Bool {
        mediaType?.hasPrefix("image/") ?? (name == nil)
    }

    public var displayName: String {
        name ?? (isImage ? "Image" : "File")
    }

    private var base64Body: Substring? {
        guard let dataURL, let comma = dataURL.firstIndex(of: ","), dataURL[..<comma].hasSuffix(";base64") else {
            return nil
        }
        return dataURL[dataURL.index(after: comma)...]
    }

    // By arithmetic on the base64, so the size never means decoding the file.
    public var byteCount: Int? {
        guard let body = base64Body else {
            return nil
        }
        let padding = body.utf8.reversed().prefix(2).filter { $0 == UInt8(ascii: "=") }.count
        return max(0, body.utf8.count / 4 * 3 - padding)
    }

    public var sizeText: String? {
        byteCount.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
    }

    // Name and size for reading out or showing beside a file.
    public var summary: String {
        sizeText.map { "\(displayName), \($0)" } ?? displayName
    }

    public func decodedData() -> Data? {
        base64Body.flatMap { Data(base64Encoded: String($0)) }
    }
}

// What one of Bob's tools did, in plain words: never its raw name, input or output.
public struct ChatToolActivity: Equatable, Sendable, Identifiable {
    public enum Status: Equatable, Sendable {
        case running, done, failed, denied

        init(storedState: String?) {
            switch storedState {
            case "output-available": self = .done
            case "output-error": self = .failed
            case "output-denied": self = .denied
            default: self = .running
            }
        }
    }

    public let id: String
    public let toolName: String
    public internal(set) var status: Status

    public init(id: String, toolName: String, status: Status) {
        self.id = id
        self.toolName = toolName
        self.status = status
    }

    // The web's wording, from TOOL_LABELS in apps/ui-v2/src/features/chat/tool-calls.ts. A tool it doesn't know gets a neutral line.
    private static let labels: [String: (running: String, done: String)] = [
        "create_task": ("Adding a task", "Added a task"),
        "update_task": ("Updating a task", "Updated a task"),
        "complete_task": ("Ticking off a task", "Ticked off a task"),
        "list_tasks": ("Checking your tasks", "Checked your tasks"),
        "create_note": ("Writing a note", "Wrote a note"),
        "append_note": ("Adding to a note", "Added to a note"),
        "read_note": ("Reading a note", "Read a note"),
        "create_event": ("Adding an event", "Added an event"),
        "list_agenda": ("Checking your calendar", "Checked your calendar"),
        "create_reminder": ("Setting a reminder", "Set a reminder"),
        "cancel_reminder": ("Cancelling a reminder", "Cancelled a reminder"),
        "list_reminders": ("Checking your reminders", "Checked your reminders"),
        "set_timer": ("Starting a timer", "Started a timer"),
        "set_alarm": ("Setting an alarm", "Set an alarm"),
        "cancel_timer": ("Stopping a timer", "Stopped a timer"),
        "list_timers": ("Checking your timers", "Checked your timers"),
        "remember": ("Remembering that", "Remembered that"),
        "forget": ("Forgetting that", "Forgot that"),
        "search": ("Looking that up", "Looked that up"),
        "read_inbox": ("Checking your email", "Checked your email"),
        "list_space_members": ("Checking who is in the space", "Checked who is in the space"),
        "list_actions": ("Checking your suggestions", "Checked your suggestions"),
        "complete_action": ("Finishing a suggestion", "Finished a suggestion"),
        "set_volume": ("Changing the volume", "Changed the volume"),
        "set_mode": ("Changing how the device listens", "Changed how the device listens"),
        "currentDateTime": ("Checking the time", "Checked the time")
    ]

    public var label: String {
        let words = Self.labels[toolName] ?? ("Working on it", "Done")
        switch status {
        case .running: return words.running
        case .done: return words.done
        case .failed: return "Couldn't finish that"
        case .denied: return "Not allowed"
        }
    }
}

// One piece of a reply, in the order it happened. Tools side by side fold into one.
public enum ChatReplyPart: Equatable, Sendable {
    case text(String)
    case reasoning(String, isStreaming: Bool)
    case tools([ChatToolActivity])

    // The parts a stored reply shows. Blank text and blank thinking show nothing.
    public static func parts(from stored: [ConversationPart]) -> [ChatReplyPart] {
        var parts: [ChatReplyPart] = []
        for part in stored {
            switch part {
            case .text(let text) where !text.isBlank:
                parts.append(.text(text))
            case .reasoning(let text) where !text.isBlank:
                parts.append(.reasoning(text, isStreaming: false))
            case .tool(let activity):
                parts.addTool(activity)
            default:
                continue
            }
        }
        return parts
    }

    // "Thought for 12 seconds", in the web's words. A reply from history has no start to measure from.
    public static func thoughtLabel(isStreaming: Bool, seconds: Int?) -> String {
        if isStreaming {
            return "Thinking..."
        }
        guard let seconds, seconds >= 2 else {
            return "Thought for a few seconds"
        }
        return "Thought for \(seconds) seconds"
    }
}

extension Array where Element == ChatReplyPart {
    var joinedText: String {
        compactMap { part in
            if case .text(let text) = part { return text }
            return nil
        }.joined(separator: "\n\n")
    }

    // Holds the place of a new passage after earlier words. Words after a tool or thinking land in a new part anyway.
    mutating func startText() {
        if case .text(let text)? = last, !text.isEmpty {
            append(.text(""))
        }
    }

    mutating func dropEmptyText() {
        removeAll { part in
            if case .text(let text) = part { return text.isEmpty }
            return false
        }
    }

    mutating func appendText(_ delta: String) {
        if case .text(let text)? = last {
            self[count - 1] = .text(text + delta)
        } else {
            append(.text(delta))
        }
    }

    mutating func startReasoning() {
        append(.reasoning("", isStreaming: true))
    }

    mutating func appendReasoning(_ delta: String) {
        if case .reasoning(let text, _)? = last {
            self[count - 1] = .reasoning(text + delta, isStreaming: true)
        } else {
            append(.reasoning(delta, isStreaming: true))
        }
    }

    mutating func endReasoning() {
        for index in indices {
            if case .reasoning(let text, true) = self[index] {
                self[index] = .reasoning(text, isStreaming: false)
            }
        }
        removeAll { part in
            if case .reasoning(let text, false) = part { return text.isBlank }
            return false
        }
    }

    mutating func addTool(_ activity: ChatToolActivity) {
        if case .tools(var calls)? = last {
            calls.append(activity)
            self[count - 1] = .tools(calls)
        } else {
            append(.tools([activity]))
        }
    }

    mutating func startTool(id: String, name: String) {
        guard !hasTool(id) else {
            return
        }
        if case .text(let text)? = last, text.isEmpty {
            removeLast()
        }
        addTool(ChatToolActivity(id: id, toolName: name, status: .running))
    }

    mutating func setToolStatus(id: String, _ status: ChatToolActivity.Status) {
        for index in indices {
            guard case .tools(var calls) = self[index], let call = calls.firstIndex(where: { $0.id == id }) else {
                continue
            }
            calls[call].status = status
            self[index] = .tools(calls)
            return
        }
    }

    private func hasTool(_ id: String) -> Bool {
        contains { part in
            if case .tools(let calls) = part { return calls.contains { $0.id == id } }
            return false
        }
    }
}

private extension String {
    var isBlank: Bool {
        allSatisfy(\.isWhitespace)
    }
}

public enum ReplyFeedback {
    // Only the server's real trace id can carry feedback: 32 lowercase hex characters.
    public static func isTraceID(_ value: String) -> Bool {
        value.utf8.count == 32 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

// A message's time as the web shows it: the time alone today, the date too for anything older.
public enum ChatTimeFormat {
    public static func text(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        var style = calendar.isDate(date, inSameDayAs: now)
            ? Date.FormatStyle(date: .omitted, time: .shortened)
            : Date.FormatStyle(date: .abbreviated, time: .shortened)
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        style.locale = locale
        return date.formatted(style)
    }
}
