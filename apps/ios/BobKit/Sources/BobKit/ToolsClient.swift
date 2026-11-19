import Foundation

public enum ToolContext: Hashable, Sendable {
    case account, integration(String), space(String), conversation(String)

    var query: [URLQueryItem] {
        switch self {
        case .account: []
        case .integration(let id): [URLQueryItem(name: "integrationId", value: id)]
        case .space(let id): [URLQueryItem(name: "spaceId", value: id)]
        case .conversation(let id): [URLQueryItem(name: "conversationId", value: id)]
        }
    }
}

public enum ToolScope: String, Decodable, Sendable {
    case account, integration, space, conversation
    public var label: String {
        switch self {
        case .account: "your account"
        case .integration: "this integration"
        case .space: "this space"
        case .conversation: "this conversation"
        }
    }
}

public struct ToolScopeRef: Decodable, Equatable, Sendable {
    public let scope: ToolScope
    public let scopeID: String
    enum CodingKeys: String, CodingKey { case scope; case scopeID = "scopeId" }

    public init(scope: ToolScope, scopeID: String) { self.scope = scope; self.scopeID = scopeID }
}

public struct ToolCatalog: Decodable, Equatable, Sendable {
    public let scope: ToolScopeRef
    public let canEdit: Bool
    public let tools: [ToolEntry]

    public init(scope: ToolScopeRef, canEdit: Bool, tools: [ToolEntry]) {
        self.scope = scope; self.canEdit = canEdit; self.tools = tools
    }
}

public struct ToolEntry: Decodable, Equatable, Sendable, Identifiable {
    public enum Availability: String, Decodable, Sendable { case contextDependent = "context_dependent", unavailable }
    public enum IntegrationKind: String, Decodable, Sendable { case google }
    public let id: String
    public let toolName: String
    public let name: String
    public let description: String
    public let group: String
    public let integrationKind: IntegrationKind?
    public let availability: Availability
    public let enabled: Bool
    public let preference: Bool?
    public let blockedBy: [ToolScopeRef]

    public func disabledReason(in catalog: ToolCatalog) -> String? {
        if let inherited = blockedBy.first(where: { $0 != catalog.scope }) {
            return "Turned off for \(inherited.scope.label). Change that setting first."
        }
        if availability == .unavailable { return "Private integration tools are only available in private conversations." }
        if !catalog.canEdit { return "Only the owner or a space admin can change these settings." }
        return nil
    }
}

public struct ToolsClient: Sendable {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func catalog(context: ToolContext) async throws -> ToolCatalog {
        try await http.decoded("GET", ["tools"], query: context.query)
    }
    public func set(scope: ToolScopeRef, toolID: String, enabled: Bool?) async throws -> ToolCatalog {
        try await http.decoded("PATCH", ["tools", "preferences"], body: ["scope": scope.scope.rawValue, "scopeId": scope.scopeID, "toolId": toolID, "enabled": enabled.map { $0 as Any } ?? NSNull()])
    }
}
