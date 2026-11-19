import XCTest
@testable import BobKit

final class PasswordResetTests: XCTestCase {
    private func client() -> SupabaseAuthClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProductivityStub.self]
        return SupabaseAuthClient(apiBaseURL: URL(string: "https://app.example.test")!, session: URLSession(configuration: configuration))
    }
    override func setUp() {
        ProductivityStub.reset()
        ProductivityStub.route("GET /api/public-config", 200, #"{"supabaseUrl":"https://auth.example.test","supabasePublishableKey":"pub"}"#)
    }
    func testResetUsesAccountEmailAndSameDeploymentRecoveryPageWithoutSessionMutation() async throws {
        ProductivityStub.route("POST /auth/v1/recover", 200, "{}")
        try await client().requestPasswordReset(email: " test@example.test ")
        XCTAssertEqual(ProductivityStub.last?.body?["email"] as? String, "test@example.test")
        let query = try XCTUnwrap(ProductivityStub.last?.query)
        XCTAssertEqual(URLComponents(string: "https://example.test?" + query)?.queryItems?.first(where: { $0.name == "redirect_to" })?.value, "https://app.example.test/reset")
        XCTAssertNil(ProductivityStub.last?.auth)
        XCTAssertEqual(ProductivityStub.all.count, 2)
    }
    func testRateLimitDoesNotClaimEmailWasSent() async {
        ProductivityStub.route("POST /auth/v1/recover", 429, #"{"error_code":"over_email_send_rate_limit"}"#)
        do { try await client().requestPasswordReset(email: "test@example.test"); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? SignInError, .emailCap) }
    }
    func testInvalidEmailDoesNotMakeARequest() async {
        do { try await client().requestPasswordReset(email: " "); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? SignInError, .failed) }
        XCTAssertTrue(ProductivityStub.all.isEmpty)
    }
}
