import XCTest
@testable import BobKit

private final class VoiceStubProtocol: URLProtocol, @unchecked Sendable {
    struct Recorded { let method: String?; let url: URL?; let headers: [String: String]; let body: Data }
    struct Reply { let status: Int; let headers: [String: String]; let body: Data }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var replies: [String: [Reply]] = [:]
    nonisolated(unsafe) private static var recorded: [String: [Recorded]] = [:]
    static let idHeader = "X-Stub-ID"

    static func set(_ id: String, replies list: [Reply]) { lock.withLock { replies[id] = list; recorded[id] = [] } }
    static func requests(_ id: String) -> [Recorded] { lock.withLock { recorded[id] ?? [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        guard let id = request.value(forHTTPHeaderField: Self.idHeader), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65536)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        let recorded = Recorded(method: request.httpMethod, url: url, headers: request.allHTTPHeaderFields ?? [:], body: body)
        let reply: Reply = Self.lock.withLock {
            Self.recorded[id, default: []].append(recorded)
            return Self.replies[id]?.count ?? 0 > 1 ? Self.replies[id]!.removeFirst() : Self.replies[id]!.first!
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class VoiceClientTests: XCTestCase {
    private let id = UUID().uuidString

    private func client(_ replies: VoiceStubProtocol.Reply..., reauthenticate: Reauthenticator? = nil) -> VoiceClient {
        VoiceStubProtocol.set(id, replies: replies)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceStubProtocol.self]
        configuration.httpAdditionalHeaders = [VoiceStubProtocol.idHeader: id]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        return VoiceClient(baseURL: URL(string: "https://example.invalid")!, session: session, accessToken: { "access-1" }, reauthenticate: reauthenticate)
    }

    private func reply(_ status: Int, _ body: String, headers: [String: String] = [:]) -> VoiceStubProtocol.Reply {
        .init(status: status, headers: headers, body: Data(body.utf8))
    }

    private func transcribeError(_ status: Int, code: String) async -> ApiError? {
        do {
            _ = try await client(reply(status, #"{"error":{"code":"\#(code)"}}"#)).transcribe(wav: Data([1, 2]))
            return nil
        } catch {
            return error as? ApiError
        }
    }

    func testTranscribeSendsBase64WavInTheServersJSON() async throws {
        let wav = Data([0, 1, 2, 250])
        let text = try await client(reply(200, #"{"text":"hello there"}"#)).transcribe(wav: wav, workflowID: "wf-1")
        XCTAssertEqual(text, "hello there")
        let request = try XCTUnwrap(VoiceStubProtocol.requests(id).first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/api/voice")
        XCTAssertEqual(request.headers["Authorization"], "Bearer access-1")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(String(decoding: request.body, as: UTF8.self), #"{"audio":"AAEC+g==","format":"wav","workflowId":"wf-1"}"#)
    }

    func testTranscribeLeavesOutAMissingWorkflowID() async throws {
        _ = try await client(reply(200, #"{"text":"hi"}"#)).transcribe(wav: Data([1]))
        let body = try XCTUnwrap(VoiceStubProtocol.requests(id).first?.body)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"audio":"AQ==","format":"wav"}"#)
    }

    func testAudioOverTheServersLimitIsNeverSent() async throws {
        let client = client(reply(200, #"{"text":"hi"}"#))
        do {
            _ = try await client.transcribe(wav: Data(count: VoiceClient.maxAudioBytes + 1))
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .audioTooLarge)
        }
        XCTAssertTrue(VoiceStubProtocol.requests(id).isEmpty)
    }

    func testAudioAtTheLimitIsSent() async throws {
        _ = try await client(reply(200, #"{"text":"hi"}"#)).transcribe(wav: Data(count: VoiceClient.maxAudioBytes))
        XCTAssertEqual(VoiceStubProtocol.requests(id).count, 1)
    }

    func testTranscribeMapsTheServersErrors() async {
        let result1 = await transcribeError(422, code: "no_speech_detected")
        XCTAssertEqual(result1, .noSpeechDetected)
        let result2 = await transcribeError(413, code: "audio_too_large")
        XCTAssertEqual(result2, .audioTooLarge)
        let result3 = await transcribeError(400, code: "unsupported_format")
        XCTAssertEqual(result3, .unsupportedAudio)
        let result4 = await transcribeError(400, code: "invalid_audio")
        XCTAssertEqual(result4, .unsupportedAudio)
        let result5 = await transcribeError(502, code: "upstream_error")
        XCTAssertEqual(result5, .upstream)
        let result6 = await transcribeError(503, code: "out_of_credit")
        XCTAssertEqual(result6, .outOfCredit)
    }

    func testBlankWordsAreNoSpeech() async {
        do {
            _ = try await client(reply(200, #"{"text":"  "}"#)).transcribe(wav: Data([1]))
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .noSpeechDetected)
        }
    }

    func testRepeatsOnceWithAFreshTokenAfter401() async throws {
        let auth = Reauthenticator(fresh: { _ in "access-2" })
        let text = try await client(reply(401, "{}"), reply(200, #"{"text":"hi"}"#), reauthenticate: auth).transcribe(wav: Data([1]))
        XCTAssertEqual(text, "hi")
        XCTAssertEqual(VoiceStubProtocol.requests(id).map { $0.headers["Authorization"] }, ["Bearer access-1", "Bearer access-2"])
    }

    func testSpeakSendsTextAndReturnsTheBytes() async throws {
        let audio = try await client(reply(200, "mp3-bytes", headers: ["Content-Type": "audio/mpeg"])).speak(text: "Hello.", workflowID: "wf-1")
        XCTAssertEqual(audio, SpokenAudio(data: Data("mp3-bytes".utf8), isTruncated: false))
        let request = try XCTUnwrap(VoiceStubProtocol.requests(id).first)
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/api/speech")
        XCTAssertEqual(String(decoding: request.body, as: UTF8.self), #"{"text":"Hello.","workflowId":"wf-1"}"#)
    }

    func testSpeakReadsTheTruncatedHeader() async throws {
        let audio = try await client(reply(200, "x", headers: ["X-Bob-Speech-Truncated": "true"])).speak(text: "Long.")
        XCTAssertTrue(audio.isTruncated)
    }

    func testSpeakOutOfCredit() async {
        do {
            _ = try await client(reply(503, #"{"error":{"code":"out_of_credit"}}"#)).speak(text: "Hi.")
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .outOfCredit)
        }
    }

    func testMarkHeardPatchesTheStoredReply() async throws {
        VoiceStubProtocol.set(id, replies: [reply(200, "{}")])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceStubProtocol.self]
        configuration.httpAdditionalHeaders = [VoiceStubProtocol.idHeader: id]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        let client = ConversationsClient(baseURL: URL(string: "https://example.invalid")!, session: session, accessToken: { "access-1" })
        try await client.markHeard(conversationID: "c1", messageID: "m1", heardCharacters: 42)
        let request = try XCTUnwrap(VoiceStubProtocol.requests(id).first)
        XCTAssertEqual(request.method, "PATCH")
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/api/conversations/c1/messages/m1")
        XCTAssertEqual(String(decoding: request.body, as: UTF8.self), #"{"heard_chars":42,"interrupted":true}"#)
    }

    func testWavByteLayout() {
        let wav = VoiceWAV.encode(samples: [1, -2, 32767])
        let bytes = [UInt8](wav)
        XCTAssertEqual(bytes.count, 50)
        XCTAssertEqual(Array(bytes[0..<4]), Array("RIFF".utf8))
        XCTAssertEqual(Array(bytes[4..<8]), [42, 0, 0, 0])
        XCTAssertEqual(Array(bytes[8..<16]), Array("WAVEfmt ".utf8))
        XCTAssertEqual(Array(bytes[16..<20]), [16, 0, 0, 0])
        XCTAssertEqual(Array(bytes[20..<24]), [1, 0, 1, 0], "PCM, mono")
        XCTAssertEqual(Array(bytes[24..<28]), [0x80, 0x3E, 0, 0], "16000 Hz")
        XCTAssertEqual(Array(bytes[28..<32]), [0, 0x7D, 0, 0], "32000 bytes a second")
        XCTAssertEqual(Array(bytes[32..<36]), [2, 0, 16, 0], "2 bytes a frame, 16 bits")
        XCTAssertEqual(Array(bytes[36..<40]), Array("data".utf8))
        XCTAssertEqual(Array(bytes[40..<44]), [6, 0, 0, 0])
        XCTAssertEqual(Array(bytes[44...]), [1, 0, 0xFE, 0xFF, 0xFF, 0x7F])
    }
}
