import BobKit
import SwiftUI
import UIKit

// The voice moment: one calm screen with Bob at its centre, and the chat waiting underneath.
struct VoiceMomentView: View {
    let chat: ChatViewModel
    let onClose: () -> Void

    @State private var model: VoiceModel
    @State private var hasClosed = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(chat: ChatViewModel, onClose: @escaping () -> Void) {
        self.chat = chat
        self.onClose = onClose
        _model = State(initialValue: VoiceModel(chat: chat, dependencies: VoiceServiceFactory.make()))
    }

    private var reply: VoiceReplySnapshot {
        let last = chat.transcript.messages.last
        return VoiceReplySnapshot(text: last?.role == .bob ? last?.text ?? "" : "", isStreaming: chat.transcript.isStreaming, failure: chat.transcript.failureMessage)
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 20) {
                    scopeHeader
                    if model.permissionDenied {
                        denied
                    } else {
                        conversation
                    }
                }
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity)
                .frame(minHeight: geometry.size.height)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { controls }
        .bobPage()
        .privacySensitive()
        .task { await model.begin() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            model.close()
        }
        .onChange(of: reply) { _, reply in model.replyChanged(reply) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { model.sceneLeft(background: phase == .background) }
        }
        .onChange(of: model.state) { old, state in
            if state == .off, old != .off {
                finish()
            } else {
                AccessibilityNotification.Announcement(announcement(for: state)).post()
            }
        }
        .sensoryFeedback(trigger: model.isMicLive) { _, live in
            live ? .start : .stop
        }
    }

    private var scopeHeader: some View {
        VStack(spacing: 6) {
            Text("Bob")
                .font(.title2.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Label(chat.room == nil ? "Just you and Bob" : "Shared conversation", systemImage: chat.room == nil ? "lock" : "person.2")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
            if let title = chat.transcript.title, !title.isEmpty {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var conversation: some View {
        VStack(spacing: 20) {
            Button {
                if model.isMuted { model.toggleMute() } else { model.tapBob() }
            } label: {
                VoiceBob(state: model.isMuted && model.state.isMicLive ? .paused : model.state, level: { model.level })
                    .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .disabled(model.state == .off)
            .accessibilityLabel(actionLabel)
            .accessibilityAddTraits(.startsMediaSession)

            VStack(spacing: 12) {
                Label(statusLabel, systemImage: model.isMicLive ? "mic.fill" : "mic.slash.fill")
                    .font(.headline)
                    .labelStyle(.titleAndIcon)

                if model.heard != nil || model.spoken != nil {
                    VStack(alignment: .leading, spacing: 16) {
                        if let heard = model.heard { caption(heard, speaker: "You") }
                        if let spoken = model.spoken { caption(spoken, speaker: "Bob") }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(BobColor.surface, in: RoundedRectangle(cornerRadius: BobLayout.controlRadius))
                    .accessibilityIdentifier("voice-subtitles")
                }
                if let detail {
                    Text(detail)
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
    }

    private func caption(_ text: String, speaker: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(speaker)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(BobFont.body)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if model.state == .speaking || model.state == .thinking {
                Button(action: model.interrupt) {
                    Label(model.state == .speaking ? "Stop reply" : "Cancel reply", systemImage: "stop.fill")
                }
                .buttonStyle(BobSecondaryButtonStyle(expands: true))
                .accessibilityHint(model.isMuted ? "Stops this reply. Your microphone stays muted." : "Stops this reply and starts listening to you.")
            } else if model.state == .hearing {
                Button(action: model.tapBob) {
                    Label("Send now", systemImage: "arrow.up")
                }
                .buttonStyle(BobSecondaryButtonStyle(expands: true))
            }
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 12) { sessionButtons }
            } else {
                HStack(alignment: .top, spacing: 12) { sessionButtons }
            }
        }
        .padding(.horizontal, BobLayout.pageMargin)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
        .background(BobColor.page)
        .overlay(alignment: .top) { BobDivider() }
    }

    @ViewBuilder private var sessionButtons: some View {
        if !model.permissionDenied {
            voiceControl(model.state == .paused ? "Resume" : "Pause", symbol: model.state == .paused ? "play.fill" : "pause.fill", selected: model.state == .paused, action: model.togglePause)
                .disabled(model.state == .off)
                .accessibilityHint(model.state == .paused ? "Continues the conversation. Your microphone mute setting is kept." : "Turns off the microphone and stops Bob speaking.")
            voiceControl(model.isMuted ? "Unmute" : "Mute", symbol: model.isMuted ? "mic.slash.fill" : "mic.fill", selected: model.isMuted, action: model.toggleMute)
                .disabled(model.state == .off)
                .accessibilityLabel(model.isMuted ? "Unmute microphone" : "Mute microphone")
                .accessibilityValue(model.isMuted ? "Muted" : "Not muted")
                .accessibilityHint("Controls only your microphone. Bob can finish his reply while muted.")
        }
        voiceControl("End", symbol: "phone.down.fill", endsSession: true, action: finish)
        .accessibilityLabel("End voice conversation")
        .accessibilityHint("Stops microphone capture and speech, then returns to where you started.")
    }

    private func finish() {
        guard !hasClosed else { return }
        hasClosed = true
        model.close()
        onClose()
    }

    private func voiceControl(_ title: String, symbol: String, selected: Bool = false, endsSession: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(endsSession ? BobColor.dangerText : selected ? BobColor.onAccent : BobColor.ink)
                    .frame(width: 56, height: 56)
                    .background(selected ? BobColor.accent : BobColor.wash, in: Circle())
                Text(title)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minWidth: 72, minHeight: 80)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
    }

    private var statusLabel: String {
        if model.state == .off { return "Getting ready" }
        if model.isMuted && model.state.isMicLive { return "Microphone muted" }
        return model.state.label
    }

    private var denied: some View {
        VStack(spacing: 20) {
            VoiceBob(state: .paused, level: { 0 })
            Text("Bob can't hear you yet")
                .font(BobFont.heading)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Turn on the microphone for Bob in Settings. You can still type to him.")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .buttonStyle(BobPrimaryButtonStyle())
        }
    }

    private var detail: String? {
        if let notice = model.notice { return notice }
        if model.isMuted && model.state.isMicLive { return "Bob can still speak. Unmute when you're ready to talk." }
        switch model.state {
        case .hearing: return "Subtitles appear after you finish speaking."
        case .thinking: return model.heard == nil ? "Finding your words…" : nil
        case .paused: return "Microphone off. Resume whenever you're ready."
        case .listening: return model.heard == nil ? "Go ahead. I'm listening." : nil
        case .off, .speaking: return nil
        }
    }

    private var actionLabel: String {
        if model.isMuted { return "Bob. Unmute microphone" }
        return switch model.state {
        case .off: "Bob"
        case .listening: "Listening. Pause"
        case .hearing: "Hearing you. Send now"
        case .thinking: "Thinking. Cancel"
        case .speaking: "Speaking. Interrupt"
        case .paused: "Paused. Carry on"
        }
    }

    private func announcement(for state: VoiceState) -> String {
        if state == .paused, let notice = model.notice {
            return "\(state.label). \(notice)"
        }
        return state.label
    }
}

// Bob, and all the motion on the screen: he breathes while listening, leans in to a voice, sways while thinking and pulses while speaking. Still under Reduce Motion.
private struct VoiceBob: View {
    let state: VoiceState
    let level: () -> Float

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var size: CGFloat = 180

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || state == .paused || state == .off)) { timeline in
            let motion = reduceMotion ? Motion() : Motion(state: state, level: level(), time: timeline.date.timeIntervalSinceReferenceDate)
            Image("BobPlayful")
                .resizable()
                .scaledToFit()
                .frame(width: min(size, 200), height: min(size, 200))
                .scaleEffect(motion.scale)
                .rotationEffect(.degrees(motion.tilt))
                .opacity(state == .paused ? 0.6 : 1)
                .accessibilityHidden(true)
        }
    }

    private struct Motion {
        var scale = 1.0
        var tilt = 0.0

        init() {}

        init(state: VoiceState, level: Float, time: TimeInterval) {
            func wave(_ period: Double) -> Double { sin(2 * .pi * time / period) }
            switch state {
            case .listening: scale = 1 + 0.015 * wave(4)
            case .hearing: scale = 1.02 + min(Double(level) * 0.4, 0.08)
            case .thinking: tilt = 3 * wave(3)
            case .speaking: scale = 1 + 0.03 * wave(0.8)
            case .off, .paused: break
            }
        }
    }
}
