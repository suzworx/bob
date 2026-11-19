import Foundation

// Where a voice conversation is. The mic is on only in `listening` and `hearing`.
public enum VoiceState: Equatable, Sendable {
    case off, listening, hearing, thinking, speaking, paused

    public var isMicLive: Bool { self == .listening || self == .hearing }

    // The web's words for the same states.
    public var label: String {
        switch self {
        case .off: "Off"
        case .listening: "Listening"
        case .hearing: "Hearing you"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .paused: "Paused"
        }
    }
}

public enum VoiceEvent: Equatable, Sendable {
    case start
    case stop
    // Bob remains a shortcut for the labeled controls.
    case tapBob
    case pause, resume, interrupt
    case speechStarted
    case utteranceEnded
    // The server found no words in what it was sent.
    case heardNothing
    case turnFailed
    case firstAudio
    // Nothing is left to say: the reply was spoken, or it had nothing to speak.
    case replyDone
    // The screen went away, a call came in or the headphones came out.
    case hidden
    case idleTimeout
    case micFailed
}

public enum VoiceEffect: Equatable, Sendable {
    case openMic, closeMic
    case startIdleTimer, clearIdleTimer
    case submitUtterance
    case stopSpeech
    // Stops saying the reply out loud; the reply itself finishes in the chat.
    case abandonTurn
    // Stops the reply as well.
    case cancelTurn
    // Tells the server how much of the reply the person heard.
    case recordHeard
}

// The web's conversation-mode transitions, pure, with one difference it needs: failures have a way out, so the screen never sits on Thinking forever.
public enum VoiceConversation {
    public static func transition(_ state: VoiceState, _ event: VoiceEvent) -> (state: VoiceState, effects: [VoiceEffect]) {
        let listen: [VoiceEffect] = [.openMic, .startIdleTimer]
        switch (state, event) {
        case (.off, .start):
            return (.listening, listen)
        case (.off, _), (_, .start):
            return (state, [])

        case (_, .stop):
            return (.off, teardown(state) + [.clearIdleTimer])

        case (.listening, .pause), (.hearing, .pause), (.thinking, .pause):
            return (.paused, teardown(state) + [.clearIdleTimer])
        case (.speaking, .pause):
            return (.paused, teardown(state) + [.recordHeard, .clearIdleTimer])
        case (.paused, .resume):
            return (.listening, listen)

        case (.listening, .tapBob):
            return (.paused, [.closeMic, .clearIdleTimer])
        case (.hearing, .tapBob), (.hearing, .utteranceEnded):
            return (.thinking, [.closeMic, .submitUtterance, .clearIdleTimer])
        case (.thinking, .tapBob), (.thinking, .interrupt):
            return (.listening, [.cancelTurn] + listen)
        case (.speaking, .tapBob), (.speaking, .interrupt):
            return (.listening, [.stopSpeech, .cancelTurn, .recordHeard] + listen)
        case (.paused, .tapBob):
            return (.listening, listen)

        case (.listening, .speechStarted):
            return (.hearing, [])

        case (.thinking, .heardNothing):
            return (.listening, listen)
        case (.thinking, .turnFailed), (.speaking, .turnFailed):
            return (.paused, teardown(state) + [.clearIdleTimer])

        case (.thinking, .firstAudio):
            return (.speaking, [])
        case (.thinking, .replyDone), (.speaking, .replyDone):
            return (.listening, listen)

        case (.listening, .hidden), (.hearing, .hidden), (.thinking, .hidden), (.speaking, .hidden),
             (.listening, .micFailed), (.hearing, .micFailed):
            return (.paused, teardown(state) + [.clearIdleTimer])

        case (.listening, .idleTimeout):
            return (.off, [.closeMic, .clearIdleTimer])

        default:
            return (state, [])
        }
    }

    private static func teardown(_ state: VoiceState) -> [VoiceEffect] {
        switch state {
        case .listening, .hearing: [.closeMic]
        case .thinking: [.abandonTurn]
        case .speaking: [.stopSpeech, .abandonTurn]
        case .off, .paused: []
        }
    }
}

// What is new in a streaming reply since the last look, so each word is spoken once.
public struct VoiceReplyFeed: Equatable, Sendable {
    private var fed = 0
    private var ended = false

    public init() {}

    public mutating func update(text: String, isStreaming: Bool) -> (chunk: String, ended: Bool) {
        guard !ended else {
            return ("", false)
        }
        let chunk = String(text.dropFirst(fed))
        fed = max(fed, text.count)
        ended = !isStreaming
        return (chunk, ended)
    }
}

// Cuts a streaming reply into sentences to speak, without its markdown. The web's splitter, with the same 700-character bound the server speaks per request.
public struct VoiceSentenceSplitter: Sendable {
    private static let abbreviations: Set<String> = ["Mr", "Mrs", "Ms", "Dr", "St", "vs", "etc", "e.g", "i.e"]

    private let maxCharacters: Int
    private var buffer: [Character] = []

    public init(maxCharacters: Int = 700) {
        self.maxCharacters = maxCharacters
    }

    public mutating func push(_ chunk: String) -> [String] {
        buffer.append(contentsOf: chunk)
        var out: [String] = []
        var from = 0
        while from < buffer.count, let boundary = Self.boundary(in: buffer, from: from) {
            Self.emit(buffer[from..<boundary], into: &out)
            from = boundary
        }
        buffer.removeFirst(from)
        while buffer.count > maxCharacters {
            guard let cut = buffer[...maxCharacters].lastIndex(of: " "), cut > 0 else {
                break
            }
            Self.emit(buffer[..<cut], into: &out)
            buffer.removeFirst(cut + 1)
        }
        return out
    }

    public mutating func flush() -> [String] {
        var out: [String] = []
        Self.emit(buffer[...], into: &out)
        buffer = []
        return out
    }

    private static func boundary(in text: [Character], from: Int) -> Int? {
        var index = from
        while index < text.count {
            let character = text[index]
            let next = index + 1 < text.count ? text[index + 1] : nil
            if character == ".", index > 0, text[index - 1].isNumber, next?.isNumber == true {
                index += 1
                continue
            }
            if character == "." || character == "!" || character == "?", next?.isWhitespace == true {
                if !(character == "." && isAbbreviation(before: index, in: text)) {
                    return index + 1
                }
            }
            if character == "\n", next == "\n" {
                return index + 2
            }
            index += 1
        }
        return nil
    }

    private static func isAbbreviation(before position: Int, in text: [Character]) -> Bool {
        let last = text[..<position].split { $0.isWhitespace || $0 == "," || $0 == ";" || $0 == ":" }.last
        return last.map { abbreviations.contains(String($0)) } ?? false
    }

    private static func emit(_ raw: ArraySlice<Character>, into out: inout [String]) {
        let sentence = stripMarkdown(String(raw))
        if !sentence.isEmpty {
            out.append(sentence)
        }
    }

    private static func stripMarkdown(_ sentence: String) -> String {
        sentence
            .replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.replacingOccurrences(of: #"^\s*(#{1,6}\s+|- |\* |\d+\. )"#, with: "", options: .regularExpression) }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
