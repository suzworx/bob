import Foundation
import Observation

/// Keeps the complete reviewed snapshot pinned until the person explicitly refreshes.
@MainActor @Observable public final class MarketingReviewModel {
    public let installationID: String
    public let campaignID: String
    public private(set) var review: MarketingReview?
    public private(set) var loading = false
    public private(set) var busy = false
    public private(set) var changed = false
    public private(set) var error: ApiError?
    @ObservationIgnored private let service: any MarketingReviewService
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var attempt: (review: MarketingReview, mutationID: String)?

    public init(installationID: String, campaignID: String, service: any MarketingReviewService) {
        self.installationID = installationID; self.campaignID = campaignID; self.service = service
    }
    public var canApprove: Bool {
        !loading && !busy && !changed && review?.canApprove == true && review?.state == .needsReview && review?.snapshot.drafts.isEmpty == false
    }
    public func refresh() async { await load(replacing: true) }
    public func checkForChanges() async { await load(replacing: false) }
    public func cancel() { generation += 1; loading = false; busy = false; changed = true }

    private func load(replacing: Bool) async {
        guard !busy else { return }
        generation += 1; let request = generation
        loading = true; error = nil
        defer { if request == generation { loading = false } }
        do {
            let fresh = try await service.read(installationID: installationID, campaignID: campaignID)
            guard current(request) else { return }
            try fresh.validate(installationID: installationID, campaignID: campaignID)
            if replacing || review == nil {
                review = fresh; changed = false; attempt = nil
            } else if let review, review.isSamePlan(as: fresh) {
                self.review = fresh
            } else { changed = true }
        } catch {
            guard current(request) else { return }
            changed = true; self.error = error as? ApiError ?? .unknown(status: 0)
        }
    }
    public func approve() async {
        guard canApprove, let review else { return }
        let operation = attempt ?? (review: review, mutationID: UUID().uuidString)
        attempt = operation
        generation += 1; let request = generation
        busy = true; error = nil
        defer { if request == generation { busy = false } }
        do {
            let fresh = try await service.approve(installationID: installationID, campaignID: campaignID, revision: operation.review.reviewRevision, snapshotHash: operation.review.snapshotHash, mutationID: operation.mutationID)
            guard current(request) else { return }
            try fresh.validate(installationID: installationID, campaignID: campaignID)
            guard operation.review.isSamePlan(as: fresh), fresh.state == .approved else { changed = true; return }
            self.review = fresh; attempt = nil
        } catch {
            guard current(request) else { return }
            let failure = error as? ApiError ?? .unknown(status: 0)
            self.error = failure
            if error is RevisionConflict { changed = true }
            switch failure {
            case .unknown(status: 409), .conflict, .forbidden, .notFound, .unauthenticated: changed = true
            default: break
            }
        }
    }
    private func current(_ request: Int) -> Bool { request == generation && !Task.isCancelled }
}
