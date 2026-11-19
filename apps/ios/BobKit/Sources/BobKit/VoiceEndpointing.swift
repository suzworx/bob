import Foundation

// The web's conversation-mode timings (apps/ui-v2 features/voice/mode/config.ts), in the same words.
public struct VoiceTimings: Equatable, Sendable {
    // Sustained sound below this is a false trigger, not a turn.
    public var minSpeechMs = 250
    // Sustained silence at or past this closes the open utterance.
    public var silenceMs = 900
    // An open utterance past this is closed and answered, not accumulated.
    public var maxUtteranceMs = 30_000
    // Minutes of no speech before the mic is let go.
    public var idleTimeoutMs = 300_000

    public init() {}
}

// What a stretch of audio means for the turn.
public enum VoiceEndpoint: Equatable, Sendable {
    case none
    case speechStarted
    case speechEnded(durationMs: Int)
}

// Decides where speech starts and stops from each frame's loudness. The web runs the Silero model here; with no third-party code in the app this follows a floor that learns the room, so a steady fan or hum is not speech.
public struct VoiceEndpointer: Sendable {
    // The same 512 samples at 16 kHz the web's model works in.
    public static let frameSamples = 512
    public static let frameMs = 32

    // The quietest a voice is taken to be, and how far above the room it must rise.
    private static let minimumLevel: Float = 0.012
    private static let aboveFloor: Float = 3
    // Speech dips between syllables, so a voice already going needs less to stay on: the web's 0.25 to 0.3.
    private static let keepGoing: Float = 0.8
    // The dips allowed before a sound that hasn't yet counted as speech is dropped.
    private static let candidateGapFrames = 2
    private static let floorRise: Float = 0.05
    private static let floorFall: Float = 0.3

    private let minSpeechFrames: Int
    private let silenceFrames: Int
    private let maxFrames: Int

    private var floor: Float = 0.002
    private var candidateFrames = 0
    private var candidateGap = 0
    private var speaking = false
    private var speechFrames = 0
    private var quietFrames = 0

    public init(timings: VoiceTimings = VoiceTimings()) {
        func frames(_ ms: Int) -> Int { Int((Double(ms) / Double(Self.frameMs)).rounded(.up)) }
        minSpeechFrames = frames(timings.minSpeechMs)
        silenceFrames = frames(timings.silenceMs)
        maxFrames = frames(timings.maxUtteranceMs)
    }

    private var startLevel: Float { max(Self.minimumLevel, floor * Self.aboveFloor) }

    // `level` is the frame's RMS, from 0 to 1.
    public mutating func process(level: Float) -> VoiceEndpoint {
        if speaking {
            return continueSpeech(level: level)
        }
        if level >= startLevel || (candidateFrames > 0 && level >= startLevel * Self.keepGoing) {
            candidateFrames += 1
            candidateGap = 0
            if candidateFrames >= minSpeechFrames {
                speaking = true
                speechFrames = candidateFrames
                quietFrames = 0
                candidateFrames = 0
                return .speechStarted
            }
            return .none
        }
        if candidateFrames > 0 {
            candidateGap += 1
            guard candidateGap > Self.candidateGapFrames else {
                candidateFrames += 1
                return .none
            }
            candidateFrames = 0
            candidateGap = 0
        }
        floor += (level - floor) * (level > floor ? Self.floorRise : Self.floorFall)
        return .none
    }

    private mutating func continueSpeech(level: Float) -> VoiceEndpoint {
        speechFrames += 1
        quietFrames = level >= startLevel * Self.keepGoing ? 0 : quietFrames + 1
        guard quietFrames >= silenceFrames || speechFrames >= maxFrames else {
            return .none
        }
        speaking = false
        let duration = speechFrames * Self.frameMs
        speechFrames = 0
        quietFrames = 0
        return .speechEnded(durationMs: duration)
    }
}

// What the microphone's samples came to.
public enum VoiceCaptureEvent: Equatable, Sendable {
    case speechStarted
    // A finished utterance as WAV bytes, ready to send. Held in memory only.
    case utterance(wav: Data, durationMs: Int)
}

// Cuts the microphone's samples into frames, keeps the moment before speech so the first word isn't clipped, and hands back one utterance at a time.
public struct VoiceUtteranceCapture: Sendable {
    // Long enough to hold the frames that decide speech has started, plus a third of a second before them.
    private static let prerollFrames = 10

    private var endpointer: VoiceEndpointer
    private let keptFrames: Int
    private var pending: [Int16] = []
    private var recent: [[Int16]] = []
    private var utterance: [Int16]?
    // The latest frame's loudness, from 0 to 1, for Bob to move to.
    public private(set) var level: Float = 0

    public init(timings: VoiceTimings = VoiceTimings()) {
        endpointer = VoiceEndpointer(timings: timings)
        keptFrames = Self.prerollFrames + Int((Double(timings.minSpeechMs) / Double(VoiceEndpointer.frameMs)).rounded(.up))
    }

    public mutating func append(_ samples: [Int16]) -> [VoiceCaptureEvent] {
        pending.append(contentsOf: samples)
        var events: [VoiceCaptureEvent] = []
        var start = 0
        while pending.count - start >= VoiceEndpointer.frameSamples {
            let frame = Array(pending[start..<(start + VoiceEndpointer.frameSamples)])
            start += VoiceEndpointer.frameSamples
            if let event = process(frame) {
                events.append(event)
            }
        }
        pending.removeFirst(start)
        return events
    }

    // The utterance so far, for a person who has said they're done before the silence would say so.
    public mutating func finishNow() -> Data? {
        guard let samples = utterance else {
            return nil
        }
        utterance = nil
        return VoiceWAV.encode(samples: samples)
    }

    private mutating func process(_ frame: [Int16]) -> VoiceCaptureEvent? {
        level = Self.rms(frame)
        let decision = endpointer.process(level: level)
        if utterance != nil {
            utterance?.append(contentsOf: frame)
        } else {
            recent.append(frame)
            if recent.count > keptFrames {
                recent.removeFirst()
            }
        }
        switch decision {
        case .none:
            return nil
        case .speechStarted:
            utterance = recent.flatMap { $0 }
            recent = []
            return .speechStarted
        case .speechEnded(let durationMs):
            guard let wav = finishNow() else {
                return nil
            }
            return .utterance(wav: wav, durationMs: durationMs)
        }
    }

    private static func rms(_ frame: [Int16]) -> Float {
        guard !frame.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in frame {
            let value = Float(sample) / 32768
            sum += value * value
        }
        return (sum / Float(frame.count)).squareRoot()
    }
}
