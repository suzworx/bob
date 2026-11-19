import AVFoundation
import BobKit
import Foundation
import Observation

// What the chat's reply looks like right now, for the voice screen to follow.
struct VoiceReplySnapshot: Equatable {
    let text: String
    let isStreaming: Bool
    let failure: String?
}

// Runs one voice conversation: the mic, the server and Bob's voice around the states in BobKit. No audio or words are logged or kept beyond the turn.
@MainActor @Observable final class VoiceModel {
    private static let notHeard = "I didn't catch that. Try again?"
    private static let shortened = "Bob read out a shorter version of that reply."
    private static let noMicrophone = "Bob can't find a microphone. You can still type to him."
    private static let audioGone = "The sound went away, so Bob stopped."

    private(set) var state = VoiceState.off
    private(set) var permissionDenied = false
    private(set) var isMuted = false
    var isMicLive: Bool { VoiceMicrophonePolicy.isMicLive(state, muted: isMuted) }
    // Captions stay until the next utterance begins; nothing is logged.
    private(set) var heard: String?
    private(set) var spoken: String?
    // One plain sentence about what just happened.
    private(set) var notice: String?

    @ObservationIgnored private let audioOwner = UUID()
    @ObservationIgnored private var beginGeneration = 0
    @ObservationIgnored private var requestingPermission = false
    @ObservationIgnored private let chat: ChatViewModel
    @ObservationIgnored private let service: VoiceServing
    @ObservationIgnored private let capture: VoiceCapturing
    @ObservationIgnored private let player: VoicePlaying
    @ObservationIgnored private let events = VoiceAudioEvents()
    @ObservationIgnored private let timings = VoiceTimings()
    @ObservationIgnored private lazy var queue = makeQueue()
    @ObservationIgnored private var utteranceCapture = VoiceUtteranceCapture()
    @ObservationIgnored private var utterance: Data?
    @ObservationIgnored private var workflowID = ""
    @ObservationIgnored private var feed: VoiceReplyFeed?
    @ObservationIgnored private var splitter = VoiceSentenceSplitter()
    @ObservationIgnored private var heardCharacters = 0
    @ObservationIgnored private var transcribing: Task<Void, Never>?
    @ObservationIgnored private var idleTimer: Task<Void, Never>?
    // Read inside Bob's own timeline, so every audio frame doesn't redraw the whole screen.
    @ObservationIgnored private(set) var level: Float = 0

    init(chat: ChatViewModel, dependencies: VoiceDependencies) {
        self.chat = chat
        service = dependencies.service
        capture = dependencies.capture
        player = dependencies.player
    }

    private func makeQueue() -> VoiceSpeechQueue {
        let queue = VoiceSpeechQueue(
            synthesize: { [weak self] text in
                guard let self else { throw CancellationError() }
                let spoken = try await self.service.speak(text: text, workflowID: self.workflowID)
                if spoken.isTruncated { self.notice = Self.shortened }
                return spoken.data
            },
            play: { [weak self] audio, started in try await self?.player.play(audio, onStarted: started) },
            stopPlayback: { [weak self] in self?.player.stop() }
        )
        queue.onFirstAudio = { [weak self] in self?.send(.firstAudio) }
        queue.onSentenceStarted = { [weak self] in self?.spoken = $0 }
        queue.onFinished = { [weak self] in self?.send(.replyDone) }
        // A spent budget is said plainly; any other sentence that fails is skipped quietly, as on the web.
        queue.onError = { [weak self] error in
            guard error as? ApiError == .outOfCredit else { return }
            self?.notice = ApiErrorMapper.userMessage(.outOfCredit)
            self?.send(.turnFailed)
        }
        return queue
    }

    // The first use asks for the microphone; the system shows the reason from the app's settings.
    func begin() async {
        guard state == .off else { return }
        guard AudioSessionLease.shared.acquire(owner: audioOwner) else {
            notice = "Finish dictating or stop playback before starting a voice conversation."
            return
        }
        beginGeneration += 1
        let request = beginGeneration
        requestingPermission = true
        let granted = await AVAudioApplication.requestRecordPermission()
        // The person may have closed the screen while the question was up.
        guard !Task.isCancelled, request == beginGeneration else {
            if request == beginGeneration {
                requestingPermission = false
                AudioSessionLease.shared.release(owner: audioOwner)
            }
            return
        }
        requestingPermission = false
        permissionDenied = !granted
        guard granted else { AudioSessionLease.shared.release(owner: audioOwner); return }
        events.start { [weak self] in
            guard let self else { return }
            if self.state == .speaking || self.isMicLive { self.notice = Self.audioGone }
            self.send(.hidden)
        }
        send(.start)
    }

    func tapBob() {
        if state == .hearing {
            utterance = utteranceCapture.finishNow()
        }
        notice = nil
        send(.tapBob)
    }

    func togglePause() {
        notice = nil
        send(state == .paused ? .resume : .pause)
    }

    func toggleMute() {
        guard state != .off else { return }
        notice = nil
        isMuted.toggle()
        if isMuted {
            utterance = nil
            utteranceCapture = VoiceUtteranceCapture(timings: timings)
        }
        let result = VoiceMicrophonePolicy.settingMuted(isMuted, state: state)
        state = result.state
        result.effects.forEach(run)
    }

    func interrupt() {
        notice = nil
        send(.interrupt)
    }

    // Leaving the screen ends the conversation. A reply on its way finishes in the chat, in silence.
    func close() {
        requestingPermission = false
        beginGeneration += 1
        send(.stop)
        events.stop()
    }

    func sceneLeft(background: Bool = true) {
        guard AudioScenePolicy.shouldCancel(background: background, permissionPending: requestingPermission) else { return }
        requestingPermission = false
        beginGeneration += 1
        send(.hidden)
    }

    func replyChanged(_ reply: VoiceReplySnapshot) {
        guard var current = feed else { return }
        let update = current.update(text: reply.text, isStreaming: reply.isStreaming)
        feed = update.ended ? nil : current
        splitter.push(update.chunk).forEach(queue.enqueue)
        guard update.ended else { return }
        if let failure = reply.failure {
            notice = failure
            send(.turnFailed)
            return
        }
        splitter.flush().forEach(queue.enqueue)
        queue.finishReply()
    }

    private func send(_ event: VoiceEvent) {
        let result = VoiceMicrophonePolicy.transition(state, event, muted: isMuted)
        state = result.state
        result.effects.forEach(run)
        if state == .off, AudioSessionLease.shared.isOwned(by: audioOwner) {
            VoiceAudioSession.deactivate()
            AudioSessionLease.shared.release(owner: audioOwner)
        }
    }

    private func run(_ effect: VoiceEffect) {
        switch effect {
        case .openMic: openMic()
        case .closeMic: closeMic()
        case .startIdleTimer: startIdleTimer()
        case .clearIdleTimer: clearIdleTimer()
        case .submitUtterance: submit()
        case .stopSpeech: heardCharacters = queue.stop()
        case .abandonTurn: abandonTurn()
        case .cancelTurn:
            abandonTurn()
            chat.stop()
        case .recordHeard:
            chat.noteHeard(characters: heardCharacters)
            heardCharacters = 0
        }
    }

    private func openMic() {
        guard isMicLive else { return }
        utteranceCapture = VoiceUtteranceCapture(timings: timings)
        do {
            try VoiceAudioSession.activate()
            try capture.start(onSamples: { [weak self] in self?.ingest($0) }, onRestartNeeded: { [weak self] in self?.restartMic() })
        } catch {
            notice = Self.noMicrophone
            send(.micFailed)
        }
    }

    private func closeMic() {
        capture.stop()
        level = 0
    }

    // A new route: the words so far are lost, so listening starts again.
    private func restartMic() {
        guard isMicLive else { return }
        state = .listening
        openMic()
    }

    private func ingest(_ samples: [Int16]) {
        guard isMicLive else { return }
        for event in utteranceCapture.append(samples) {
            switch event {
            case .speechStarted:
                heard = nil
                spoken = nil
                notice = nil
                send(.speechStarted)
            case .utterance(let wav, _):
                utterance = wav
                send(.utteranceEnded)
            }
        }
        level = utteranceCapture.level
    }

    private func submit() {
        guard let wav = utterance else {
            send(.heardNothing)
            return
        }
        utterance = nil
        let id = UUID().uuidString
        workflowID = id
        let service = service
        transcribing = Task { [weak self] in
            do {
                let text = try await service.transcribe(wav: wav, workflowID: id)
                guard !Task.isCancelled else { return }
                self?.say(text, workflowID: id)
            } catch {
                guard !Task.isCancelled else { return }
                self?.transcriptionFailed(error)
            }
        }
    }

    private func say(_ text: String, workflowID: String) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard state == .thinking, !words.isEmpty else {
            send(.heardNothing)
            return
        }
        guard chat.sendVoice(words, workflowID: workflowID) else {
            notice = "Bob is busy with another reply. Try again in a moment."
            send(.turnFailed)
            return
        }
        heard = words
        feed = VoiceReplyFeed()
        splitter = VoiceSentenceSplitter()
    }

    private func transcriptionFailed(_ error: Error) {
        let apiError = error as? ApiError ?? .unknown(status: 0)
        if apiError == .noSpeechDetected {
            notice = Self.notHeard
            send(.heardNothing)
        } else {
            notice = ApiErrorMapper.userMessage(apiError)
            send(.turnFailed)
        }
    }

    private func abandonTurn() {
        transcribing?.cancel()
        transcribing = nil
        feed = nil
        // Sentences can already be on their way while the screen still says Thinking.
        queue.stop()
    }

    private func startIdleTimer() {
        clearIdleTimer()
        let timeout = timings.idleTimeoutMs
        idleTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(timeout))
            guard !Task.isCancelled else { return }
            self?.send(.idleTimeout)
        }
    }

    private func clearIdleTimer() {
        idleTimer?.cancel()
        idleTimer = nil
    }
}
