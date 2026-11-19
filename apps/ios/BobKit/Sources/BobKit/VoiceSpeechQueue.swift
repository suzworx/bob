import Foundation

// Speaks a reply one sentence at a time: at most two made ahead, played in order, a failed one skipped. As the web's queue, except that it stays speaking until the reply has ended, so a slow reply can't reopen the mic between sentences.
@MainActor
public final class VoiceSpeechQueue {
    private static let maxInFlight = 2

    private final class Entry {
        enum State { case pending, making, ready, failed }
        let text: String
        var audio: Data?
        var state = State.pending
        init(text: String) { self.text = text }
    }

    private let synthesize: @MainActor (String) async throws -> Data
    private let play: @MainActor (Data, @escaping @MainActor () -> Void) async throws -> Void
    private let stopPlayback: @MainActor () -> Void

    public var onFirstAudio: @MainActor () -> Void = {}
    public var onSentenceStarted: @MainActor (String) -> Void = { _ in }
    public var onFinished: @MainActor () -> Void = {}
    public var onError: @MainActor (Error) -> Void = { _ in }

    private var entries: [Entry] = []
    private var inFlight = 0
    private var playing = false
    private var startedAudio = false
    private var replyEnded = false
    private var heardCharacters = 0
    // Bumped by stop, so anything still on its way from before lands nowhere.
    private var generation = 0
    private var tasks: [Task<Void, Never>] = []

    public init(synthesize: @escaping @MainActor (String) async throws -> Data, play: @escaping @MainActor (Data, @escaping @MainActor () -> Void) async throws -> Void, stopPlayback: @escaping @MainActor () -> Void) {
        self.synthesize = synthesize
        self.play = play
        self.stopPlayback = stopPlayback
    }

    public func enqueue(_ text: String) {
        entries.append(Entry(text: text))
        pump()
    }

    // No more sentences are coming for this reply.
    public func finishReply() {
        replyEnded = true
        pump()
    }

    // Silences everything and says how many characters were heard in full.
    @discardableResult
    public func stop() -> Int {
        generation += 1
        tasks.forEach { $0.cancel() }
        tasks = []
        stopPlayback()
        let heard = heardCharacters
        reset()
        return heard
    }

    private func reset() {
        entries = []
        inFlight = 0
        playing = false
        startedAudio = false
        replyEnded = false
        heardCharacters = 0
    }

    private func pump() {
        while inFlight < Self.maxInFlight, let next = entries.first(where: { $0.state == .pending }) {
            make(next)
        }
        guard !playing else {
            return
        }
        while entries.first?.state == .failed {
            entries.removeFirst()
        }
        if let head = entries.first, head.state == .ready, let audio = head.audio {
            speak(head, audio: audio)
        } else if replyEnded, inFlight == 0, entries.isEmpty {
            reset()
            onFinished()
        }
    }

    private func make(_ entry: Entry) {
        entry.state = .making
        inFlight += 1
        let current = generation
        tasks.append(Task {
            do {
                let audio = try await synthesize(entry.text)
                guard current == generation else { return }
                inFlight -= 1
                entry.audio = audio
                entry.state = .ready
            } catch {
                guard current == generation else { return }
                inFlight -= 1
                entry.state = .failed
                onError(error)
                guard current == generation else { return }
            }
            pump()
        })
    }

    private func speak(_ entry: Entry, audio: Data) {
        playing = true
        let current = generation
        tasks.append(Task {
            do {
                guard current == generation, !Task.isCancelled else { return }
                var announced = false
                try await play(audio) { [weak self] in
                    guard let self, current == self.generation, !announced else { return }
                    announced = true
                    if !self.startedAudio {
                        self.startedAudio = true
                        self.onFirstAudio()
                    }
                    guard current == self.generation else { return }
                    self.onSentenceStarted(entry.text)
                }
                guard current == generation else { return }
                heardCharacters += entry.text.count
            } catch {
                guard current == generation else { return }
                onError(error)
                guard current == generation else { return }
            }
            entries.removeAll { $0 === entry }
            playing = false
            pump()
        })
    }
}
