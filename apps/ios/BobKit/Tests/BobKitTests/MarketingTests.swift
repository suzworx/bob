import XCTest
@testable import BobKit

private let marketingID = "11111111-1111-4111-8111-111111111111"
private let campaignID = "22222222-2222-4222-8222-222222222222"
private let draftID = "33333333-3333-4333-8333-333333333333"
private let mutationID = "44444444-4444-4444-8444-444444444444"
private let marketingInstallationJSON = #"{"id":"11111111-1111-4111-8111-111111111111","appId":"55555555-5555-4555-8555-555555555555","spaceId":null,"canManage":true,"state":"active","grantedCapabilities":["campaign.read","campaign.draft","campaign.configure"],"revision":3,"configRevision":2,"config":{"visibleViews":["campaign","content"],"contentGrouping":"none","defaultChannels":["instagram"]},"package":{"packageId":"bob-marketing","name":"Bob Marketing","version":"1"},"createdAt":1700000000000,"updatedAt":1700000001000}"#
private let marketingDraftJSON = #"{"id":"33333333-3333-4333-8333-333333333333","campaignId":"22222222-2222-4222-8222-222222222222","channel":"instagram","format":"image","body":"Make room for a smile","altText":null,"pillar":"Day 2 · Joy · A small win","approvedAssetIds":[],"claimIds":[],"cta":"none","state":"needs_check","contentRevision":4,"packRevision":"abc","createdAt":1700000000000,"updatedAt":1700000001000}"#

final class MarketingClientTests: XCTestCase {
    override func setUp() { ProductivityStub.reset() }
    private func client(token: String? = "tok") -> MarketingClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProductivityStub.self]
        return MarketingClient(baseURL: URL(string: "https://example.test")!, session: URLSession(configuration: config), accessToken: { token })
    }
    func testCatalogPreservesScopePermissionsAndAuthenticatedDates() async throws {
        ProductivityStub.route("GET /api/bob-apps/marketing/installations", 200, #"{"installations":[\#(marketingInstallationJSON)],"selectedInstallationId":null}"#)
        let rows = try await client().installations(spaceID: campaignID)
        XCTAssertEqual(rows.first?.canManage, true)
        XCTAssertEqual(rows.first?.updatedAt, Date(timeIntervalSince1970: 1700000001))
        XCTAssertEqual(ProductivityStub.last?.query, "spaceId=\(campaignID)")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
    }
    func testInstallAndLifecycleRetainMutationAndExpectedRevision() async throws {
        ProductivityStub.route("POST /api/bob-apps/marketing/install", 201, #"{"installation":\#(marketingInstallationJSON)}"#)
        let installed = try await client().install(spaceID: campaignID, mutationID: mutationID)
        XCTAssertEqual(ProductivityStub.last?.body?["spaceId"] as? String, campaignID)
        XCTAssertEqual(ProductivityStub.last?.body?["mutationId"] as? String, mutationID)
        ProductivityStub.route("POST /api/bob-apps/marketing/installations/\(marketingID)/lifecycle", 200, #"{"installation":\#(marketingInstallationJSON)}"#)
        _ = try await client().lifecycle(installed, operation: .pause, mutationID: mutationID)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedRevision"] as? Int, 3)
    }
    func testDraftPaginationPinsCampaignProjectionChannelAndCursor() async throws {
        ProductivityStub.route("GET /api/bob-apps/marketing/installations/\(marketingID)/drafts", 200, #"{"items":[\#(marketingDraftJSON)],"nextCursor":null}"#)
        let page = try await client().drafts(installationID: marketingID, campaignID: campaignID, channel: .instagram, cursor: draftID)
        XCTAssertEqual(page.items.first?.state, "needs_check")
        XCTAssertEqual(page.items.first?.week.day, 2)
        XCTAssertEqual(page.items.first?.week.beat, "A small win")
        XCTAssertEqual(ProductivityStub.last?.query, "campaignId=\(campaignID)&projection=content&channel=instagram&cursor=\(draftID)")
    }
    func testDraftSaveCarriesImmutableRevisionAndExplicitNullFields() async throws {
        ProductivityStub.route("PATCH /api/bob-apps/marketing/installations/\(marketingID)/drafts/\(draftID)", 200, "{}")
        try await client().saveDraft(installationID: marketingID, draftID: draftID, edit: MarketingDraftEdit(body: "Updated", altText: nil, pillar: nil, revision: 4), mutationID: mutationID)
        XCTAssertEqual(ProductivityStub.last?.body?["expectedContentRevision"] as? Int, 4)
        XCTAssertEqual(ProductivityStub.last?.body?["mutationId"] as? String, mutationID)
        XCTAssertTrue(ProductivityStub.last?.body?["altText"] is NSNull)
        XCTAssertTrue(ProductivityStub.last?.body?["pillar"] is NSNull)
    }
    func testDraftByteLimitsRejectBeforeNetwork() async {
        do { try await client().saveDraft(installationID: marketingID, draftID: draftID, edit: MarketingDraftEdit(body: String(repeating: "🙂", count: 2001), altText: nil, pillar: nil, revision: 4), mutationID: mutationID); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .invalidRequest) }
        XCTAssertNil(ProductivityStub.last)
    }
    func testConfigApplyPinsHashProposalRevisionAndMutation() async throws {
        ProductivityStub.route("POST /api/bob-apps/marketing/installations/\(marketingID)/config/apply", 200, "{}")
        try await client().configAction(installationID: marketingID, action: .apply(proposalID: draftID, hash: "reviewed-hash"), revision: 8, mutationID: mutationID)
        XCTAssertEqual(ProductivityStub.last?.body?["hash"] as? String, "reviewed-hash")
        XCTAssertEqual(ProductivityStub.last?.body?["expectedConfigRevision"] as? Int, 8)
        XCTAssertEqual(ProductivityStub.last?.body?["mutationId"] as? String, mutationID)
    }
    func testMissingAuthAndConflictsAreNotEmptySuccess() async {
        do { _ = try await client(token: nil).installations(spaceID: nil); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unauthenticated) }
        XCTAssertNil(ProductivityStub.last)
        ProductivityStub.route("GET /api/bob-apps/marketing/installations/\(marketingID)/config", 409, #"{"error":{"code":"conflict"}}"#)
        do { _ = try await client().config(installationID: marketingID); XCTFail() }
        catch { XCTAssertEqual(error as? ApiError, .unknown(status: 409)) }
    }
}

@MainActor final class MarketingStateTests: XCTestCase {
    func testUnconfirmedDraftSaveRetriesSamePayloadAndMutation() async throws {
        let service = MarketingModelService()
        let editor = MarketingDraftEditor(draft: try marketingDecode(MarketingDraft.self, marketingDraftJSON), installationID: marketingID, service: service)
        editor.body = "My edits"
        let first = await editor.save()
        XCTAssertFalse(first)
        XCTAssertEqual(editor.body, "My edits")
        editor.body = "A later change cannot alter a pending save"
        let retry = await editor.save()
        XCTAssertTrue(retry)
        let writes = await service.writes
        XCTAssertEqual(writes.count, 2)
        XCTAssertEqual(writes[0].0, writes[1].0)
        XCTAssertEqual(writes[0].1, writes[1].1)
        XCTAssertEqual(writes[1].0.body, "My edits")
    }
    func testConflictKeepsEditsUntilExplicitRebase() async throws {
        let service = MarketingModelService(conflicting: true)
        let editor = MarketingDraftEditor(draft: try marketingDecode(MarketingDraft.self, marketingDraftJSON), installationID: marketingID, service: service)
        editor.body = "My unsaved words"
        _ = await editor.save()
        XCTAssertTrue(editor.conflict)
        XCTAssertEqual(editor.body, "My unsaved words")
        XCTAssertEqual(editor.latest?.contentRevision, 5)
        _ = await editor.save()
        let countBeforeRebase = await service.writes.count
        XCTAssertEqual(countBeforeRebase, 1)
        editor.keepEditsAgainstLatest()
        XCTAssertEqual(editor.edit.revision, 5)
        XCTAssertFalse(editor.conflict)
        XCTAssertEqual(editor.body, "My unsaved words")
    }
    func testInstallationAudienceMismatchNeverExposesChatTarget() async {
        let model = MarketingWorkspaceModel(installationID: marketingID, spaceID: "other-space", service: MarketingModelService())
        await model.refresh()
        XCTAssertEqual(model.error, .notFound)
        XCTAssertFalse(model.ready)
        XCTAssertNil(model.target())
    }
    func testFreshNewTargetIsExplicitAndPausedAppCannotStartChat() async {
        let model = MarketingWorkspaceModel(installationID: marketingID, spaceID: nil, service: MarketingModelService())
        await model.refresh()
        XCTAssertTrue(model.ready)
        XCTAssertEqual(model.target()?.installationID, marketingID)
        XCTAssertNil(model.target()?.campaignID)
        await model.changeLifecycle(.pause)
        XCTAssertNil(model.target())
    }
    func testMissingCampaignDoesNotFallBackToNewForAWrite() async {
        let service = MarketingModelService()
        let model = MarketingWorkspaceModel(installationID: marketingID, spaceID: nil, service: service)
        await model.refresh()
        await model.select(campaignID)
        XCTAssertEqual(model.selectedCampaignID, campaignID)
        XCTAssertFalse(model.ready)
        XCTAssertNil(model.target())
        XCTAssertEqual(model.error, .offline)
    }
    func testReadOnlyConfigurationCannotApply() async throws {
        let installation = try marketingDecode(MarketingInstallation.self, marketingInstallationJSON.replacingOccurrences(of: "\"canManage\":true", with: "\"canManage\":false"))
        let service = MarketingModelService()
        let model = MarketingConfigModel(installation: installation, service: service)
        await model.act(.apply(proposalID: draftID, hash: "hash"))
        let count = await service.configWrites
        XCTAssertEqual(count, 0)
    }
}

private func marketingDecode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
    return try decoder.decode(type, from: Data(json.utf8))
}
private actor MarketingModelService: MarketingService {
    let conflicting: Bool
    var writes: [(MarketingDraftEdit, String)] = []
    var configWrites = 0
    init(conflicting: Bool = false) { self.conflicting = conflicting }
    func package() throws -> MarketingPackage {
        try marketingDecode(MarketingPackage.self, #"{"packageId":"bob-marketing","version":"1","name":"Bob Marketing","mission":"A little joy","voice":"Warm","roles":[],"assets":[],"capabilities":[],"grants":[]}"#)
    }
    func installation(id: String) throws -> MarketingInstallation { try marketingDecode(MarketingInstallation.self, marketingInstallationJSON) }
    func installations(spaceID: String?) throws -> [MarketingInstallation] { [try installation(id: marketingID)] }
    func install(spaceID: String?, mutationID: String) throws -> MarketingInstallation { try installation(id: marketingID) }
    func lifecycle(_ installation: MarketingInstallation, operation: MarketingLifecycle, mutationID: String) throws -> MarketingInstallation {
        try marketingDecode(MarketingInstallation.self, marketingInstallationJSON.replacingOccurrences(of: "\"active\"", with: "\"paused\""))
    }
    func campaigns(installationID: String, cursor: String?) throws -> MarketingPage<MarketingCampaign> {
        try marketingDecode(MarketingPage<MarketingCampaign>.self, #"{"items":[{"id":"22222222-2222-4222-8222-222222222222","installationId":"11111111-1111-4111-8111-111111111111","name":"A week","goal":"awareness","goalNote":null,"channels":["instagram"],"status":"draft","revision":1,"draftCount":1,"updatedAt":1700000000000}],"nextCursor":null}"#)
    }
    func campaign(installationID: String, campaignID: String) throws -> MarketingCampaign { throw ApiError.offline }
    func drafts(installationID: String, campaignID: String, channel: MarketingChannel?, cursor: String?) throws -> MarketingPage<MarketingDraft> { throw ApiError.offline }
    func draft(installationID: String, draftID: String) throws -> MarketingDraft {
        try marketingDecode(MarketingDraft.self, marketingDraftJSON.replacingOccurrences(of: "\"contentRevision\":4", with: "\"contentRevision\":5"))
    }
    func saveDraft(installationID: String, draftID: String, edit: MarketingDraftEdit, mutationID: String) throws {
        writes.append((edit, mutationID))
        if writes.count == 1 { throw conflicting ? ApiError.unknown(status: 409) : ApiError.offline }
    }
    func config(installationID: String, beforeRevision: Int?) throws -> MarketingConfigDetail { throw ApiError.offline }
    func configAction(installationID: String, action: MarketingConfigAction, revision: Int, mutationID: String) { configWrites += 1 }
}
