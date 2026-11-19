import XCTest
@testable import BobKit

final class GoogleAuthorizationTests: XCTestCase {
    private let state = String(repeating: "s", count: 43)
    private let attemptID = "11111111-1111-4111-8111-111111111111"
    override func setUp() { ProductivityStub.reset() }

    func testProofUsesRFC7636S256AndFreshRandomValues() throws {
        let proof = try GoogleAuthorizationProof(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(proof.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let first = GoogleAuthorizationProof.random()
        let second = GoogleAuthorizationProof.random()
        XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertEqual(first.verifier.count, 43)
        XCTAssertEqual(first.challenge.count, 43)
        XCTAssertThrowsError(try GoogleAuthorizationProof(verifier: "short"))
    }

    func testCallbackRequiresExactRouteStateAndKnownSingleFields() throws {
        let valid = "xyz.heybob.oauth://google/callback?state=\(state)&outcome=returned"
        XCTAssertEqual(try GoogleAuthorizationCallback.parse(URL(string: valid)!, expectedState: state), .returned)
        for invalid in [
            valid.replacingOccurrences(of: "xyz.heybob.oauth:", with: "https:"),
            valid.replacingOccurrences(of: "google/", with: "evil/"),
            valid.replacingOccurrences(of: "/callback?", with: "/callback/extra?"),
            valid.replacingOccurrences(of: "/callback?", with: "/%63allback?"),
            valid.replacingOccurrences(of: "google/", with: "user@google/"),
            valid.replacingOccurrences(of: "google/", with: "google:123/"),
            valid + "&state=\(state)", valid + "&code=secret", valid + "#fragment",
            valid.replacingOccurrences(of: "returned", with: "success"),
            valid.replacingOccurrences(of: state, with: String(repeating: "x", count: 43))
        ] { XCTAssertThrowsError(try GoogleAuthorizationCallback.parse(URL(string: invalid)!, expectedState: state), invalid) }
    }

    func testAuthorizeUsesAuthenticatedBodyWithoutVerifierOrOriginAndDecodesMilliseconds() async throws {
        ProductivityStub.route("POST /api/google-accounts/native/authorize", 200, "{\"attemptId\":\"\(attemptID)\",\"state\":\"\(state)\",\"url\":\"https://provider.test/consent\",\"expiresAt\":1700000600000}")
        let attempt = try await client().authorize(capabilities: [.calendarRead, .mailSend], reconnectAccountID: attemptID, challenge: String(repeating: "c", count: 43))
        XCTAssertEqual(attempt.expiresAt, Date(timeIntervalSince1970: 1700000600))
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer token")
        XCTAssertEqual(ProductivityStub.last?.body?["capabilities"] as? [String], ["calendar.read", "gmail.send"])
        XCTAssertNil(ProductivityStub.last?.body?["codeVerifier"])
    }

    func testAuthorizeRejectsUnsafeProviderURLAndInvalidChoices() async throws {
        ProductivityStub.route("POST /api/google-accounts/native/authorize", 200, "{\"attemptId\":\"\(attemptID)\",\"state\":\"\(state)\",\"url\":\"http://provider.test/consent\",\"expiresAt\":1700000600000}")
        do { _ = try await client().authorize(capabilities: [.calendarRead], reconnectAccountID: nil, challenge: String(repeating: "c", count: 43)); XCTFail() } catch {}
        ProductivityStub.reset()
        do { _ = try await client().authorize(capabilities: [], reconnectAccountID: nil, challenge: String(repeating: "c", count: 43)); XCTFail() } catch {}
        XCTAssertNil(ProductivityStub.last)
    }

    func testCompleteAndCancelSendProofInBodyAndBoundProcessingDelay() async throws {
        let proof = try GoogleAuthorizationProof(verifier: String(repeating: "v", count: 43))
        let attempt = GoogleAuthorizationAttempt(id: attemptID, state: state, url: URL(string: "https://provider.test")!, expiresAt: Date())
        ProductivityStub.route("POST /api/google-accounts/native/complete", 202, #"{"status":"processing","retryAfterMs":1000}"#)
        let processing = try await client().complete(attempt: attempt, proof: proof)
        XCTAssertEqual(processing, .processing(retryAfterMilliseconds: 1000))
        XCTAssertEqual(ProductivityStub.last?.body?["codeVerifier"] as? String, proof.verifier)
        XCTAssertNil(ProductivityStub.last?.query)
        ProductivityStub.route("POST /api/google-accounts/native/cancel", 200, #"{"status":"cancelled"}"#)
        let cancelled = try await client().cancel(attempt: attempt, proof: proof)
        XCTAssertEqual(cancelled, .cancelled)
        ProductivityStub.route("POST /api/google-accounts/native/complete", 202, #"{"status":"processing","retryAfterMs":999999}"#)
        do { _ = try await client().complete(attempt: attempt, proof: proof); XCTFail() } catch {}
    }

    private func client() -> GoogleAuthorizationClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProductivityStub.self]
        return GoogleAuthorizationClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { "token" })
    }
}
