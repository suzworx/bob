import Foundation

public enum MarketingChannel: String, Codable, Sendable, CaseIterable {
    case instagram, linkedin
    public var title: String { self == .instagram ? "Instagram" : "LinkedIn" }
}
public struct MarketingConfig: Decodable, Equatable, Sendable {
    public let visibleViews: [String]
    public let contentGrouping: String
    public let defaultChannels: [MarketingChannel]
}
public struct MarketingInstallation: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let appId: String
    public let spaceId: String?
    public let canManage: Bool
    public let state: String
    public let grantedCapabilities: [String]
    public let revision: Int
    public let configRevision: Int
    public let config: MarketingConfig
    public let package: PackageSummary
    public let createdAt: Date
    public let updatedAt: Date
    public var writable: Bool { state == "active" && grantedCapabilities.contains("campaign.draft") }
    public var configurable: Bool { state == "active" && canManage && grantedCapabilities.contains("campaign.configure") }
    public struct PackageSummary: Decodable, Equatable, Sendable { public let packageId: String; public let name: String; public let version: String }
}
public struct MarketingPackage: Decodable, Sendable {
    public let packageId: String
    public let version: String
    public let name: String
    public let mission: String
    public let voice: String
    public let roles: [Role]
    public let assets: [Asset]
    public let capabilities: [Capability]
    public let grants: [String]
    public struct Role: Decodable, Identifiable, Sendable { public let id: String; public let label: String; public let summary: String }
    public struct Asset: Decodable, Identifiable, Sendable { public let id: String; public let url: String; public let rights: String }
    public struct Capability: Decodable, Identifiable, Sendable { public let id: String; public let status: String; public let reason: String }
}
public struct MarketingCampaign: Decodable, Identifiable, Sendable {
    public let id: String
    public let installationId: String
    public let name: String
    public let goal: String
    public let goalNote: String?
    public let channels: [MarketingChannel]
    public let status: String
    public let revision: Int
    public let draftCount: Int
    public let updatedAt: Date
    public let sections: [Section]?
    public struct Section: Decodable, Identifiable, Sendable {
        public let section: String
        public let content: String
        public var id: String { section }
    }
}
public struct MarketingDraft: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let campaignId: String
    public let channel: MarketingChannel
    public let format: String
    public let body: String
    public let altText: String?
    public let pillar: String?
    public let approvedAssetIds: [String]
    public let claimIds: [String]
    public let cta: String
    public let state: String
    public let contentRevision: Int
    public let createdAt: Date
    public let updatedAt: Date
    public var week: MarketingWeekLabel { MarketingWeekLabel(pillar: pillar) }
}
public struct MarketingWeekLabel: Equatable, Sendable {
    public let day: Int?
    public let pillar: String?
    public let beat: String?
    public init(pillar: String?) {
        let parts = pillar?.components(separatedBy: " · ") ?? []
        if parts.count == 3, parts[0].hasPrefix("Day "), let day = Int(parts[0].dropFirst(4)), (1...7).contains(day) {
            self.day = day; self.pillar = parts[1]; beat = parts[2]
        } else { day = nil; self.pillar = pillar; beat = nil }
    }
}
public struct MarketingPage<Item: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Item]
    public let nextCursor: String?
}
public struct MarketingConfigDetail: Decodable, Sendable {
    public let installation: Installation
    public let pending: [Proposal]
    public let versions: [Version]
    public let nextBeforeRevision: Int?
    public let dependencies: [Dependency]
    public struct Installation: Decodable, Sendable { public let id: String; public let state: String; public let configRevision: Int; public let config: MarketingConfig; public let packageVersion: String }
    public struct Proposal: Decodable, Identifiable, Sendable {
        public let id: String
        public let status: String
        public let baseConfigRevision: Int
        public let canonicalHash: String
        public let config: MarketingConfig
        public let changes: [Change]
        public let createdAt: Date
    }
    public struct Change: Decodable, Identifiable, Sendable {
        public let field: String
        public let before: Value
        public let after: Value
        public var id: String { field }
    }
    public enum Value: Decodable, Sendable {
        case text(String), list([String])
        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(String.self) { self = .text(value) }
            else { self = .list(try container.decode([String].self)) }
        }
        public var display: String { switch self { case .text(let text): text; case .list(let list): list.joined(separator: ", ") } }
    }
    public struct Version: Decodable, Identifiable, Sendable {
        public let revision: Int
        public let config: MarketingConfig?
        public let packageVersion: String
        public let restorable: Bool
        public let createdAt: Date
        public var id: Int { revision }
    }
    public struct Dependency: Decodable, Identifiable, Sendable { public let id: String; public let reason: String }
}
public struct MarketingDraftEdit: Equatable, Sendable {
    public let body: String
    public let altText: String?
    public let pillar: String?
    public let revision: Int
    public init(body: String, altText: String?, pillar: String?, revision: Int) { self.body = body; self.altText = altText; self.pillar = pillar; self.revision = revision }
    public var valid: Bool { body.utf8.count <= 8000 && (altText?.utf8.count ?? 0) <= 2000 && (pillar?.utf8.count ?? 0) <= 120 && revision > 0 }
}
public enum MarketingLifecycle: String, Sendable { case activate, pause, resume }
public enum MarketingConfigAction: Equatable, Sendable {
    case apply(proposalID: String, hash: String), discard(proposalID: String), restore(version: Int)
    var path: String { switch self { case .apply: "apply"; case .discard: "discard"; case .restore: "restore" } }
    var fields: [String: Any] {
        switch self {
        case .apply(let id, let hash): ["proposalId": id, "hash": hash]
        case .discard(let id): ["proposalId": id]
        case .restore(let version): ["versionRevision": version]
        }
    }
}
public struct MarketingChatTarget: Equatable, Sendable {
    public let installationID: String
    public let appID: String
    public let spaceID: String?
    public let campaignID: String?
    public let mode: String
    public let channel: String?
    public init(installationID: String, appID: String, spaceID: String?, campaignID: String?, mode: String = "run", channel: String? = nil) {
        self.installationID = installationID; self.appID = appID; self.spaceID = spaceID; self.campaignID = campaignID; self.mode = mode; self.channel = channel
    }
}

public protocol MarketingService: Sendable {
    func package() async throws -> MarketingPackage
    func installations(spaceID: String?) async throws -> [MarketingInstallation]
    func installation(id: String) async throws -> MarketingInstallation
    func install(spaceID: String?, mutationID: String) async throws -> MarketingInstallation
    func lifecycle(_ installation: MarketingInstallation, operation: MarketingLifecycle, mutationID: String) async throws -> MarketingInstallation
    func campaigns(installationID: String, cursor: String?) async throws -> MarketingPage<MarketingCampaign>
    func campaign(installationID: String, campaignID: String) async throws -> MarketingCampaign
    func drafts(installationID: String, campaignID: String, channel: MarketingChannel?, cursor: String?) async throws -> MarketingPage<MarketingDraft>
    func draft(installationID: String, draftID: String) async throws -> MarketingDraft
    func saveDraft(installationID: String, draftID: String, edit: MarketingDraftEdit, mutationID: String) async throws
    func config(installationID: String, beforeRevision: Int?) async throws -> MarketingConfigDetail
    func configAction(installationID: String, action: MarketingConfigAction, revision: Int, mutationID: String) async throws
}

public struct MarketingClient: MarketingService {
    private let http: JSONRequester
    private let base = ["bob-apps", "marketing"]
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func package() async throws -> MarketingPackage {
        let response: PackageResponse = try await http.decoded("GET", base + ["package"])
        return response.package
    }
    public func installations(spaceID: String? = nil) async throws -> [MarketingInstallation] {
        let response: InstallationsResponse = try await http.decoded("GET", base + ["installations"], query: spaceID.map { [URLQueryItem(name: "spaceId", value: $0)] } ?? [])
        return response.installations
    }
    public func installation(id: String) async throws -> MarketingInstallation {
        let response: InstallationResponse = try await http.decoded("GET", path(id))
        return response.installation
    }
    public func install(spaceID: String?, mutationID: String) async throws -> MarketingInstallation {
        var body: [String: Any] = ["packageId": "bob-marketing", "mutationId": mutationID]
        if let spaceID { body["spaceId"] = spaceID }
        let response: InstallationResponse = try await http.decoded("POST", base + ["install"], body: body)
        return response.installation
    }
    public func lifecycle(_ installation: MarketingInstallation, operation: MarketingLifecycle, mutationID: String) async throws -> MarketingInstallation {
        let response: InstallationResponse = try await http.decoded("POST", path(installation.id) + ["lifecycle"], body: ["operation": operation.rawValue, "expectedRevision": installation.revision, "mutationId": mutationID])
        return response.installation
    }
    public func campaigns(installationID: String, cursor: String? = nil) async throws -> MarketingPage<MarketingCampaign> {
        try await http.decoded("GET", path(installationID) + ["campaigns"], query: cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    }
    public func campaign(installationID: String, campaignID: String) async throws -> MarketingCampaign {
        let response: CampaignResponse = try await http.decoded("GET", path(installationID) + ["campaigns", campaignID])
        return response.campaign
    }
    public func drafts(installationID: String, campaignID: String, channel: MarketingChannel? = nil, cursor: String? = nil) async throws -> MarketingPage<MarketingDraft> {
        var query = [URLQueryItem(name: "campaignId", value: campaignID), URLQueryItem(name: "projection", value: "content")]
        if let channel { query.append(URLQueryItem(name: "channel", value: channel.rawValue)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await http.decoded("GET", path(installationID) + ["drafts"], query: query)
    }
    public func draft(installationID: String, draftID: String) async throws -> MarketingDraft {
        let response: DraftResponse = try await http.decoded("GET", path(installationID) + ["drafts", draftID])
        return response.draft
    }
    public func saveDraft(installationID: String, draftID: String, edit: MarketingDraftEdit, mutationID: String) async throws {
        guard edit.valid else { throw ApiError.invalidRequest }
        try await http.empty("PATCH", path(installationID) + ["drafts", draftID], body: ["body": edit.body, "altText": edit.altText.map { $0 as Any } ?? NSNull(), "pillar": edit.pillar.map { $0 as Any } ?? NSNull(), "expectedContentRevision": edit.revision, "mutationId": mutationID])
    }
    public func config(installationID: String, beforeRevision: Int? = nil) async throws -> MarketingConfigDetail {
        try await http.decoded("GET", path(installationID) + ["config"], query: beforeRevision.map { [URLQueryItem(name: "beforeRevision", value: String($0))] } ?? [])
    }
    public func configAction(installationID: String, action: MarketingConfigAction, revision: Int, mutationID: String) async throws {
        var body = action.fields
        body["expectedConfigRevision"] = revision; body["mutationId"] = mutationID
        try await http.empty("POST", path(installationID) + ["config", action.path], body: body)
    }
    private func path(_ id: String) -> [String] { base + ["installations", id] }
}
private struct PackageResponse: Decodable { let package: MarketingPackage }
private struct InstallationsResponse: Decodable { let installations: [MarketingInstallation] }
private struct InstallationResponse: Decodable { let installation: MarketingInstallation }
private struct CampaignResponse: Decodable { let campaign: MarketingCampaign }
private struct DraftResponse: Decodable { let draft: MarketingDraft }
