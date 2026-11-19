import XCTest
@testable import BobKit

final class VoiceEndpointerTests: XCTestCase {
    private let quiet: Float = 0.001
    private let loud: Float = 0.2

    private func run(_ endpointer: inout VoiceEndpointer, _ level: Float, ms: Int) -> [VoiceEndpoint] {
        (0..<(ms / VoiceEndpointer.frameMs)).map { _ in endpointer.process(level: level) }.filter { $0 != .none }
    }

    func testSoundShorterThanMinimumSpeechIsDropped() {
        var endpointer = VoiceEndpointer()
        XCTAssertEqual(run(&endpointer, loud, ms: 160), [])
        XCTAssertEqual(run(&endpointer, quiet, ms: 2000), [])
    }

    func testSpeechStartsAt250Milliseconds() {
        var endpointer = VoiceEndpointer()
        XCTAssertEqual(run(&endpointer, loud, ms: 224), [])
        XCTAssertEqual(run(&endpointer, loud, ms: 32), [.speechStarted])
    }

    func testSilenceBelow900MillisecondsKeepsTheUtteranceOpen() {
        var endpointer = VoiceEndpointer()
        _ = run(&endpointer, loud, ms: 1000)
        XCTAssertEqual(run(&endpointer, quiet, ms: 864), [])
        XCTAssertEqual(run(&endpointer, loud, ms: 320), [])
    }

    func testSilenceAt900MillisecondsEndsTheUtterance() {
        var endpointer = VoiceEndpointer()
        _ = run(&endpointer, loud, ms: 256)
        let events = run(&endpointer, quiet, ms: 928)
        XCTAssertEqual(events, [.speechEnded(durationMs: 256 + 928)])
    }

    func testAnUtteranceEndsAtThirtySeconds() {
        var endpointer = VoiceEndpointer()
        let events = run(&endpointer, loud, ms: 31000)
        XCTAssertEqual(events.first, .speechStarted)
        XCTAssertEqual(events.dropFirst().first, .speechEnded(durationMs: 938 * 32))
    }

    func testASteadyHumIsLearnedAsTheRoom() {
        var endpointer = VoiceEndpointer()
        // Below the start level at first, so the floor rises to it.
        XCTAssertEqual(run(&endpointer, 0.011, ms: 3000), [])
        // Now the same room plus a little is still not speech.
        XCTAssertEqual(run(&endpointer, 0.02, ms: 3000).count, 0)
        // A voice well above it is.
        XCTAssertEqual(run(&endpointer, 0.2, ms: 320), [.speechStarted])
    }

    func testSpeechStartsAgainAfterAnUtterance() {
        var endpointer = VoiceEndpointer()
        _ = run(&endpointer, loud, ms: 300)
        _ = run(&endpointer, quiet, ms: 1000)
        XCTAssertEqual(run(&endpointer, loud, ms: 320), [.speechStarted])
    }
}

final class VoiceUtteranceCaptureTests: XCTestCase {
    private func frames(_ amplitude: Int16, count: Int) -> [Int16] {
        (0..<(count * VoiceEndpointer.frameSamples)).map { $0 % 2 == 0 ? amplitude : -amplitude }
    }

    func testAnUtteranceIsAWavHoldingWhatCameBeforeSpeechToo() throws {
        var capture = VoiceUtteranceCapture()
        XCTAssertEqual(capture.append(frames(1, count: 5)), [])
        XCTAssertEqual(capture.append(frames(8000, count: 8)), [.speechStarted])
        XCTAssertGreaterThan(capture.level, 0.1)
        let events = capture.append(frames(1, count: 29))
        guard case .utterance(let wav, let durationMs)? = events.first else {
            return XCTFail("expected an utterance")
        }
        XCTAssertEqual(durationMs, 37 * 32)
        let expectedFrames = 5 + 8 + 29
        XCTAssertEqual(wav.count, 44 + expectedFrames * VoiceEndpointer.frameSamples * 2)
    }

    func testSamplesCanArriveInAnySize() {
        var capture = VoiceUtteranceCapture()
        let all = frames(8000, count: 8)
        var events: [VoiceCaptureEvent] = []
        for start in stride(from: 0, to: all.count, by: 100) {
            events += capture.append(Array(all[start..<min(start + 100, all.count)]))
        }
        XCTAssertEqual(events, [.speechStarted])
    }

    func testFinishNowHandsBackOnlyAnOpenUtterance() {
        var capture = VoiceUtteranceCapture()
        XCTAssertNil(capture.finishNow())
        _ = capture.append(frames(8000, count: 8))
        XCTAssertEqual(capture.finishNow()?.count, 44 + 8 * VoiceEndpointer.frameSamples * 2)
        XCTAssertNil(capture.finishNow())
    }

    func testThirtySecondsFitsTheServersLimit() {
        var capture = VoiceUtteranceCapture()
        guard case .utterance(let wav, _)? = capture.append(frames(8000, count: 940)).last else {
            return XCTFail("expected an utterance")
        }
        XCTAssertLessThan(wav.count, VoiceClient.maxAudioBytes)
    }
}

final class VoiceConversationTests: XCTestCase {
    private func next(_ state: VoiceState, _ event: VoiceEvent) -> VoiceState {
        VoiceConversation.transition(state, event).state
    }

    private func effects(_ state: VoiceState, _ event: VoiceEvent) -> [VoiceEffect] {
        VoiceConversation.transition(state, event).effects
    }

    func testAWholeTurn() {
        var state = VoiceState.off
        for (event, expected) in [(VoiceEvent.start, VoiceState.listening), (.speechStarted, .hearing), (.utteranceEnded, .thinking), (.firstAudio, .speaking), (.replyDone, .listening)] {
            state = next(state, event)
            XCTAssertEqual(state, expected)
        }
    }

    func testTheMicIsOnlyLiveWhileListening() {
        XCTAssertEqual([VoiceState.off, .listening, .hearing, .thinking, .speaking, .paused].filter(\.isMicLive), [.listening, .hearing])
    }

    func testTheMicClosesAsSoonAsAnUtteranceIsSent() {
        XCTAssertEqual(effects(.hearing, .utteranceEnded), [.closeMic, .submitUtterance, .clearIdleTimer])
    }

    func testTappingBobWhileHeardSendsNow() {
        XCTAssertEqual(next(.hearing, .tapBob), .thinking)
        XCTAssertTrue(effects(.hearing, .tapBob).contains(.submitUtterance))
    }

    func testInterruptingStopsSpeechAndRecordsWhatWasHeard() {
        XCTAssertEqual(next(.speaking, .tapBob), .listening)
        XCTAssertEqual(effects(.speaking, .tapBob), [.stopSpeech, .cancelTurn, .recordHeard, .openMic, .startIdleTimer])
    }

    func testTappingWhileThinkingCancels() {
        XCTAssertEqual(next(.thinking, .tapBob), .listening)
        XCTAssertEqual(effects(.thinking, .tapBob).first, .cancelTurn)
    }

    func testTappingWhileListeningPausesAndTappingAgainCarriesOn() {
        XCTAssertEqual(next(.listening, .tapBob), .paused)
        XCTAssertTrue(effects(.listening, .tapBob).contains(.closeMic))
        XCTAssertEqual(next(.paused, .tapBob), .listening)
        XCTAssertTrue(effects(.paused, .tapBob).contains(.openMic))
    }

    func testPauseClosesMicWithoutSubmittingPartialSpeech() {
        for state in [VoiceState.listening, .hearing] {
            XCTAssertEqual(next(state, .pause), .paused)
            XCTAssertEqual(effects(state, .pause), [.closeMic, .clearIdleTimer])
        }
    }

    func testPauseStopsSpeechAndDoesNotResumeFromLateAudio() {
        XCTAssertEqual(next(.speaking, .pause), .paused)
        XCTAssertEqual(effects(.speaking, .pause), [.stopSpeech, .abandonTurn, .recordHeard, .clearIdleTimer])
        XCTAssertEqual(effects(.thinking, .pause), [.abandonTurn, .clearIdleTimer])
        XCTAssertEqual(next(.paused, .firstAudio), .paused)
        XCTAssertEqual(next(.paused, .replyDone), .paused)
        XCTAssertEqual(next(.paused, .resume), .listening)
        XCTAssertEqual(effects(.paused, .resume), [.openMic, .startIdleTimer])
    }

    func testExplicitInterruptOnlyActsOnAReply() {
        for state in [VoiceState.thinking, .speaking] {
            XCTAssertEqual(next(state, .interrupt), .listening)
            XCTAssertTrue(effects(state, .interrupt).contains(.cancelTurn))
        }
        for state in [VoiceState.off, .listening, .hearing, .paused] {
            XCTAssertEqual(effects(state, .interrupt), [])
        }
    }

    func testHeardNothingListensAgain() {
        XCTAssertEqual(next(.thinking, .heardNothing), .listening)
    }

    func testAFailureLeavesThinkingRatherThanStickingThere() {
        XCTAssertEqual(next(.thinking, .turnFailed), .paused)
        XCTAssertEqual(next(.speaking, .turnFailed), .paused)
    }

    func testASilentReplyListensAgain() {
        XCTAssertEqual(next(.thinking, .replyDone), .listening)
    }

    func testGoingAwayPausesFromEveryActiveStateAndNeverReopensByItself() {
        XCTAssertEqual(effects(.listening, .hidden), [.closeMic, .clearIdleTimer])
        XCTAssertEqual(effects(.hearing, .hidden), [.closeMic, .clearIdleTimer])
        XCTAssertEqual(effects(.thinking, .hidden), [.abandonTurn, .clearIdleTimer])
        XCTAssertEqual(effects(.speaking, .hidden), [.stopSpeech, .abandonTurn, .clearIdleTimer])
        for state in [VoiceState.listening, .hearing, .thinking, .speaking] {
            XCTAssertEqual(next(state, .hidden), .paused)
        }
        XCTAssertEqual(effects(.paused, .hidden), [])
    }

    func testIdleTimeoutTurnsOffOnlyWhileListening() {
        XCTAssertEqual(next(.listening, .idleTimeout), .off)
        XCTAssertEqual(next(.hearing, .idleTimeout), .hearing)
        XCTAssertEqual(next(.speaking, .idleTimeout), .speaking)
    }

    func testAMicThatWontOpenPauses() {
        XCTAssertEqual(next(.listening, .micFailed), .paused)
    }

    func testStopEndsEverythingAndLeavesTheReplyToFinish() {
        XCTAssertEqual(effects(.listening, .stop), [.closeMic, .clearIdleTimer])
        XCTAssertEqual(effects(.speaking, .stop), [.stopSpeech, .abandonTurn, .clearIdleTimer])
        XCTAssertFalse(effects(.thinking, .stop).contains(.cancelTurn))
        XCTAssertEqual(next(.paused, .stop), .off)
    }

    func testOffIgnoresEverythingButStart() {
        for event in [VoiceEvent.stop, .tapBob, .speechStarted, .firstAudio, .replyDone, .hidden, .idleTimeout] {
            XCTAssertEqual(next(.off, event), .off)
            XCTAssertEqual(effects(.off, event), [])
        }
    }
}

final class VoiceReplyFeedTests: XCTestCase {
    func testEachWordOnceAndTheEndOnce() {
        var feed = VoiceReplyFeed()
        XCTAssertEqual(feed.update(text: "", isStreaming: true).chunk, "")
        XCTAssertEqual(feed.update(text: "Hel", isStreaming: true).chunk, "Hel")
        XCTAssertEqual(feed.update(text: "Hello", isStreaming: true).chunk, "lo")
        let last = feed.update(text: "Hello.", isStreaming: false)
        XCTAssertEqual(last.chunk, ".")
        XCTAssertTrue(last.ended)
        let after = feed.update(text: "Hello.", isStreaming: false)
        XCTAssertEqual(after.chunk, "")
        XCTAssertFalse(after.ended)
    }
}

final class VoiceSentenceSplitterTests: XCTestCase {
    private func split(_ chunks: [String]) -> (sentences: [String], rest: [String]) {
        var splitter = VoiceSentenceSplitter()
        let sentences = chunks.flatMap { splitter.push($0) }
        return (sentences, splitter.flush())
    }

    func testTheWebsCases() {
        XCTAssertEqual(split(["Hello world. This is a"]).sentences, ["Hello world."])
        XCTAssertEqual(split(["Hello world. This is a"]).rest, ["This is a"])
        XCTAssertEqual(split(["Hello wor", "ld. Then"]).sentences, ["Hello world."])
        XCTAssertEqual(split(["Pi is 3.", "14 approx. Then"]).sentences, ["Pi is 3.14 approx."])
        XCTAssertEqual(split(["The value is 3.5 and done. Then"]).sentences, ["The value is 3.5 and done."])
        XCTAssertEqual(split(["Wow! Next one."]).sentences, ["Wow!"])
        XCTAssertEqual(split(["Really? Then go."]).sentences, ["Really?"])
        XCTAssertEqual(split(["Dr. Smith arrived. Then left."]).sentences, ["Dr. Smith arrived."])
        XCTAssertEqual(split(["One\n\nTwo"]).sentences, ["One"])
    }

    func testMarkdownIsNotReadOut() {
        XCTAssertEqual(split(["## A **bold** `word` and [a link](https://x.y). Next"]).sentences, ["A bold word and a link."])
        XCTAssertEqual(split(["- first item\n\n- second item"]).sentences, ["first item"])
        XCTAssertEqual(split(["- first item\n\n- second item"]).rest, ["second item"])
    }

    func testALongRunOfWordsIsCutAtASpaceWithinTheLimit() {
        var splitter = VoiceSentenceSplitter(maxCharacters: 20)
        let sentences = splitter.push("aaaa bbbb cccc dddd eeee ffff")
        XCTAssertEqual(sentences, ["aaaa bbbb cccc dddd"])
        XCTAssertEqual(splitter.flush(), ["eeee ffff"])
    }

    func testFlushOfNothingIsNothing() {
        XCTAssertEqual(split([]).rest, [])
    }
}

@MainActor
final class VoiceSpeechQueueTests: XCTestCase {
    private var played: [String] = []
    private var makes: [String] = []
    private var finished = 0
    private var firstAudio = 0
    private var errors = 0
    private var failing: Set<String> = []
    private var pendingPlay: CheckedContinuation<Void, Error>?

    private func queue(holdPlayback: Bool = false) -> VoiceSpeechQueue {
        let queue = VoiceSpeechQueue(
            synthesize: { [unowned self] text in
                makes.append(text)
                if failing.contains(text) { throw ApiError.upstream }
                return Data(text.utf8)
            },
            play: { [unowned self] audio, started in
                started()
                played.append(String(decoding: audio, as: UTF8.self))
                if holdPlayback {
                    try await withCheckedThrowingContinuation { pendingPlay = $0 }
                }
            },
            stopPlayback: { [unowned self] in
                pendingPlay?.resume()
                pendingPlay = nil
            }
        )
        queue.onFinished = { [unowned self] in finished += 1 }
        queue.onFirstAudio = { [unowned self] in firstAudio += 1 }
        queue.onError = { [unowned self] _ in errors += 1 }
        return queue
    }

    private func settle(until condition: () -> Bool) async {
        for _ in 0..<500 where !condition() {
            await Task.yield()
        }
        XCTAssertTrue(condition())
    }

    func testSpeaksInOrderAndFinishesOnce() async {
        let queue = queue()
        queue.enqueue("One.")
        queue.enqueue("Two.")
        queue.finishReply()
        await settle { finished == 1 }
        XCTAssertEqual(played, ["One.", "Two."])
        XCTAssertEqual(firstAudio, 1)
    }

    func testStaysSpeakingUntilTheReplyEnds() async {
        let queue = queue()
        queue.enqueue("One.")
        await settle { played == ["One."] }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(finished, 0)
        queue.finishReply()
        await settle { finished == 1 }
    }

    func testAFailedSentenceIsSkipped() async {
        failing = ["Two."]
        let queue = queue()
        queue.enqueue("One.")
        queue.enqueue("Two.")
        queue.enqueue("Three.")
        queue.finishReply()
        await settle { finished == 1 }
        XCTAssertEqual(played, ["One.", "Three."])
        XCTAssertEqual(errors, 1)
    }

    func testAReplyWithNothingToSayStillFinishes() async {
        let queue = queue()
        queue.finishReply()
        await settle { finished == 1 }
        XCTAssertEqual(firstAudio, 0)
    }

    func testAtMostTwoAreMadeAtOnce() async {
        var waiting: [CheckedContinuation<Void, Never>] = []
        let queue = VoiceSpeechQueue(
            synthesize: { [unowned self] text in
                makes.append(text)
                await withCheckedContinuation { waiting.append($0) }
                return Data(text.utf8)
            },
            play: { _, started in started() },
            stopPlayback: {}
        )
        for text in ["One.", "Two.", "Three.", "Four."] { queue.enqueue(text) }
        await settle { waiting.count == 2 }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(makes, ["One.", "Two."])
        waiting.removeFirst().resume()
        await settle { makes.count == 3 }
        queue.stop()
        waiting.forEach { $0.resume() }
        waiting = []
    }

    func testStopSilencesAndCountsOnlyWhatWasHeardInFull() async {
        let queue = queue(holdPlayback: true)
        queue.enqueue("One.")
        queue.enqueue("Two.")
        await settle { pendingPlay != nil }
        pendingPlay?.resume()
        pendingPlay = nil
        await settle { played == ["One.", "Two."] && pendingPlay != nil }
        XCTAssertEqual(queue.stop(), 4)
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(played, ["One.", "Two."])
        XCTAssertEqual(finished, 0)
    }

    func testCaptionFollowsPlaybackStartNotSynthesisAndIgnoresLateCancelledStart() async {
        var starts: [@MainActor () -> Void] = []
        var captions: [String] = []
        let queue = VoiceSpeechQueue(
            synthesize: { Data($0.utf8) },
            play: { [unowned self] _, started in
                starts.append(started)
                try await withCheckedThrowingContinuation { pendingPlay = $0 }
            },
            stopPlayback: { [unowned self] in
                pendingPlay?.resume()
                pendingPlay = nil
            }
        )
        queue.onSentenceStarted = { captions.append($0) }
        queue.onFirstAudio = { [unowned self] in firstAudio += 1 }
        queue.enqueue("One.")
        queue.enqueue("Two.")
        await settle { starts.count == 1 }
        XCTAssertEqual(captions, [])
        XCTAssertEqual(firstAudio, 0)
        starts[0]()
        XCTAssertEqual(captions, ["One."])
        XCTAssertEqual(firstAudio, 1)
        pendingPlay?.resume()
        pendingPlay = nil
        await settle { starts.count == 2 }
        XCTAssertEqual(captions, ["One."])
        queue.stop()
        starts[1]()
        XCTAssertEqual(captions, ["One."])
        XCTAssertEqual(firstAudio, 1)
        for _ in 0..<50 { await Task.yield() }
    }

    func testCaptionsSkipFailedSentencesAndFollowSpokenOrder() async {
        failing = ["Two."]
        var captions: [String] = []
        let queue = queue()
        queue.onSentenceStarted = { captions.append($0) }
        ["One.", "Two.", "Three."].forEach(queue.enqueue)
        queue.finishReply()
        await settle { finished == 1 }
        XCTAssertEqual(captions, ["One.", "Three."])
    }

    func testWorksAgainAfterAStop() async {
        let queue = queue()
        queue.enqueue("One.")
        queue.stop()
        queue.enqueue("Two.")
        queue.finishReply()
        await settle { finished == 1 }
        XCTAssertEqual(played.last, "Two.")
    }
}
