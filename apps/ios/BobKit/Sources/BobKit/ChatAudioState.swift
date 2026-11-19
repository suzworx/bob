import Foundation

// All native speech surfaces share one audio session. Only its owner may release it.
@MainActor public final class AudioSessionLease {
    public static let shared = AudioSessionLease()
    private var owner: UUID?
    public init() {}
    public func acquire(owner: UUID) -> Bool {
        guard self.owner == nil || self.owner == owner else { return false }
        self.owner = owner
        return true
    }
    public func isOwned(by owner: UUID) -> Bool { self.owner == owner }
    public func release(owner: UUID) {
        if self.owner == owner { self.owner = nil }
    }
}

// A recording belongs to one composer context, not to whatever chat is open later.
public struct ChatDictationState: Sendable {
    public enum Phase: Equatable, Sendable { case idle, requesting, recording, transcribing }
    public static let maximumSamples = 60 * VoiceWAV.sampleRate
    public private(set) var phase: Phase = .idle
    public private(set) var token: UUID?
    private var context = ""
    private var samples: [Int16] = []
    public var sampleCount: Int { samples.count }
    public init() {}

    public mutating func begin(context: String) -> UUID {
        cancel()
        let token = UUID()
        self.token = token
        self.context = context
        phase = .requesting
        return token
    }
    public mutating func record(token: UUID) -> Bool {
        guard self.token == token, phase == .requesting else { return false }
        phase = .recording
        return true
    }
    public mutating func append(_ incoming: [Int16]) -> Bool {
        guard phase == .recording else { return false }
        samples.append(contentsOf: incoming.prefix(Self.maximumSamples - samples.count))
        return samples.count == Self.maximumSamples
    }
    public mutating func finish(token: UUID) -> Data? {
        guard self.token == token, phase == .recording else { return nil }
        phase = .transcribing
        let wav = samples.isEmpty ? nil : VoiceWAV.encode(samples: samples)
        samples = []
        return wav
    }
    public mutating func complete(token: UUID, context: String, draft: String, text: String) -> String? {
        guard self.token == token, self.context == context, phase == .transcribing else { return nil }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        cancel()
        guard !words.isEmpty else { return nil }
        return draft + (draft.isEmpty || draft.last?.isWhitespace == true ? "" : " ") + words
    }
    public mutating func cancel() {
        token = nil
        context = ""
        samples = []
        phase = .idle
    }
}

public struct SpeechReplayText: Equatable, Sendable {
    public let text: String
    public let isTruncated: Bool
    public init(_ raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var count = 0
        var bounded = ""
        for character in trimmed {
            let length = String(character).utf16.count
            guard count + length <= 700 else { break }
            bounded.append(character)
            count += length
        }
        text = bounded
        isTruncated = bounded != trimmed
    }
}

// Uses Swift's monotonic clock, independently of whether the microphone delivers samples.
@MainActor public final class AudioRecordingDeadline {
    private let wait: @MainActor () async throws -> Void
    private var activeToken: UUID?
    private var task: Task<Void, Never>?

    public init(wait: @escaping @MainActor () async throws -> Void = { try await Task.sleep(for: .seconds(60)) }) {
        self.wait = wait
    }

    @discardableResult public func start(token: UUID, onExpired: @escaping @MainActor (UUID) -> Void) -> Task<Void, Never> {
        cancel()
        activeToken = token
        let task = Task { [weak self, wait] in
            do { try await wait() } catch { return }
            guard let self, !Task.isCancelled, self.activeToken == token else { return }
            self.activeToken = nil
            onExpired(token)
        }
        self.task = task
        return task
    }

    public func cancel() {
        activeToken = nil
        task?.cancel()
        task = nil
    }
}

public enum AudioScenePolicy {
    // A first-use permission alert can briefly make the scene inactive. Background always tears down.
    public static func shouldCancel(background: Bool, permissionPending: Bool) -> Bool {
        background || !permissionPending
    }
}
