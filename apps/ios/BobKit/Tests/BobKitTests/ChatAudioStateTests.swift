import XCTest
@testable import BobKit

final class ChatAudioStateTests: XCTestCase {
    @MainActor func testAudioOwnershipRejectsConcurrentCaptureAndStaleRelease() {
        let lease = AudioSessionLease()
        let voice = UUID(), dictation = UUID()
        XCTAssertTrue(lease.acquire(owner: voice))
        XCTAssertFalse(lease.acquire(owner: dictation))
        lease.release(owner: dictation)
        XCTAssertFalse(lease.acquire(owner: dictation))
        lease.release(owner: voice)
        XCTAssertTrue(lease.acquire(owner: dictation))
    }

    func testDictationAppendsToLatestDraftOnlyInOriginalContext() {
        var state = ChatDictationState()
        let token = state.begin(context: "chat-a")
        XCTAssertTrue(state.record(token: token))
        _ = state.append([Int16](repeating: 7, count: 16000))
        XCTAssertNotNil(state.finish(token: token))
        XCTAssertNil(state.complete(token: token, context: "chat-b", draft: "Existing", text: "words"))
        XCTAssertEqual(state.complete(token: token, context: "chat-a", draft: "Edited while listening", text: " words "), "Edited while listening words")
        XCTAssertEqual(state.phase, .idle)
    }

    func testCancelledRecordingAndTranscriptionCannotAppendLater() {
        var state = ChatDictationState()
        let first = state.begin(context: "chat")
        state.cancel()
        XCTAssertFalse(state.record(token: first))
        let second = state.begin(context: "chat")
        _ = state.record(token: second)
        _ = state.append([1, 2, 3])
        _ = state.finish(token: second)
        state.cancel()
        XCTAssertNil(state.complete(token: second, context: "chat", draft: "Keep me", text: "late"))
        XCTAssertEqual(state.sampleCount, 0)
    }

    func testDictationIsBoundedBelowServerAudioLimitAndClearsSamplesOnFinish() throws {
        var state = ChatDictationState()
        let token = state.begin(context: "chat")
        _ = state.record(token: token)
        XCTAssertTrue(state.append([Int16](repeating: 1, count: ChatDictationState.maximumSamples + 500)))
        XCTAssertEqual(state.sampleCount, ChatDictationState.maximumSamples)
        let wav = try XCTUnwrap(state.finish(token: token))
        XCTAssertLessThanOrEqual(wav.count, VoiceClient.maxAudioBytes)
        XCTAssertEqual(state.sampleCount, 0)
    }

    @MainActor func testDeadlineExpiresWithoutAudioSamples() async {
        let entered = expectation(description: "Waiting on clock")
        var resume: CheckedContinuation<Void, Never>?
        let deadline = AudioRecordingDeadline(wait: {
            await withCheckedContinuation { resume = $0; entered.fulfill() }
        })
        let token = UUID()
        var expired: UUID?
        let task = deadline.start(token: token) { expired = $0 }
        await fulfillment(of: [entered], timeout: 1)
        resume?.resume()
        await task.value
        XCTAssertEqual(expired, token)
    }

    @MainActor func testCancelledDeadlineCannotExpireEvenIfClockCompletesLate() async {
        let entered = expectation(description: "Waiting on clock")
        var resume: CheckedContinuation<Void, Never>?
        let deadline = AudioRecordingDeadline(wait: {
            await withCheckedContinuation { resume = $0; entered.fulfill() }
        })
        var expired = false
        let task = deadline.start(token: UUID()) { _ in expired = true }
        await fulfillment(of: [entered], timeout: 1)
        deadline.cancel()
        resume?.resume()
        await task.value
        XCTAssertFalse(expired)
    }

    func testPermissionPromptSurvivesInactiveButNeverBackground() {
        XCTAssertFalse(AudioScenePolicy.shouldCancel(background: false, permissionPending: true))
        XCTAssertTrue(AudioScenePolicy.shouldCancel(background: true, permissionPending: true))
        XCTAssertTrue(AudioScenePolicy.shouldCancel(background: false, permissionPending: false))
    }

    func testSpeechReplayBoundsUTF16WithoutSplittingEmojiAndReportsShortening() {
        let long = SpeechReplayText(String(repeating: "😀", count: 400))
        XCTAssertLessThanOrEqual(long.text.utf16.count, 700)
        XCTAssertFalse(long.text.contains("�"))
        XCTAssertTrue(long.isTruncated)
        XCTAssertEqual(SpeechReplayText(" Hello ").text, "Hello")
        XCTAssertFalse(SpeechReplayText("Hello").isTruncated)
    }
}
