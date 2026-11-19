@preconcurrency import AVFoundation
import BobKit
import Foundation

enum VoiceAudioError: Error {
    case noMicrophone
    case unplayable
}

// Hands over 16 kHz mono samples on the main thread, between start and stop. Nothing is written to disk.
protocol VoiceCapturing: AnyObject {
    func start(onSamples: @escaping ([Int16]) -> Void, onRestartNeeded: @escaping () -> Void) throws
    func stop()
}

// Plays one sentence and returns when it ends or is stopped.
protocol VoicePlaying: AnyObject {
    func play(_ audio: Data, onStarted: @escaping @MainActor () -> Void) async throws
    func stop()
}

// The audio session for a conversation: the phone's echo cancelling voice path, loud on the speaker, and whatever headset is connected.
enum VoiceAudioSession {
    static func activate() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
    }

    // Other apps' audio gets to come back.
    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// Calls, Siri, an unplugged headset: anything that takes the audio away while Bob is using it.
final class VoiceAudioEvents {
    private var observers: [NSObjectProtocol] = []

    func start(onLost: @escaping () -> Void) {
        stop()
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
                MainActor.assumeIsolated { onLost() }
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { note in
                let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                guard raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
                MainActor.assumeIsolated { onLost() }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { _ in
                MainActor.assumeIsolated { onLost() }
            },
        ]
    }

    func stop() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }
}

// Runs on the audio thread: converts whatever the hardware gives to the server's format.
private nonisolated final class VoiceResampler: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let output: AVAudioFormat

    init?(from input: AVAudioFormat) {
        guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceWAV.sampleRate), channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: input, to: output) else {
            return nil
        }
        converter.downmix = true
        self.converter = converter
        self.output = output
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> [Int16] {
        let ratio = output.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else {
            return []
        }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: converted, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, let samples = converted.int16ChannelData?[0] else {
            return []
        }
        return Array(UnsafeBufferPointer(start: samples, count: Int(converted.frameLength)))
    }

    // Formed outside the main actor because the tap runs on the audio thread.
    static func tap(_ resampler: VoiceResampler, deliver: @escaping @Sendable ([Int16]) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            let samples = resampler.convert(buffer)
            guard !samples.isEmpty else { return }
            DispatchQueue.main.async { deliver(samples) }
        }
    }
}

// The real microphone. A new engine each time, so nothing outlives a mic that was closed.
final class MicCapture: VoiceCapturing {
    private var engine: AVAudioEngine?
    private var configObserver: NSObjectProtocol?

    func start(onSamples: @escaping ([Int16]) -> Void, onRestartNeeded: @escaping () -> Void) throws {
        stop()
        guard AVAudioSession.sharedInstance().isInputAvailable else {
            throw VoiceAudioError.noMicrophone
        }
        let engine = AVAudioEngine()
        // Asking a simulator's audio service for its input can time out, and that abort cannot be caught.
        #if targetEnvironment(simulator)
        throw VoiceAudioError.noMicrophone
        #else
        let input = engine.inputNode
        // The web asks for the browser's echo cancelling too. Better without it than no conversation at all.
        try? input.setVoiceProcessingEnabled(true)
        let format = input.outputFormat(forBus: 0)
        // A simulator with no microphone reports an empty format, and installing a tap on that raises an exception.
        guard format.sampleRate > 0, format.channelCount > 0, let resampler = VoiceResampler(from: format) else {
            throw VoiceAudioError.noMicrophone
        }
        nonisolated(unsafe) let deliver = onSamples
        let tap = VoiceResampler.tap(resampler) { samples in
            MainActor.assumeIsolated { deliver(samples) }
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format, block: tap)
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        self.engine = engine
        // A new route stops the engine and can change its format, so it has to be built again.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak engine] _ in
            // Turning on voice processing can post this too, with the engine still running: only a stopped engine needs rebuilding.
            guard engine?.isRunning == false else { return }
            MainActor.assumeIsolated { onRestartNeeded() }
        }
        #endif
    }

    func stop() {
        if let configObserver {
            NotificationCenter.default.removeObserver(configObserver)
        }
        configObserver = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }
}

// Bob's voice, played from memory.
final class SpeechPlayer: NSObject, VoicePlaying, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var finished: CheckedContinuation<Void, Error>?
    private var pacing: Task<Void, Never>?
    private var lastDuration: TimeInterval = 0
    private var lastPosition: TimeInterval = 0
    private var simulationStartedAt: Date?
    var duration: TimeInterval { player?.duration ?? lastDuration }
    var currentTime: TimeInterval {
        #if targetEnvironment(simulator)
        return min(duration, lastPosition + (simulationStartedAt.map { Date().timeIntervalSince($0) } ?? 0))
        #else
        return player?.currentTime ?? lastPosition
        #endif
    }
    private static let audioQueue = DispatchQueue(label: "xyz.heybob.ios.speech")

    func play(_ audio: Data, onStarted: @escaping @MainActor () -> Void) async throws {
        stop()
        let player: AVAudioPlayer
        do {
            player = try AVAudioPlayer(data: audio)
        } catch {
            throw VoiceAudioError.unplayable
        }
        player.delegate = self
        self.player = player
        lastDuration = player.duration
        lastPosition = 0
        try await withCheckedThrowingContinuation { continuation in
            finished = continuation
            #if targetEnvironment(simulator)
            // A simulator's audio service can stall for good, so its reply only keeps time.
            onStarted()
            resumeSimulation()
            #else
            // The audio system can block for as long as it likes. Off the main thread, Stop and Close always answer.
            nonisolated(unsafe) let unsafePlayer = player
            Self.audioQueue.async { [weak self] in
                let started = unsafePlayer.play()
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard self?.player === unsafePlayer else { return }
                        if started { onStarted() }
                        else { self?.settle(throwing: VoiceAudioError.unplayable) }
                    }
                }
            }
            #endif
        }
    }

    func pause() {
        guard let player else { return }
        #if targetEnvironment(simulator)
        lastPosition = currentTime
        simulationStartedAt = nil
        pacing?.cancel()
        pacing = nil
        #else
        nonisolated(unsafe) let unsafePlayer = player
        Self.audioQueue.async { unsafePlayer.pause() }
        #endif
    }

    func resume(onStarted: @escaping @MainActor () -> Void) {
        guard let player else { return }
        #if targetEnvironment(simulator)
        resumeSimulation()
        onStarted()
        #else
        nonisolated(unsafe) let unsafePlayer = player
        Self.audioQueue.async { [weak self] in
            let started = unsafePlayer.play()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard self?.player === unsafePlayer else { return }
                    if started { onStarted() }
                    else { self?.settle(throwing: VoiceAudioError.unplayable) }
                }
            }
        }
        #endif
    }

    private func resumeSimulation() {
        let remaining = max(0, duration - lastPosition)
        simulationStartedAt = Date()
        pacing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(remaining))
            if !Task.isCancelled { self?.settle(throwing: nil) }
        }
    }

    func stop() {
        pacing?.cancel()
        pacing = nil
        if let player {
            nonisolated(unsafe) let unsafePlayer = player
            Self.audioQueue.async { unsafePlayer.stop() }
        }
        settle(throwing: nil, completed: false)
    }

    private func settle(throwing error: Error?, completed: Bool = true) {
        lastPosition = completed && error == nil ? duration : currentTime
        simulationStartedAt = nil
        pacing?.cancel()
        pacing = nil
        player = nil
        let continuation = finished
        finished = nil
        if let error {
            continuation?.resume(throwing: error)
        } else {
            continuation?.resume()
        }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        nonisolated(unsafe) let completedPlayer = player
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard self.player === completedPlayer else { return }
                self.settle(throwing: flag ? nil : VoiceAudioError.unplayable)
            }
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        nonisolated(unsafe) let completedPlayer = player
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                guard self.player === completedPlayer else { return }
                self.settle(throwing: VoiceAudioError.unplayable)
            }
        }
    }
}
