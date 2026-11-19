import XCTest
@testable import BobKit

private let reviewInstallation = "11111111-1111-4111-8111-111111111111"
private let reviewCampaign = "22222222-2222-4222-8222-222222222222"
private let reviewMutation = "44444444-4444-4444-8444-444444444444"
private let reviewHash = String(repeating: "a", count: 64)
private let reviewPath = "/api/bob-apps/marketing/installations/\(reviewInstallation)/campaigns/\(reviewCampaign)/review"
private func reviewJSON(revision: Int = 3, canApprove: Bool = true, approved: Bool = false) -> String {
    let decision = #"{"id":"33333333-3333-4333-8333-333333333333","snapshotHash":"\#(reviewHash)","reviewRevision":\#(revision),"author":{"id":"\#(reviewMutation)","label":"Alex"},"createdAt":1700000000000}"#
    return #"{"installationId":"\#(reviewInstallation)","campaignId":"\#(reviewCampaign)","state":"\#(approved ? "approved" : "needs_review")","reviewRevision":\#(revision),"snapshotHash":"\#(reviewHash)","lifecycleGeneration":0,"packRevision":"\#(reviewHash)","canApprove":\#(canApprove),"snapshot":{"campaign":{"id":"\#(reviewCampaign)","installationId":"\#(reviewInstallation)","name":"Launch","goal":"awareness","goalNote":null,"channels":["instagram","linkedin"],"status":"draft","revision":2,"draftCount":1,"updatedAt":1700000000000,"sections":[{"section":"idea","content":"Make people smile"}]},"drafts":[{"id":"33333333-3333-4333-8333-333333333333","campaignId":"\#(reviewCampaign)","channel":"linkedin","format":"text","body":"A complete saved post","altText":null,"pillar":null,"approvedAssetIds":[],"claimIds":[],"cta":"none","state":"needs_check","contentRevision":4,"packRevision":"\#(reviewHash)","createdAt":1700000000000,"updatedAt":1700000000000}]},"notes":[{"id":"\#(reviewMutation)","text":"Keep our tone friendly","author":null,"createdAt":1700000000000}],"approval":\#(approved ? decision : "null"),"history":[\#(decision)]}"#
}
private func reviewClient(token: String? = "token") -> MarketingReviewClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ProductivityStub.self]
    return MarketingReviewClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { token })
}
private func readRoute(_ json: String = reviewJSON()) { ProductivityStub.route("GET \(reviewPath)", 200, "{\"review\":\(json)}") }
private func approveRoute(_ json: String = reviewJSON(approved: true), receiptInstallation: String = reviewInstallation) {
    ProductivityStub.route("POST \(reviewPath)/approve", 200, #"{"receipt":{"kind":"review.approved","installationId":"\#(receiptInstallation)","campaignId":"\#(reviewCampaign)","approvalId":"33333333-3333-4333-8333-333333333333"},"review":\#(json)}"#)
}

final class MarketingReviewClientTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    func testAuthenticatedCompleteSnapshotIncludesNotesHistoryAndMilliseconds() async throws {
        readRoute()
        let review = try await reviewClient().read(installationID: reviewInstallation, campaignID: reviewCampaign)
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer token")
        XCTAssertNil(ProductivityStub.last?.query)
        XCTAssertEqual(review.snapshot.drafts.first?.channel, .linkedin)
        XCTAssertEqual(review.notes.first?.text, "Keep our tone friendly")
        XCTAssertNil(review.notes.first?.author)
        XCTAssertEqual(review.history.first?.createdAt, Date(timeIntervalSince1970: 1700000000))
    }
    func testApprovalPinsSnapshotRevisionAndMutationWithoutExtraAuthority() async throws {
        approveRoute()
        _ = try await reviewClient().approve(installationID: reviewInstallation, campaignID: reviewCampaign, revision: 3, snapshotHash: reviewHash, mutationID: reviewMutation)
        XCTAssertEqual(Set(ProductivityStub.last?.body?.keys.map { $0 } ?? []), ["expectedReviewRevision", "snapshotHash", "mutationId"])
        XCTAssertEqual(ProductivityStub.last?.body?["expectedReviewRevision"] as? Int, 3)
        XCTAssertEqual(ProductivityStub.last?.body?["snapshotHash"] as? String, reviewHash)
        XCTAssertEqual(ProductivityStub.last?.body?["mutationId"] as? String, reviewMutation)
    }
    func testNoAuthenticationMakesNoRequest() async {
        do { _ = try await reviewClient(token: nil).read(installationID: reviewInstallation, campaignID: reviewCampaign); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testMismatchedReceiptNeverConfirmsApproval() async {
        approveRoute(receiptInstallation: reviewMutation)
        do { _ = try await reviewClient().approve(installationID: reviewInstallation, campaignID: reviewCampaign, revision: 3, snapshotHash: reviewHash, mutationID: reviewMutation); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
    }
    func testSnapshotFromAnotherCampaignIsRejected() async {
        readRoute(reviewJSON().replacingOccurrences(of: reviewCampaign, with: reviewMutation))
        do { _ = try await reviewClient().read(installationID: reviewInstallation, campaignID: reviewCampaign); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
    }
    func testInvalidApprovalNeverReachesNetwork() async {
        do { _ = try await reviewClient().approve(installationID: reviewInstallation, campaignID: reviewCampaign, revision: 0, snapshotHash: "bad", mutationID: reviewMutation); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertNil(ProductivityStub.last)
    }
}

@MainActor final class MarketingReviewModelTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func model() -> MarketingReviewModel { MarketingReviewModel(installationID: reviewInstallation, campaignID: reviewCampaign, service: reviewClient()) }
    func testReadOnlyMemberCannotApprove() async {
        readRoute(reviewJSON(canApprove: false))
        let model = model(); await model.refresh()
        XCTAssertFalse(model.canApprove)
        await model.approve()
        XCTAssertEqual(ProductivityStub.last?.method, "GET")
    }
    func testUncertainApprovalRetryRetainsSameMutationAndSnapshot() async {
        readRoute(); let model = model(); await model.refresh()
        ProductivityStub.route("POST \(reviewPath)/approve", 503, "{}")
        await model.approve()
        let first = ProductivityStub.last?.body
        approveRoute(); await model.approve()
        XCTAssertEqual(ProductivityStub.last?.body?["mutationId"] as? String, first?["mutationId"] as? String)
        XCTAssertEqual(model.review?.state, .approved)
        XCTAssertFalse(model.canApprove)
    }
    func testConflictKeepsReviewedPlanAndNotesUntilExplicitRefresh() async {
        readRoute(); let model = model(); await model.refresh()
        ProductivityStub.route("POST \(reviewPath)/approve", 409, #"{"error":{"code":"review_conflict"}}"#)
        await model.approve()
        XCTAssertTrue(model.changed)
        XCTAssertFalse(model.canApprove)
        XCTAssertEqual(model.review?.notes.first?.text, "Keep our tone friendly")
        readRoute(reviewJSON(revision: 4)); await model.refresh()
        XCTAssertFalse(model.changed)
        XCTAssertEqual(model.review?.reviewRevision, 4)
    }
    func testForegroundCheckDoesNotSilentlyAdoptChangedSnapshot() async {
        readRoute(); let model = model(); await model.refresh()
        readRoute(reviewJSON(revision: 4)); await model.checkForChanges()
        XCTAssertTrue(model.changed)
        XCTAssertEqual(model.review?.reviewRevision, 3)
        XCTAssertFalse(model.canApprove)
    }
    func testAccessLossBlocksApprovalWithoutDiscardingSavedNotes() async {
        readRoute(); let model = model(); await model.refresh()
        ProductivityStub.route("GET \(reviewPath)", 403, "{}")
        await model.checkForChanges()
        XCTAssertFalse(model.canApprove)
        XCTAssertTrue(model.changed)
        XCTAssertEqual(model.review?.notes.count, 1)
    }
    func testReceiptForNewerPlanDoesNotShowOldPlanAsApproved() async {
        readRoute(); let model = model(); await model.refresh()
        approveRoute(reviewJSON(revision: 4)); await model.approve()
        XCTAssertTrue(model.changed)
        XCTAssertEqual(model.review?.reviewRevision, 3)
        XCTAssertEqual(model.review?.state, .needsReview)
    }
}

private actor SuspendedReviewService: MarketingReviewService {
    private var readContinuation: CheckedContinuation<MarketingReview, Error>?
    func read(installationID: String, campaignID: String) async throws -> MarketingReview {
        try await withCheckedThrowingContinuation { readContinuation = $0 }
    }
    func waitUntilReading() async { while readContinuation == nil { await Task.yield() } }
    func finish(_ value: MarketingReview) { readContinuation?.resume(returning: value); readContinuation = nil }
    func approve(installationID: String, campaignID: String, revision: Int, snapshotHash: String, mutationID: String) async throws -> MarketingReview { throw ApiError.invalidRequest }
}

@MainActor final class MarketingReviewLifecycleTests: XCTestCase {
    func testCancelledScreenDoesNotAdoptLateSnapshot() async throws {
        let service = SuspendedReviewService()
        let model = MarketingReviewModel(installationID: reviewInstallation, campaignID: reviewCampaign, service: service)
        let pending = Task { await model.refresh() }
        await service.waitUntilReading()
        model.cancel()
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        let value = try decoder.decode(MarketingReview.self, from: Data(reviewJSON().utf8))
        await service.finish(value)
        await pending.value
        XCTAssertNil(model.review)
        XCTAssertFalse(model.loading)
        XCTAssertFalse(model.canApprove)
    }
}
