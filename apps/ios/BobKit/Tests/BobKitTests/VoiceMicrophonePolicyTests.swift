import XCTest
@testable import BobKit

final class VoiceMicrophonePolicyTests: XCTestCase {
    func testMutingAnUtteranceClosesInputWithoutSubmittingOrPausingPlayback() {
        let result = VoiceMicrophonePolicy.settingMuted(true, state: .hearing)
        XCTAssertEqual(result.state, .listening)
        XCTAssertEqual(result.effects, [.closeMic, .clearIdleTimer])
        XCTAssertFalse(VoiceMicrophonePolicy.isMicLive(result.state, muted: true))
    }

    func testMutingWhileSpeakingLeavesTheReplyPlaying() {
        let result = VoiceMicrophonePolicy.settingMuted(true, state: .speaking)
        XCTAssertEqual(result.state, .speaking)
        XCTAssertFalse(result.effects.contains(.stopSpeech))
        XCTAssertFalse(result.effects.contains(.cancelTurn))
        XCTAssertFalse(result.effects.contains(.abandonTurn))
    }

    func testReplyCompletionCannotReopenAMutedMicrophone() {
        let result = VoiceMicrophonePolicy.transition(.speaking, .replyDone, muted: true)
        XCTAssertEqual(result.state, .listening)
        XCTAssertFalse(result.effects.contains(.openMic))
        XCTAssertFalse(result.effects.contains(.startIdleTimer))
    }

    func testUnmuteDuringPlaybackDoesNotStartFullDuplexCapture() {
        let result = VoiceMicrophonePolicy.settingMuted(false, state: .speaking)
        XCTAssertEqual(result.state, .speaking)
        XCTAssertEqual(result.effects, [])
        let finished = VoiceMicrophonePolicy.transition(result.state, .replyDone, muted: false)
        XCTAssertEqual(finished.effects, [.openMic, .startIdleTimer])
    }

    func testPauseResumeRetainsMuteUntilExplicitUnmute() {
        let paused = VoiceMicrophonePolicy.transition(.speaking, .pause, muted: true)
        XCTAssertEqual(paused.state, .paused)
        XCTAssertTrue(paused.effects.contains(.stopSpeech))
        let resumed = VoiceMicrophonePolicy.transition(paused.state, .resume, muted: true)
        XCTAssertEqual(resumed.state, .listening)
        XCTAssertFalse(resumed.effects.contains(.openMic))
        let unmuted = VoiceMicrophonePolicy.settingMuted(false, state: resumed.state)
        XCTAssertEqual(unmuted.effects, [.openMic, .startIdleTimer])
    }

    func testUnmuteDoesNotResumeAPausedOrEndedSession() {
        for state in [VoiceState.paused, .off] {
            let result = VoiceMicrophonePolicy.settingMuted(false, state: state)
            XCTAssertEqual(result.state, state)
            XCTAssertEqual(result.effects, [])
        }
    }

    func testQueuedCaptureEventsCannotSubmitAfterMute() {
        for event in [VoiceEvent.speechStarted, .utteranceEnded] {
            let result = VoiceMicrophonePolicy.transition(.listening, event, muted: true)
            XCTAssertEqual(result.state, .listening)
            XCTAssertEqual(result.effects, [])
        }
    }

    func testStopStillTearsDownAMutedReply() {
        let result = VoiceMicrophonePolicy.transition(.speaking, .stop, muted: true)
        XCTAssertEqual(result.state, .off)
        XCTAssertTrue(result.effects.contains(.stopSpeech))
        XCTAssertFalse(result.effects.contains(.openMic))
    }
}
