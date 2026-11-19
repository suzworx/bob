// Microphone mute is independent of Pause: Bob may finish speaking while input stays closed.
// This gate wraps the existing conversation transitions without adding full-duplex capture.
public enum VoiceMicrophonePolicy {
    public static func isMicLive(_ state: VoiceState, muted: Bool) -> Bool {
        state.isMicLive && !muted
    }

    public static func settingMuted(_ muted: Bool, state: VoiceState) -> (state: VoiceState, effects: [VoiceEffect]) {
        guard state != .off else { return (state, []) }
        if muted {
            // Discard the open utterance rather than sending private words after a mute tap.
            return (state == .hearing ? .listening : state, [.closeMic, .clearIdleTimer])
        }
        return state.isMicLive ? (.listening, [.openMic, .startIdleTimer]) : (state, [])
    }

    public static func transition(_ state: VoiceState, _ event: VoiceEvent, muted: Bool) -> (state: VoiceState, effects: [VoiceEffect]) {
        if muted, event == .speechStarted || event == .utteranceEnded {
            return (state, [])
        }
        let result = VoiceConversation.transition(state, event)
        guard muted else { return result }
        return (result.state, result.effects.filter { $0 != .openMic && $0 != .startIdleTimer })
    }
}
