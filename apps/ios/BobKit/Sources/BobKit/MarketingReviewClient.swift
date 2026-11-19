import Foundation

public struct MarketingReview: Decodable, Sendable {
    public enum State: String, Decodable, Sendable { case needsReview = "needs_review", approved }
    public let installationId: String
    public let campaignId: String
    public let state: State
    public let reviewRevision: Int
    public let snapshotHash: String
    public let lifecycleGeneration: Int
    public let packRevision: String
    public let canApprove: Bool
    public let snapshot: Snapshot
    public let notes: [Note]
    public let approval: Decision?
    public let history: [Decision]

    public struct Snapshot: Decodable, Sendable {
        public let campaign: MarketingCampaign
        public let drafts: [MarketingDraft]
    }
    public struct Author: Decodable, Sendable { public let id: String; public let label: String }
    public struct Note: Decodable, Identifiable, Sendable {
        public let id: String
        public let text: String
        public let author: Author?
        public let createdAt: Date
    }
    public struct Decision: Decodable, Identifiable, Sendable {
        public let id: String
        public let snapshotHash: String
        public let reviewRevision: Int
        public let author: Author?
        public let createdAt: Date
    }
    public func isSamePlan(as other: Self) -> Bool {
        installationId == other.installationId && campaignId == other.campaignId &&
        reviewRevision == other.reviewRevision && snapshotHash == other.snapshotHash &&
        lifecycleGeneration == other.lifecycleGeneration && packRevision == other.packRevision
    }
    func validate(installationID: String, campaignID: String) throws {
        guard installationId == installationID, campaignId == campaignID,
              snapshot.campaign.id == campaignID, snapshot.campaign.installationId == installationID,
              (1...2_147_483_646).contains(reviewRevision), lifecycleGeneration >= 0,
              Self.validHash(snapshotHash), Self.validHash(packRevision), snapshot.drafts.count <= 100,
              snapshot.drafts.allSatisfy({ $0.campaignId == campaignID }),
              Set(snapshot.drafts.map(\.id)).count == snapshot.drafts.count,
              notes.count <= 100, history.count <= 20,
              Set(notes.map(\.id)).count == notes.count, Set(history.map(\.id)).count == history.count,
              state != .approved || approval?.snapshotHash == snapshotHash else { throw ApiError.invalidRequest }
    }
    static func validHash(_ hash: String) -> Bool {
        hash.utf8.count == 64 && hash.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

public protocol MarketingReviewService: Sendable {
    func read(installationID: String, campaignID: String) async throws -> MarketingReview
    func approve(installationID: String, campaignID: String, revision: Int, snapshotHash: String, mutationID: String) async throws -> MarketingReview
}

public struct MarketingReviewClient: MarketingReviewService {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func read(installationID: String, campaignID: String) async throws -> MarketingReview {
        let response: ReviewResponse = try await http.decoded("GET", path(installationID, campaignID))
        try response.review.validate(installationID: installationID, campaignID: campaignID)
        return response.review
    }
    public func approve(installationID: String, campaignID: String, revision: Int, snapshotHash: String, mutationID: String) async throws -> MarketingReview {
        guard (1...2_147_483_646).contains(revision), MarketingReview.validHash(snapshotHash), UUID(uuidString: mutationID) != nil else { throw ApiError.invalidRequest }
        let response: ApprovalResponse = try await http.decoded("POST", path(installationID, campaignID) + ["approve"], body: ["expectedReviewRevision": revision, "snapshotHash": snapshotHash, "mutationId": mutationID])
        guard response.receipt.kind == "review.approved", response.receipt.installationId == installationID,
              response.receipt.campaignId == campaignID, UUID(uuidString: response.receipt.approvalId) != nil else { throw ApiError.invalidRequest }
        try response.review.validate(installationID: installationID, campaignID: campaignID)
        return response.review
    }
    private func path(_ installationID: String, _ campaignID: String) -> [String] {
        ["bob-apps", "marketing", "installations", installationID, "campaigns", campaignID, "review"]
    }
}
private struct ReviewResponse: Decodable { let review: MarketingReview }
private struct ApprovalResponse: Decodable {
    let receipt: Receipt
    let review: MarketingReview
    struct Receipt: Decodable { let kind: String; let installationId: String; let campaignId: String; let approvalId: String }
}
