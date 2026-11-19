import BobKit
import Foundation

// Words from audio and audio from words. The voice model sees this, never the network.
protocol VoiceServing: Sendable {
    func transcribe(wav: Data, workflowID: String?) async throws -> String
    func speak(text: String, workflowID: String?) async throws -> SpokenAudio
}

extension VoiceClient: VoiceServing {}

// What a conversation needs from outside itself.
struct VoiceDependencies {
    let service: VoiceServing
    let capture: VoiceCapturing
    let player: VoicePlaying
}

// The server when there is one, otherwise the scripted demo, which only a debug build can reach.
enum VoiceServiceFactory {
    @MainActor static func make() -> VoiceDependencies {
        // Audio and words never reach a URL cache.
        if let client = AppSession.make({ VoiceClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) {
            return VoiceDependencies(service: client, capture: MicCapture(), player: SpeechPlayer())
        }
        return VoiceDependencies(service: StubVoiceService(), capture: DemoCapture(), player: SpeechPlayer())
    }
}

// A pretend server: it always hears the same words and answers in silence of about the right length.
struct StubVoiceService: VoiceServing {
    func transcribe(wav: Data, workflowID: String?) async throws -> String {
        try await Task.sleep(for: .milliseconds(500))
        return "What's on for today?"
    }

    func speak(text: String, workflowID: String?) async throws -> SpokenAudio {
        try await Task.sleep(for: .milliseconds(200))
        let seconds = Double(text.count) * 0.06
        return SpokenAudio(data: VoiceWAV.encode(samples: [Int16](repeating: 0, count: Int(seconds * Double(VoiceWAV.sampleRate)))), isTruncated: false)
    }
}

// The demo uses the real microphone when there is one, and a pretend voice when there isn't, so a simulator with no mic still shows every state.
final class DemoCapture: VoiceCapturing {
    private let mic = MicCapture()
    private var script: Task<Void, Never>?

    func start(onSamples: @escaping ([Int16]) -> Void, onRestartNeeded: @escaping () -> Void) throws {
        stop()
        do {
            try mic.start(onSamples: onSamples, onRestartNeeded: onRestartNeeded)
        } catch {
            script = Task {
                let frame = VoiceEndpointer.frameSamples
                let quiet = [Int16](repeating: 0, count: frame)
                let voice = (0..<frame).map { Int16($0 % 2 == 0 ? 6000 : -6000) }
                var elapsed = 0
                while !Task.isCancelled {
                    onSamples(elapsed >= 1500 && elapsed < 3000 ? voice : quiet)
                    elapsed += VoiceEndpointer.frameMs
                    try? await Task.sleep(for: .milliseconds(VoiceEndpointer.frameMs))
                }
            }
        }
    }

    func stop() {
        mic.stop()
        script?.cancel()
        script = nil
    }
}
