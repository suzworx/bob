import Foundation
import Observation

public struct MarketingDraftGroup: Identifiable, Sendable {
    public let id: String
    public let drafts: [MarketingDraft]
}

@MainActor @Observable public final class MarketingWorkspaceModel {
    public let installationID: String
    public let spaceID: String?
    public private(set) var installation: MarketingInstallation?
    public private(set) var package: MarketingPackage?
    public private(set) var campaigns: [MarketingCampaign] = []
    public private(set) var campaign: MarketingCampaign?
    public private(set) var drafts: [MarketingDraft] = []
    public private(set) var selectedCampaignID: String?
    public private(set) var nextDraftCursor: String?
    public private(set) var ready = false
    public private(set) var loading = false
    public private(set) var busy = false
    public private(set) var error: ApiError?
    public var channel: MarketingChannel?
    @ObservationIgnored public let service: any MarketingService
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var lifecycleAttempt: (operation: MarketingLifecycle, revision: Int, id: String)?

    public init(installationID: String, spaceID: String?, service: any MarketingService) {
        self.installationID = installationID; self.spaceID = spaceID; self.service = service
    }
    public var visibleDrafts: [MarketingDraft] {
        drafts.filter { channel == nil || $0.channel == channel }.sorted {
            let left = $0.week.day ?? 0, right = $1.week.day ?? 0
            return left == right ? $0.createdAt < $1.createdAt : left < right
        }
    }
    public var draftGroups: [MarketingDraftGroup] {
        var order: [String] = []
        var groups: [String: [MarketingDraft]] = [:]
        for draft in visibleDrafts {
            let label: String
            switch installation?.config.contentGrouping {
            case "channel": label = draft.channel.title
            case "pillar": label = draft.week.pillar ?? "No pillar yet"
            default: label = draft.week.day.map { "Day \($0)" } ?? "Posts"
            }
            if groups[label] == nil { order.append(label) }
            groups[label, default: []].append(draft)
        }
        return order.map { MarketingDraftGroup(id: $0, drafts: groups[$0] ?? []) }
    }
    public func target(mode: String = "run") -> MarketingChatTarget? {
        guard ready, !loading, !busy, let installation, mode == "refine" ? installation.configurable : installation.writable else { return nil }
        return MarketingChatTarget(installationID: installationID, appID: installation.appId, spaceID: spaceID, campaignID: selectedCampaignID, mode: mode, channel: mode == "run" && selectedCampaignID != nil ? channel?.rawValue : nil)
    }
    public func refresh() async {
        guard !busy else { return }
        generation += 1; let request = generation
        loading = true; error = nil; ready = false
        defer { if request == generation { loading = false } }
        do {
            let installation = try await service.installation(id: installationID)
            guard installation.id == installationID, installation.spaceId == spaceID else { throw ApiError.notFound }
            let package = try await service.package()
            var items: [MarketingCampaign] = []
            var cursor: String?
            var seen: Set<String> = []
            repeat {
                let page = try await service.campaigns(installationID: installationID, cursor: cursor)
                guard page.items.allSatisfy({ $0.installationId == installationID }) else { throw ApiError.invalidRequest }
                items.append(contentsOf: page.items)
                cursor = page.nextCursor
                if let cursor, !seen.insert(cursor).inserted { throw ApiError.unknown(status: 200) }
            } while cursor != nil && items.count <= 20
            guard current(request) else { return }
            self.installation = installation; self.package = package; campaigns = items
            if let selectedCampaignID, !items.contains(where: { $0.id == selectedCampaignID && $0.status != "archived" }) { self.selectedCampaignID = nil }
            try await readCampaign(request: request)
        } catch { if current(request), !cancelled(error) { self.error = api(error) } }
    }
    public func select(_ id: String?) async {
        guard !busy, !loading, id == nil || campaigns.contains(where: { $0.id == id && $0.status != "archived" }) else { return }
        generation += 1; let request = generation
        selectedCampaignID = id; campaign = nil; drafts = []; nextDraftCursor = nil
        loading = true; ready = false; error = nil
        defer { if request == generation { loading = false } }
        do { try await readCampaign(request: request) }
        catch { if current(request), !cancelled(error) { self.error = api(error) } }
    }
    private func readCampaign(request: Int) async throws {
        guard let id = selectedCampaignID else { if current(request) { campaign = nil; drafts = []; nextDraftCursor = nil; ready = true }; return }
        let campaign = try await service.campaign(installationID: installationID, campaignID: id)
        guard campaign.status != "archived" else { throw ApiError.unknown(status: 409) }
        let page = try await service.drafts(installationID: installationID, campaignID: id, channel: nil, cursor: nil)
        guard campaign.id == id, campaign.installationId == installationID, page.items.allSatisfy({ $0.campaignId == id }) else { throw ApiError.invalidRequest }
        guard current(request), selectedCampaignID == id else { return }
        self.campaign = campaign; drafts = page.items; nextDraftCursor = page.nextCursor; ready = true
    }
    public func moreDrafts() async {
        guard ready, !loading, !busy, let cursor = nextDraftCursor, let id = selectedCampaignID else { return }
        let request = generation; busy = true; error = nil
        defer { busy = false }
        do {
            let page = try await service.drafts(installationID: installationID, campaignID: id, channel: nil, cursor: cursor)
            guard page.items.allSatisfy({ $0.campaignId == id }) else { throw ApiError.invalidRequest }
            guard current(request), selectedCampaignID == id else { return }
            for draft in page.items where !drafts.contains(where: { $0.id == draft.id }) { drafts.append(draft) }
            nextDraftCursor = page.nextCursor == cursor ? nil : page.nextCursor
        } catch { if current(request), !cancelled(error) { self.error = api(error) } }
    }
    public func changeLifecycle(_ operation: MarketingLifecycle) async {
        guard !busy, !loading, let installation, installation.canManage else { return }
        busy = true; error = nil
        if lifecycleAttempt?.operation != operation || lifecycleAttempt?.revision != installation.revision {
            lifecycleAttempt = (operation, installation.revision, UUID().uuidString)
        }
        defer { busy = false }
        do {
            guard let attempt = lifecycleAttempt else { return }
            let updated = try await service.lifecycle(installation, operation: operation, mutationID: attempt.id)
            guard updated.id == installationID, updated.spaceId == spaceID else { throw ApiError.invalidRequest }
            self.installation = updated; lifecycleAttempt = nil
        } catch { if !cancelled(error) { self.error = api(error) } }
    }
    public func cancel() { generation += 1; loading = false }
    private func current(_ request: Int) -> Bool { request == generation && !Task.isCancelled }
    private func cancelled(_ error: Error) -> Bool { error is CancellationError || (error as? ApiError) == .cancelled }
    private func api(_ error: Error) -> ApiError { (error as? ApiError) ?? .unknown(status: 0) }
}

@MainActor @Observable public final class MarketingDraftEditor {
    public private(set) var base: MarketingDraft
    public var body: String
    public var altText: String
    public var pillar: String
    public private(set) var busy = false
    public private(set) var error: ApiError?
    public private(set) var latest: MarketingDraft?
    public private(set) var submitted: MarketingDraftEdit?
    public private(set) var conflict = false
    @ObservationIgnored private var mutationID: String?
    @ObservationIgnored private let installationID: String
    @ObservationIgnored private let service: any MarketingService
    public init(draft: MarketingDraft, installationID: String, service: any MarketingService) {
        base = draft; body = draft.body; altText = draft.altText ?? ""; pillar = draft.pillar ?? ""
        self.installationID = installationID; self.service = service
    }
    public var edit: MarketingDraftEdit { MarketingDraftEdit(body: body, altText: altText.isEmpty ? nil : altText, pillar: pillar.isEmpty ? nil : pillar, revision: base.contentRevision) }
    public var hasChanges: Bool { body != base.body || altText != (base.altText ?? "") || pillar != (base.pillar ?? "") }
    public func save() async -> Bool {
        guard !busy, !conflict, edit.valid else { return false }
        if submitted == nil { submitted = edit; mutationID = UUID().uuidString }
        guard let submitted, let mutationID else { return false }
        busy = true; error = nil
        defer { busy = false }
        do {
            try await service.saveDraft(installationID: installationID, draftID: base.id, edit: submitted, mutationID: mutationID)
            return true
        } catch {
            self.error = (error as? ApiError) ?? .unknown(status: 0)
            if Self.isConflict(error) {
                conflict = true; self.submitted = nil; self.mutationID = nil
                await reloadLatest()
            }
            return false
        }
    }
    public func reloadLatest() async {
        do {
            let latest = try await service.draft(installationID: installationID, draftID: base.id)
            guard latest.id == base.id, latest.campaignId == base.campaignId else { throw ApiError.notFound }
            self.latest = latest
        } catch { self.error = (error as? ApiError) ?? .unknown(status: 0) }
    }
    public func keepEditsAgainstLatest() {
        guard let latest, !busy else { return }
        base = latest; self.latest = nil; conflict = false; error = nil
    }
    private static func isConflict(_ error: Error) -> Bool {
        if error is RevisionConflict { return true }
        if case .unknown(status: 409) = error as? ApiError { return true }
        return false
    }
}

@MainActor @Observable public final class MarketingConfigModel {
    public private(set) var detail: MarketingConfigDetail?
    public private(set) var versions: [MarketingConfigDetail.Version] = []
    public private(set) var next: Int?
    public private(set) var loading = false
    public private(set) var busy = false
    public private(set) var error: ApiError?
    public private(set) var installation: MarketingInstallation
    @ObservationIgnored private let service: any MarketingService
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var attempt: (action: MarketingConfigAction, revision: Int, id: String)?
    public init(installation: MarketingInstallation, service: any MarketingService) { self.installation = installation; self.service = service }
    public func refresh() async {
        guard !busy else { return }
        generation += 1; let request = generation
        loading = true; error = nil
        defer { if request == generation { loading = false } }
        do {
            let installation = try await service.installation(id: installation.id)
            let detail = try await service.config(installationID: installation.id, beforeRevision: nil)
            guard installation.id == self.installation.id, installation.spaceId == self.installation.spaceId, detail.installation.id == installation.id else { throw ApiError.notFound }
            guard request == generation, !Task.isCancelled else { return }
            self.installation = installation; self.detail = detail; versions = detail.versions; next = detail.nextBeforeRevision
        } catch { if request == generation, !Task.isCancelled { self.error = (error as? ApiError) ?? .unknown(status: 0) } }
    }
    public func more() async {
        guard !loading, !busy, let next else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let page = try await service.config(installationID: installation.id, beforeRevision: next)
            for version in page.versions where !versions.contains(where: { $0.id == version.id }) { versions.append(version) }
            self.next = page.nextBeforeRevision == next ? nil : page.nextBeforeRevision
        } catch { self.error = (error as? ApiError) ?? .unknown(status: 0) }
    }
    public func act(_ action: MarketingConfigAction) async {
        guard !loading, !busy, installation.configurable, let detail else { return }
        let revision = detail.installation.configRevision
        switch action {
        case .apply(let id, let hash):
            guard detail.pending.contains(where: { $0.id == id && $0.status == "pending" && $0.baseConfigRevision == revision && $0.canonicalHash == hash }) else { return }
        case .discard(let id): guard detail.pending.contains(where: { $0.id == id }) else { return }
        case .restore(let version): guard versions.contains(where: { $0.revision == version && $0.restorable && version != revision }) else { return }
        }
        if attempt?.action != action || attempt?.revision != revision { attempt = (action, revision, UUID().uuidString) }
        guard let attempt else { return }
        busy = true; error = nil
        do {
            try await service.configAction(installationID: installation.id, action: action, revision: revision, mutationID: attempt.id)
            self.attempt = nil; busy = false; await refresh()
        } catch {
            busy = false
            let failure = (error as? ApiError) ?? .unknown(status: 0)
            await refresh(); self.error = failure
        }
    }
    public func cancel() { generation += 1; loading = false }
}
