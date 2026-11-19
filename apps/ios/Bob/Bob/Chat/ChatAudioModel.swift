import AVFoundation
import BobKit
import Foundation
import Observation

// Dictation edits the composer only. Replay reads a bounded reply through the same Core speech route.
@MainActor @Observable final class ChatAudioModel {
    enum ReplayPhase { case idle, preparing, playing, paused }
    private(set) var dictation = ChatDictationState()
    private(set) var replayPhase: ReplayPhase = .idle
    private(set) var replayMessageID: String?
    private(set) var replayShortened = false
    var notice: String?
    @ObservationIgnored private weak var chat: ChatViewModel?
    @ObservationIgnored private let service: VoiceServing
    @ObservationIgnored private let capture: VoiceCapturing
    @ObservationIgnored private let player: SpeechPlayer
    @ObservationIgnored private let events = VoiceAudioEvents()
    @ObservationIgnored private let owner = UUID()
    @ObservationIgnored private var dictationTask: Task<Void, Never>?
    @ObservationIgnored private var replayTask: Task<Void, Never>?
    @ObservationIgnored private var replayGeneration = 0
    @ObservationIgnored private var replayAudio: Data?
    @ObservationIgnored private var replayContext: UUID?
    @ObservationIgnored private let recordingDeadline = AudioRecordingDeadline()

    init(chat: ChatViewModel, service: VoiceServing, capture: VoiceCapturing? = nil, player: SpeechPlayer? = nil) {
        self.chat = chat
        self.service = service
        self.capture = capture ?? MicCapture()
        self.player = player ?? SpeechPlayer()
    }

    var isDictating: Bool { dictation.phase != .idle }
    var canReplay: Bool { replayAudio != nil }
    var replayTime: TimeInterval { player.currentTime }
    var replayDuration: TimeInterval { player.duration }

    func startDictation() {
        guard let chat, !isDictating, chat.openPhase == .ready else { return }
        cancelAll()
        notice = nil
        #if targetEnvironment(simulator)
        notice = "Dictation needs an iPhone microphone. You can still type here."
        return
        #else
        guard acquireAudio() else { return }
        let context = chat.composerContext
        let token = dictation.begin(context: context.uuidString)
        dictationTask = Task { [weak self] in
            let granted = await AVAudioApplication.requestRecordPermission()
            guard let self, !Task.isCancelled, self.dictation.token == token else { return }
            guard self.chat?.composerContext == context else { self.cancelDictation(); return }
            guard granted else {
                self.cancelDictation()
                self.notice = "Allow microphone access in Settings to dictate. Your message is still here."
                return
            }
            guard self.dictation.record(token: token) else { return }
            do {
                try VoiceAudioSession.activate()
                try self.capture.start(onSamples: { [weak self] samples in
                    guard let self, self.dictation.token == token else { return }
                    if self.dictation.append(samples) {
                        self.notice = "That reached one minute. Your words are being added to the message."
                        self.finishDictation()
                    }
                }, onRestartNeeded: { [weak self] in
                    guard let self, self.dictation.token == token else { return }
                    self.cancelDictation()
                    self.notice = "The microphone changed. Your message is safe; try dictating again."
                })
                guard self.dictation.token == token, self.dictation.phase == .recording else { return }
                self.recordingDeadline.start(token: token) { [weak self] expired in
                    guard let self, self.dictation.token == expired, self.dictation.phase == .recording else { return }
                    self.notice = "That reached one minute. Your words are being added to the message."
                    self.finishDictation()
                }
            } catch {
                self.cancelDictation()
                self.notice = "Bob couldn't start the microphone. You can still type your message."
            }
        }
        #endif
    }

    func finishDictation() {
        guard let token = dictation.token, dictation.phase == .recording else { return }
        recordingDeadline.cancel()
        capture.stop()
        releaseAudio()
        guard let wav = dictation.finish(token: token) else {
            cancelDictation()
            notice = "I didn't catch that. Try dictating again."
            return
        }
        dictationTask = Task { [weak self, service] in
            do {
                let text = try await service.transcribe(wav: wav, workflowID: token.uuidString)
                guard let self, !Task.isCancelled, let chat = self.chat else { return }
                if let draft = self.dictation.complete(token: token, context: chat.composerContext.uuidString, draft: chat.draft, text: text) {
                    chat.draft = draft
                } else if self.dictation.token == token {
                    self.dictation.cancel()
                }
            } catch {
                guard let self, !Task.isCancelled, self.dictation.token == token else { return }
                self.dictation.cancel()
                self.notice = ApiErrorMapper.userMessage(apiError(error))
            }
        }
    }

    func cancelDictation() {
        recordingDeadline.cancel()
        dictationTask?.cancel()
        dictationTask = nil
        dictation.cancel()
        capture.stop()
        releaseAudio()
    }

    func read(_ message: ChatMessage) {
        guard let chat, message.role == .bob, message.state != .streaming, !isDictating else { return }
        let context = chat.composerContext
        let speech = SpeechReplayText(message.text)
        guard !speech.text.isEmpty else { return }
        cancelAll()
        guard acquireAudio() else { return }
        notice = nil
        replayMessageID = message.id
        replayContext = context
        replayShortened = speech.isTruncated
        replayPhase = .preparing
        let request = replayGeneration
        replayTask = Task { [weak self, service] in
            do {
                let audio = try await service.speak(text: speech.text, workflowID: nil)
                guard let self, !Task.isCancelled, request == self.replayGeneration else { return }
                guard self.chat?.composerContext == context else { self.cancelAll(); return }
                self.replayAudio = audio.data
                self.replayShortened = speech.isTruncated || audio.isTruncated
                try VoiceAudioSession.activate()
                try await self.player.play(audio.data) { [weak self] in
                    guard let self, request == self.replayGeneration else { return }
                    guard self.chat?.composerContext == context else { self.cancelAll(); return }
                    self.replayPhase = .playing
                }
                self.finishedReplay(request: request)
            } catch {
                self?.failedReplay(error, request: request)
            }
        }
    }

    func toggleReplay() {
        guard let context = replayContext, chat?.composerContext == context else { cancelAll(); return }
        switch replayPhase {
        case .playing:
            player.pause()
            replayPhase = .paused
        case .paused:
            replayPhase = .preparing
            let request = replayGeneration
            player.resume { [weak self] in
                guard let self, request == self.replayGeneration else { return }
                guard self.chat?.composerContext == context else { self.cancelAll(); return }
                self.replayPhase = .playing
            }
        case .idle:
            guard let audio = replayAudio, acquireAudio() else { return }
            replayPhase = .preparing
            let request = replayGeneration
            replayTask = Task { [weak self] in
                guard let self, !Task.isCancelled, request == self.replayGeneration else { return }
                guard self.chat?.composerContext == context else { self.cancelAll(); return }
                do {
                    try VoiceAudioSession.activate()
                    try await self.player.play(audio) { [weak self] in
                        guard let self, request == self.replayGeneration else { return }
                        guard self.chat?.composerContext == context else { self.cancelAll(); return }
                        self.replayPhase = .playing
                    }
                    self.finishedReplay(request: request)
                } catch { self.failedReplay(error, request: request) }
            }
        case .preparing: break
        }
    }

    func sceneLeft(background: Bool) {
        if AudioScenePolicy.shouldCancel(background: background, permissionPending: dictation.phase == .requesting) {
            cancelAll()
        }
    }

    func cancelAll() {
        cancelDictation()
        replayGeneration += 1
        replayTask?.cancel()
        replayTask = nil
        player.stop()
        replayAudio = nil
        replayMessageID = nil
        replayContext = nil
        replayPhase = .idle
        releaseAudio()
    }

    private func finishedReplay(request: Int) {
        guard request == replayGeneration, !Task.isCancelled else { return }
        guard replayContext == chat?.composerContext else { cancelAll(); return }
        replayPhase = .idle
        releaseAudio()
    }

    private func failedReplay(_ error: Error, request: Int) {
        guard request == replayGeneration, !Task.isCancelled else { return }
        guard replayContext == chat?.composerContext else { cancelAll(); return }
        replayPhase = .idle
        if replayAudio == nil { replayMessageID = nil }
        notice = error is VoiceAudioError ? "Couldn't play that reply. Try again." : ApiErrorMapper.userMessage(apiError(error))
        releaseAudio()
    }

    private func acquireAudio() -> Bool {
        guard AudioSessionLease.shared.acquire(owner: owner) else {
            notice = "Close the voice conversation before using dictation or replay."
            return false
        }
        events.start { [weak self] in
            self?.cancelAll()
            self?.notice = "Audio stopped when the sound connection changed."
        }
        return true
    }

    private func releaseAudio() {
        guard AudioSessionLease.shared.isOwned(by: owner) else { return }
        events.stop()
        VoiceAudioSession.deactivate()
        AudioSessionLease.shared.release(owner: owner)
    }
}
