import XCTest
@testable import BobKit

private struct RecordedRequest: Sendable {
    let method: String?
    let url: URL?
    let headers: [String: String]
    let body: Data
}

private enum StubReply: Sendable {
    case response(status: Int, headers: [String: String], chunks: [Data])
    case failure(URLError.Code)
    // Sends `first`, then waits for `release` before sending `rest` and finishing.
    case paused(status: Int, first: Data, rest: [Data], release: DispatchSemaphore)
}

private final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [ChatStreamEvent] = []

    func append(_ event: ChatStreamEvent) {
        lock.withLock { stored.append(event) }
    }

    var events: [ChatStreamEvent] {
        lock.withLock { stored }
    }
}

private final class StubState: @unchecked Sendable {
    private let lock = NSLock()
    private var reply: StubReply = .response(status: 200, headers: [:], chunks: [])
    private var recorded: [RecordedRequest] = []

    func reset(_ newReply: StubReply) {
        lock.withLock {
            reply = newReply
            recorded = []
        }
    }

    func record(_ request: RecordedRequest) -> StubReply {
        lock.withLock {
            recorded.append(request)
            return reply
        }
    }

    var requests: [RecordedRequest] {
        lock.withLock { recorded }
    }
}

// Each test registers its own StubState under a unique id that its session sends
// in `StubURLProtocol.idHeader`, so a request that arrives after its test ended
// is recorded into that test's state and never into another test's.
private final class StubRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [String: StubState] = [:]

    func register(_ state: StubState, id: String) {
        lock.withLock { states[id] = state }
    }

    func state(for id: String) -> StubState? {
        lock.withLock { states[id] }
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    static let idHeader = "X-Stub-ID"
    static let registry = StubRegistry()

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let id = request.value(forHTTPHeaderField: Self.idHeader),
              let state = Self.registry.state(for: id) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        var headers = request.allHTTPHeaderFields ?? [:]
        headers[Self.idHeader] = nil
        let recorded = RecordedRequest(
            method: request.httpMethod,
            url: request.url,
            headers: headers,
            body: Self.bodyBytes(of: request)
        )
        switch state.record(recorded) {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .response(let status, let headers, let chunks):
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in chunks {
                client?.urlProtocol(self, didLoad: chunk)
            }
            client?.urlProtocolDidFinishLoading(self)
        case .paused(let status, let first, let rest, let release):
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"]) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: first)
            DispatchQueue.global().async {
                _ = release.wait(timeout: .now() + 5)
                for chunk in rest {
                    self.client?.urlProtocol(self, didLoad: chunk)
                }
                self.client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    override func stopLoading() {}

    private static func bodyBytes(of request: URLRequest) -> Data {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return Data()
        }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class ChatClientTests: XCTestCase {
    private let baseURL = URL(string: "https://example.invalid")
    // XCTest makes a new instance per test method, so each test gets its own stub.
    private let stubID = UUID().uuidString
    private let stub = StubState()

    private func reply(_ status: Int, headers: [String: String] = [:], _ chunks: [String] = []) {
        stub.reset(.response(status: status, headers: headers, chunks: chunks.map { Data($0.utf8) }))
    }

    private func client(token: String? = "access-1", base: URL? = nil) throws -> ChatClient {
        StubURLProtocol.registry.register(stub, id: stubID)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        configuration.httpAdditionalHeaders = [StubURLProtocol.idHeader: stubID]
        let url = try XCTUnwrap(base ?? baseURL)
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        return ChatClient(baseURL: url, session: session, accessToken: { token })
    }

    private func collect(_ stream: AsyncThrowingStream<ChatStreamEvent, Error>) async throws -> [ChatStreamEvent] {
        var events: [ChatStreamEvent] = []
        for try await event in stream {
            events.append(event)
        }
        return events
    }

    private func sendError(_ client: ChatClient, text: String = "hi", messageID: String = "msg-1") async -> Error? {
        do {
            _ = try await collect(client.send(text: text, messageID: messageID))
            return nil
        } catch {
            return error
        }
    }

    private var requests: [RecordedRequest] { stub.requests }

    private func jsonBody(_ request: RecordedRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
    }

    func testSendBuildsExactURLMethodHeadersAndBody() async throws {
        reply(200)
        _ = try await collect(client().send(text: "hello", messageID: "msg-1", conversationID: "conv-1"))
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/api/chat")
        XCTAssertEqual(request.headers["Authorization"], "Bearer access-1")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.headers["Accept"], "text/event-stream")
        let body = try jsonBody(request)
        XCTAssertEqual(Set(body.keys), ["id", "message", "origin"])
        XCTAssertEqual(body["id"] as? String, "conv-1")
        XCTAssertEqual(body["origin"] as? String, "web_text")
        let message = try XCTUnwrap(body["message"] as? [String: Any])
        XCTAssertEqual(Set(message.keys), ["id", "role", "parts"])
        XCTAssertEqual(message["id"] as? String, "msg-1")
        XCTAssertEqual(message["role"] as? String, "user")
        let parts = try XCTUnwrap(message["parts"] as? [[String: String]])
        XCTAssertEqual(parts, [["type": "text", "text": "hello"]])
    }

    func testSendBodyBytesAreSortedKeys() async throws {
        reply(200)
        _ = try await collect(client().send(text: "hello", messageID: "msg-1", conversationID: "conv-1"))
        let request = try XCTUnwrap(requests.first)
        let expected = #"{"id":"conv-1","message":{"id":"msg-1","parts":[{"text":"hello","type":"text"}],"role":"user"},"origin":"web_text"}"#
        XCTAssertEqual(String(decoding: request.body, as: UTF8.self), expected)
    }

    func testSendOmitsIDKeyWhenConversationIDIsNil() async throws {
        reply(200)
        _ = try await collect(client().send(text: "hello", messageID: "msg-1"))
        let body = try jsonBody(XCTUnwrap(requests.first))
        XCTAssertNil(body["id"])
        XCTAssertEqual(Set(body.keys), ["message", "origin"])
    }

    func testSendCarriesAWorkflowID() async throws {
        reply(200)
        _ = try await collect(client().send(text: "hello", messageID: "msg-1", origin: .voice, workflowID: "wf-1"))
        let body = try jsonBody(XCTUnwrap(requests.first))
        XCTAssertEqual(body["workflowId"] as? String, "wf-1")
    }

    func testSendVoiceOriginSendsWebVoice() async throws {
        reply(200)
        _ = try await collect(client().send(text: "hello", messageID: "msg-1", origin: .voice))
        let body = try jsonBody(XCTUnwrap(requests.first))
        XCTAssertEqual(body["origin"] as? String, "web_voice")
    }

    func testSendTrailingSlashOnBaseURLIsHarmless() async throws {
        reply(200)
        _ = try await collect(client(base: URL(string: "https://example.invalid/")).send(text: "hello", messageID: "msg-1"))
        XCTAssertEqual(requests.first?.url?.absoluteString, "https://example.invalid/api/chat")
    }

    func testSendNilAndEmptyTokenThrowUnauthenticatedWithoutRequest() async throws {
        reply(200)
        let nilError = await sendError(try client(token: nil))
        XCTAssertEqual(nilError as? ApiError, .unauthenticated)
        let emptyError = await sendError(try client(token: ""))
        XCTAssertEqual(emptyError as? ApiError, .unauthenticated)
        XCTAssertEqual(requests.count, 0)
    }

    func testSendEmptyOrBlankTextAndEmptyMessageIDThrowInvalidRequestWithoutRequest() async throws {
        reply(200)
        let empty = await sendError(try client(), text: "")
        XCTAssertEqual(empty as? ApiError, .invalidRequest)
        let blank = await sendError(try client(), text: "  \n\t ")
        XCTAssertEqual(blank as? ApiError, .invalidRequest)
        let noID = await sendError(try client(), messageID: "")
        XCTAssertEqual(noID as? ApiError, .invalidRequest)
        XCTAssertEqual(requests.count, 0)
    }

    func testSendTextIsSentUntrimmed() async throws {
        reply(200)
        _ = try await collect(client().send(text: "  hello \n", messageID: "msg-1"))
        let body = try jsonBody(XCTUnwrap(requests.first))
        let message = try XCTUnwrap(body["message"] as? [String: Any])
        let parts = try XCTUnwrap(message["parts"] as? [[String: String]])
        XCTAssertEqual(parts.first?["text"], "  hello \n")
    }

    func testSendStreamsRealisticReplySplitAcrossChunks() async throws {
        reply(200, headers: ["Content-Type": "text/event-stream"], [
            "data: {\"type\":\"start\",\"messageId\":\"asst-1\"}\n\ndata: {\"type\":\"text-st",
            "art\",\"id\":\"t1\"}\n\ndata: {\"type\":\"text-delta\",\"id\":\"t1\",\"delta\":\"Hel\"}\n",
            "\ndata: {\"type\":\"text-delta\",\"id\":\"t1\",\"delta\":\"lo\"}\n\ndata: {\"type\":\"text-end\",\"id\":\"t1\"}\n\n",
            "data: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n"
        ])
        let events = try await collect(client().send(text: "hi", messageID: "msg-1"))
        XCTAssertEqual(events, [
            .messageStart(messageID: "asst-1", conversationID: nil, title: nil),
            .textStart(id: "t1"),
            .textDelta(id: "t1", delta: "Hel"),
            .textDelta(id: "t1", delta: "lo"),
            .textEnd(id: "t1"),
            .finish(conversationID: nil, title: nil),
            .done
        ])
    }

    func testSendStreamFinishesAfterLastEventIncludingUnterminatedBlock() async throws {
        reply(200, ["data: {\"type\":\"finish\"}\n\ndata: [DONE]"])
        var iterator = try client().send(text: "hi", messageID: "msg-1").makeAsyncIterator()
        let first = try await iterator.next()
        XCTAssertEqual(first, .finish(conversationID: nil, title: nil))
        let second = try await iterator.next()
        XCTAssertEqual(second, .done)
        let end = try await iterator.next()
        XCTAssertNil(end)
    }

    func testSendHTTPErrorsMapToApiErrors() async throws {
        reply(401, [#"{"error":{"code":"unauthorized"}}"#])
        let unauthorized = await sendError(try client())
        XCTAssertEqual(unauthorized as? ApiError, .unauthenticated)
        reply(429, headers: ["Retry-After": "30"])
        let limited = await sendError(try client())
        XCTAssertEqual(limited as? ApiError, .rateLimited(retryAfterSeconds: 30))
        reply(503, [#"{"error":{"code":"out_of_credit"}}"#])
        let credit = await sendError(try client())
        XCTAssertEqual(credit as? ApiError, .outOfCredit)
        reply(502)
        let upstream = await sendError(try client())
        XCTAssertEqual(upstream as? ApiError, .upstream)
    }

    func testSendRateLimitWithoutRetryAfterHasNilSeconds() async throws {
        reply(429)
        let error = await sendError(try client())
        XCTAssertEqual(error as? ApiError, .rateLimited(retryAfterSeconds: nil))
    }

    func testSendTransportErrorsMapToApiErrors() async throws {
        stub.reset(.failure(.notConnectedToInternet))
        let offline = await sendError(try client())
        XCTAssertEqual(offline as? ApiError, .offline)
        stub.reset(.failure(.timedOut))
        let timedOut = await sendError(try client())
        XCTAssertEqual(timedOut as? ApiError, .upstream)
    }

    func testSendErrorBodyLargerThanLimitStillMaps() async throws {
        let json = #"{"error":{"code":"out_of_credit"}}"#
        let padding = String(repeating: " ", count: 40_000)
        reply(503, [json + padding, padding, padding])
        let error = await sendError(try client())
        XCTAssertEqual(error as? ApiError, .outOfCredit)
        reply(502, [String(repeating: "x", count: 100_000)])
        let upstream = await sendError(try client())
        XCTAssertEqual(upstream as? ApiError, .upstream)
    }

    func testSendThrownErrorsAreAlwaysApiError() async throws {
        let failures: [StubReply] = [
            .failure(.cannotParseResponse),
            .failure(.badServerResponse),
            .failure(.networkConnectionLost),
            .response(status: 418, headers: [:], chunks: []),
            .response(status: 500, headers: [:], chunks: [Data("oops".utf8)])
        ]
        var mapped: [ApiError] = []
        for failure in failures {
            stub.reset(failure)
            let error = await sendError(try client())
            XCTAssertTrue(error is ApiError, "\(String(describing: error))")
            if let apiError = error as? ApiError {
                mapped.append(apiError)
            }
        }
        XCTAssertEqual(mapped, [.unknown(status: 0), .unknown(status: 0), .offline, .unknown(status: 418), .server])
    }

    func testSendCancellingConsumerEndsStreamWithoutApiError() async throws {
        reply(200, ["data: {\"type\":\"finish\"}\n\n"])
        let stream = try client().send(text: "hi", messageID: "msg-1")
        let task = Task { () -> String in
            do {
                for try await _ in stream {}
                return "finished"
            } catch {
                return "threw \(error)"
            }
        }
        task.cancel()
        let outcome = await task.value
        XCTAssertEqual(outcome, "finished")
    }

    private func stopError(_ client: ChatClient, messageID: String = "msg-1") async -> Error? {
        do {
            _ = try await client.stop(messageID: messageID)
            return nil
        } catch {
            return error
        }
    }

    func testStopReturnsTrueAndSendsExactRequest() async throws {
        reply(200, [#"{"stopped":true}"#])
        let stopped = try await client().stop(messageID: "msg-1")
        XCTAssertTrue(stopped)
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/api/chat/stop")
        XCTAssertEqual(request.headers["Authorization"], "Bearer access-1")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(String(decoding: request.body, as: UTF8.self), #"{"messageId":"msg-1"}"#)
    }

    func testStopReturnsFalseWhenServerSaysNotStopped() async throws {
        reply(200, [#"{"stopped":false}"#])
        let stopped = try await client().stop(messageID: "msg-2")
        XCTAssertFalse(stopped)
        let body = try jsonBody(XCTUnwrap(requests.first))
        XCTAssertEqual(body["messageId"] as? String, "msg-2")
    }

    func testStopNilTokenAndEmptyMessageIDThrowWithoutRequest() async throws {
        reply(200, [#"{"stopped":true}"#])
        let noToken = await stopError(try client(token: nil))
        XCTAssertEqual(noToken as? ApiError, .unauthenticated)
        let emptyToken = await stopError(try client(token: ""))
        XCTAssertEqual(emptyToken as? ApiError, .unauthenticated)
        let noID = await stopError(try client(), messageID: "")
        XCTAssertEqual(noID as? ApiError, .invalidRequest)
        XCTAssertEqual(requests.count, 0)
    }

    func testStopHTTPErrorsMapToApiErrors() async throws {
        reply(401)
        let unauthorized = await stopError(try client())
        XCTAssertEqual(unauthorized as? ApiError, .unauthenticated)
        reply(404, [#"{"error":{"code":"not_found"}}"#])
        let missing = await stopError(try client())
        XCTAssertEqual(missing as? ApiError, .notFound)
        reply(429, headers: ["Retry-After": "30"])
        let limited = await stopError(try client())
        XCTAssertEqual(limited as? ApiError, .rateLimited(retryAfterSeconds: 30))
    }

    func testStopUndecodableSuccessBodyThrowsUnknownWithStatus() async throws {
        reply(200, [#"{"ok":true}"#])
        let wrongShape = await stopError(try client())
        XCTAssertEqual(wrongShape as? ApiError, .unknown(status: 200))
        reply(202, ["not json"])
        let notJSON = await stopError(try client())
        XCTAssertEqual(notJSON as? ApiError, .unknown(status: 202))
    }

    func testStopTransportErrorMapsToApiError() async throws {
        stub.reset(.failure(.notConnectedToInternet))
        let offline = await stopError(try client())
        XCTAssertEqual(offline as? ApiError, .offline)
        stub.reset(.failure(.timedOut))
        let timedOut = await stopError(try client())
        XCTAssertEqual(timedOut as? ApiError, .upstream)
    }

    func testSendNon200SuccessStatusStreamsEvents() async throws {
        reply(201, ["data: {\"type\":\"start\",\"messageId\":\"asst-1\"}\n\ndata: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n"])
        let events = try await collect(client().send(text: "hi", messageID: "msg-1"))
        XCTAssertEqual(events, [.messageStart(messageID: "asst-1", conversationID: nil, title: nil), .finish(conversationID: nil, title: nil), .done])
    }

    func testStopNon200SuccessStatusReturnsDecodedValue() async throws {
        reply(201, [#"{"stopped":true}"#])
        let stopped = try await client().stop(messageID: "msg-1")
        XCTAssertTrue(stopped)
    }

    func testSendYieldsFirstEventBeforeRestOfBodyArrives() async throws {
        let release = DispatchSemaphore(value: 0)
        stub.reset(.paused(
            status: 200,
            first: Data("data: {\"type\":\"start\",\"messageId\":\"asst-1\"}\n\n".utf8),
            rest: [Data("data: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n".utf8)],
            release: release
        ))
        let stream = try client().send(text: "hi", messageID: "msg-1")
        let box = EventBox()
        let consumer = Task {
            for try await event in stream {
                box.append(event)
            }
        }
        // Whatever happens below, never leave the stub's background block waiting.
        addTeardownBlock {
            release.signal()
            consumer.cancel()
        }
        let deadline = Date().addingTimeInterval(2)
        while box.events.isEmpty && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let beforeRelease = box.events
        release.signal()
        try await consumer.value
        XCTAssertEqual(beforeRelease, [.messageStart(messageID: "asst-1", conversationID: nil, title: nil)], "first event must arrive before the stub is released")
        XCTAssertEqual(box.events, [.messageStart(messageID: "asst-1", conversationID: nil, title: nil), .finish(conversationID: nil, title: nil), .done])
    }
}
