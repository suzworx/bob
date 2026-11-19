import Foundation
import XCTest
@testable import BobKit

final class ApiErrorTests: XCTestCase {
    private func body(code: String) -> Data {
        Data("{\"error\":{\"code\":\"\(code)\",\"message\":\"server text 42\"}}".utf8)
    }

    private func map(_ status: Int, _ body: Data? = nil, retryAfter: String? = nil) -> ApiError {
        ApiErrorMapper.map(status: status, body: body, retryAfter: retryAfter)
    }

    private let allCases: [ApiError] = [
        .unauthenticated, .invalidRequest, .notFound, .audioTooLarge, .noSpeechDetected,
        .unsupportedAudio, .rateLimited(retryAfterSeconds: 5), .rateLimited(retryAfterSeconds: nil),
        .outOfCredit, .upstream, .server, .offline, .cancelled, .unknown(status: 0),
        .unknown(status: 404), .unknown(status: 500)
    ]

    func testStatus401IsUnauthenticated() {
        XCTAssertEqual(map(401), .unauthenticated)
        XCTAssertEqual(map(401, body(code: "anything")), .unauthenticated)
    }

    func testStatus400WithAudioCodesIsUnsupportedAudio() {
        XCTAssertEqual(map(400, body(code: "unsupported_format")), .unsupportedAudio)
        XCTAssertEqual(map(400, body(code: "invalid_audio")), .unsupportedAudio)
    }

    func testStatus400WithOtherOrMissingCodeIsInvalidRequest() {
        XCTAssertEqual(map(400, body(code: "bad_field")), .invalidRequest)
        XCTAssertEqual(map(400, body(code: "")), .invalidRequest)
        XCTAssertEqual(map(400, Data("{\"error\":{\"message\":\"x\"}}".utf8)), .invalidRequest)
        XCTAssertEqual(map(400), .invalidRequest)
    }

    func testMemoryCodesHaveTheirOwnKinds() {
        XCTAssertEqual(map(422, body(code: "secret_refused")), .secretRefused)
        XCTAssertEqual(map(422, body(code: "other")), .invalidRequest)
        XCTAssertEqual(map(503, body(code: "memory_unavailable")), .memoryUnavailable)
        XCTAssertEqual(map(503, body(code: "other")), .server)
    }

    func testStatus404IsNotFound() {
        XCTAssertEqual(map(404), .notFound)
    }

    func testStatus413IsAudioTooLargeOnlyForTheAudioCode() {
        XCTAssertEqual(map(413, body(code: "audio_too_large")), .audioTooLarge)
    }

    func testStatus413ForAnyOtherBodyIsAnInvalidRequest() {
        XCTAssertEqual(map(413, body(code: "invalid_request")), .invalidRequest)
        XCTAssertEqual(map(413), .invalidRequest)
        XCTAssertEqual(map(413, body(code: "")), .invalidRequest)
        XCTAssertEqual(map(413, Data("not json".utf8)), .invalidRequest)
    }

    func testStreamErrorTextMapsOnlyOutOfCreditToOutOfCredit() {
        XCTAssertEqual(ApiErrorMapper.mapStreamError(errorText: "out_of_credit"), .outOfCredit)
        XCTAssertEqual(ApiErrorMapper.mapStreamError(errorText: "The assistant could not complete that request."), .upstream)
        XCTAssertEqual(ApiErrorMapper.mapStreamError(errorText: nil), .upstream)
        XCTAssertEqual(ApiErrorMapper.mapStreamError(errorText: ""), .upstream)
    }

    func testStatus422WithNoSpeechCodeIsNoSpeechDetected() {
        XCTAssertEqual(map(422, body(code: "no_speech_detected")), .noSpeechDetected)
    }

    func testStatus422WithOtherOrMissingCodeIsInvalidRequest() {
        XCTAssertEqual(map(422, body(code: "invalid_audio")), .invalidRequest)
        XCTAssertEqual(map(422, body(code: "")), .invalidRequest)
        XCTAssertEqual(map(422), .invalidRequest)
    }

    func testStatus503WithOutOfCreditCodeIsOutOfCredit() {
        XCTAssertEqual(map(503, body(code: "out_of_credit")), .outOfCredit)
    }

    func testStatus503WithOtherOrMissingCodeIsServer() {
        XCTAssertEqual(map(503, body(code: "maintenance")), .server)
        XCTAssertEqual(map(503, body(code: "")), .server)
        XCTAssertEqual(map(503), .server)
    }

    func testStatus502IsUpstreamAndOther5xxIsServer() {
        XCTAssertEqual(map(502), .upstream)
        XCTAssertEqual(map(502, body(code: "out_of_credit")), .upstream)
        XCTAssertEqual(map(500), .server)
        XCTAssertEqual(map(504), .server)
        XCTAssertEqual(map(599), .server)
    }

    func testOtherStatusesAreUnknown() {
        XCTAssertEqual(map(200), .unknown(status: 200))
        XCTAssertEqual(map(403), .forbidden)
        XCTAssertEqual(map(418), .unknown(status: 418))
        XCTAssertEqual(map(600), .unknown(status: 600))
        XCTAssertEqual(map(0), .unknown(status: 0))
    }

    func testMalformedEmptyAndNilBodiesGiveStatusOnlyResult() {
        let bodies: [Data?] = [
            Data("not json".utf8),
            Data("[1,2]".utf8),
            Data("{\"error\":\"no_speech_detected\"}".utf8),
            Data("{\"error\":{\"code\":7}}".utf8),
            Data(),
            nil
        ]
        for data in bodies {
            XCTAssertEqual(map(422, data), .invalidRequest)
            XCTAssertEqual(map(400, data), .invalidRequest)
            XCTAssertEqual(map(503, data), .server)
        }
    }

    func testRetryAfterParsing() {
        let cases: [(String?, Int?)] = [
            ("30", 30), ("0", 0), ("abc", nil), ("", nil), ("-5", nil),
            ("1.5", nil), ("99999999999999999999", nil), ("+5", nil), (" 5", nil), (nil, nil)
        ]
        for (header, expected) in cases {
            XCTAssertEqual(map(429, retryAfter: header), .rateLimited(retryAfterSeconds: expected), "\(String(describing: header))")
        }
    }

    func testMapTransportTable() {
        let cases: [(URLError.Code, ApiError)] = [
            (.notConnectedToInternet, .offline),
            (.networkConnectionLost, .offline),
            (.dataNotAllowed, .offline),
            (.internationalRoamingOff, .offline),
            (.cannotFindHost, .offline),
            (.cannotConnectToHost, .offline),
            (.dnsLookupFailed, .offline),
            (.timedOut, .upstream),
            (.cancelled, .cancelled),
            (.badURL, .unknown(status: 0)),
            (.secureConnectionFailed, .unknown(status: 0))
        ]
        for (code, expected) in cases {
            XCTAssertEqual(ApiErrorMapper.mapTransport(code), expected, "\(code.rawValue)")
        }
    }

    func testUserMessageTable() {
        let cases: [(ApiError, String)] = [
            (.unauthenticated, "Please sign in again."),
            (.invalidRequest, "Bob couldn't read that. Try again."),
            (.notFound, "That isn't there any more."),
            (.audioTooLarge, "That recording was too long. Try a shorter one."),
            (.noSpeechDetected, "I didn't catch that."),
            (.unsupportedAudio, "I couldn't read that recording. Try again."),
            (.rateLimited(retryAfterSeconds: 30), "Bob needs a short break. Try again in a moment."),
            (.rateLimited(retryAfterSeconds: nil), "Bob needs a short break. Try again in a moment."),
            (.outOfCredit, "Bob is out of credit right now."),
            (.upstream, "Bob had trouble. Try again."),
            (.server, "Something went wrong on our side. Try again."),
            (.offline, "You're offline. Try again when you're back."),
            (.cancelled, ""),
            (.unknown(status: 418), "Something went wrong. Try again.")
        ]
        for (error, expected) in cases {
            XCTAssertEqual(ApiErrorMapper.userMessage(error), expected, "\(error)")
        }
    }

    func testUserMessagesHaveNoDigitsOrTechnicalWords() {
        for error in allCases {
            let message = ApiErrorMapper.userMessage(error)
            XCTAssertNil(message.rangeOfCharacter(from: .decimalDigits), "\(error)")
            XCTAssertFalse(message.lowercased().contains("error"), "\(error)")
            XCTAssertFalse(message.lowercased().contains("status"), "\(error)")
        }
    }

    func testIsRetryableTable() {
        let cases: [(ApiError, Bool)] = [
            (.unauthenticated, false),
            (.invalidRequest, false),
            (.notFound, false),
            (.audioTooLarge, false),
            (.noSpeechDetected, false),
            (.unsupportedAudio, false),
            (.rateLimited(retryAfterSeconds: 5), true),
            (.rateLimited(retryAfterSeconds: nil), true),
            (.outOfCredit, false),
            (.upstream, true),
            (.server, true),
            (.offline, true),
            (.cancelled, false),
            (.unknown(status: 500), true),
            (.unknown(status: 599), true),
            (.unknown(status: 404), false),
            (.unknown(status: 0), false)
        ]
        for (error, expected) in cases {
            XCTAssertEqual(ApiErrorMapper.isRetryable(error), expected, "\(error)")
        }
    }
}
