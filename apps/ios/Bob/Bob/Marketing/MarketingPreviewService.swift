#if DEBUG
import BobKit
import Foundation

/// In-memory preview data only; never selected when a live API session is configured.
actor MarketingPreviewService: MarketingService {
    static let shared = MarketingPreviewService()
    private let id = "11111111-1111-4111-8111-111111111111"
    private let appID = "55555555-5555-4555-8555-555555555555"
    private let campaignID = "22222222-2222-4222-8222-222222222222"
    private var state = "active"
    private var revision = 3
    private var configRevision = 2
    private var pending = true
    private var edits: [String: MarketingDraftEdit] = [:]
    private var configObject: [String: Any] { ["visibleViews": ["campaign", "content"], "contentGrouping": "none", "defaultChannels": ["instagram", "linkedin"]] }
    private func decode<T: Decodable>(_ value: [String: Any]) throws -> T {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(T.self, from: JSONSerialization.data(withJSONObject: value))
    }
    func package() throws -> MarketingPackage {
        try decode(["packageId": "bob-marketing", "version": "preview", "name": "Bob Marketing", "mission": "Bob lightens up people's moods.", "voice": "Warm, playful and clear.", "roles": [["id": "story", "label": "Story & strategy", "summary": "Find the small, human moment behind the message."]], "assets": [["id": "playful", "url": "/brand/bob/bob-playful.webp", "rights": "Original Bob artwork"]], "capabilities": [["id": "publishing", "status": "unavailable", "reason": "No channel connector is connected. Nothing is published."]], "grants": ["campaign.read", "campaign.draft", "campaign.configure"]])
    }
    func installation(id: String) throws -> MarketingInstallation {
        guard id == self.id else { throw ApiError.notFound }
        return try decode(["id": id, "appId": appID, "spaceId": NSNull(), "canManage": true, "state": state, "grantedCapabilities": ["campaign.read", "campaign.draft", "campaign.configure"], "revision": revision, "configRevision": configRevision, "config": configObject, "package": ["packageId": "bob-marketing", "name": "Bob Marketing", "version": "preview"], "createdAt": 1700000000000, "updatedAt": 1700000001000])
    }
    func installations(spaceID: String?) throws -> [MarketingInstallation] { spaceID == nil ? [try installation(id: id)] : [] }
    func install(spaceID: String?, mutationID: String) throws -> MarketingInstallation {
        guard spaceID == nil else { throw ApiError.forbidden }
        return try installation(id: id)
    }
    func lifecycle(_ installation: MarketingInstallation, operation: MarketingLifecycle, mutationID: String) throws -> MarketingInstallation {
        guard installation.id == id, installation.revision == revision else { throw ApiError.unknown(status: 409) }
        state = operation == .pause ? "paused" : "active"; revision += 1
        return try self.installation(id: id)
    }
    private var campaignObject: [String: Any] {
        ["id": campaignID, "installationId": id, "name": "A week of little wins", "goal": "awareness", "goalNote": NSNull(), "channels": ["instagram", "linkedin"], "status": "draft", "revision": 1, "draftCount": 2, "updatedAt": 1700000000000, "sections": [["section": "brief", "content": "Make room for one small moment of joy each day."], ["section": "strategy", "content": "Show how Bob helps the everyday feel a little lighter."]]]
    }
    func campaigns(installationID: String, cursor: String?) throws -> MarketingPage<MarketingCampaign> { try decode(["items": [campaignObject], "nextCursor": NSNull()]) }
    func campaign(installationID: String, campaignID: String) throws -> MarketingCampaign {
        guard installationID == id, campaignID == self.campaignID else { throw ApiError.notFound }
        return try decode(campaignObject)
    }
    private func draftObject(_ draftID: String) -> [String: Any] {
        let first = draftID == "33333333-3333-4333-8333-333333333333"
        let edit = edits[draftID]
        return ["id": draftID, "campaignId": campaignID, "channel": first ? "instagram" : "linkedin", "format": "image", "body": edit?.body ?? (first ? "The best part of a busy day? A little room to smile." : "Small wins count. Bob helps you find a little breathing room, one day at a time."), "altText": edit?.altText ?? "Bob waving hello", "pillar": edit?.pillar ?? (first ? "Day 1 · Little wins · Make room to smile" : "Day 3 · Everyday joy · A little breathing room"), "approvedAssetIds": ["playful"], "claimIds": [], "cta": "none", "state": "needs_check", "contentRevision": edit.map { $0.revision + 1 } ?? 1, "createdAt": 1700000000000, "updatedAt": 1700000001000]
    }
    func drafts(installationID: String, campaignID: String, channel: MarketingChannel?, cursor: String?) throws -> MarketingPage<MarketingDraft> {
        let items = [draftObject("33333333-3333-4333-8333-333333333333"), draftObject("66666666-6666-4666-8666-666666666666")].filter { channel == nil || $0["channel"] as? String == channel?.rawValue }
        return try decode(["items": items, "nextCursor": NSNull()])
    }
    func draft(installationID: String, draftID: String) throws -> MarketingDraft { try decode(draftObject(draftID)) }
    func saveDraft(installationID: String, draftID: String, edit: MarketingDraftEdit, mutationID: String) throws {
        guard state == "active" else { throw ApiError.forbidden }
        let current: MarketingDraft = try decode(draftObject(draftID))
        guard current.contentRevision == edit.revision else { throw ApiError.unknown(status: 409) }
        edits[draftID] = edit
    }
    func config(installationID: String, beforeRevision: Int?) throws -> MarketingConfigDetail {
        let proposal: [String: Any] = ["id": "77777777-7777-4777-8777-777777777777", "status": "pending", "baseConfigRevision": configRevision, "canonicalHash": String(repeating: "a", count: 64), "config": configObject, "changes": [["field": "contentGrouping", "before": "channel", "after": "none"]], "createdAt": 1700000000000]
        return try decode(["installation": ["id": id, "state": state, "configRevision": configRevision, "config": configObject, "packageVersion": "preview"], "pending": pending ? [proposal] : [], "versions": [["revision": configRevision, "config": configObject, "packageVersion": "preview", "restorable": true, "createdAt": 1700000001000], ["revision": 1, "config": configObject, "packageVersion": "preview", "restorable": true, "createdAt": 1700000000000]], "nextBeforeRevision": NSNull(), "dependencies": [["id": "connectors", "reason": "No channel connector is connected. Nothing is published."]]])
    }
    func configAction(installationID: String, action: MarketingConfigAction, revision: Int, mutationID: String) throws {
        guard state == "active", revision == configRevision else { throw ApiError.unknown(status: 409) }
        pending = false
        if case .discard = action { return }
        configRevision += 1
    }
}
#endif
