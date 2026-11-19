import Foundation

public struct BobAppsClient: Sendable {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func list(spaceID: String? = nil, cursor: String? = nil) async throws -> BobAppsPage {
        var query = [URLQueryItem(name: "limit", value: "20")]
        if let spaceID { query.append(URLQueryItem(name: "spaceId", value: spaceID)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await http.decoded("GET", ["bob-apps"], query: query)
    }
    public func get(_ id: String) async throws -> SavedBobApp {
        let result: Response = try await http.decoded("GET", ["bob-apps", id]); return try valid(result.app)
    }
    public func create(_ definition: BobAppDefinition, spaceID: String?, mutationID: UUID) async throws -> SavedBobApp {
        guard definition.isValid else { throw ApiError.invalidRequest }
        var body: [String: Any] = ["definition": try Self.object(definition), "mutationId": mutationID.uuidString]
        if let spaceID { body["spaceId"] = spaceID }
        let result: Response = try await http.decoded("POST", ["bob-apps"], body: body); return try valid(result.app)
    }
    public func change(_ app: SavedBobApp, operation: BobAppOperation, mutationID: UUID) async throws -> SavedBobApp {
        var body = Self.mutation(app.revision, mutationID); body["operation"] = operation.rawValue
        let result: Response = try await http.decoded("PATCH", ["bob-apps", app.id], body: body); return try valid(result.app)
    }
    public func act(_ app: SavedBobApp, command: BobAppCommand, expectedRevision: Int, mutationID: UUID) async throws -> SavedBobApp {
        var body = Self.mutation(expectedRevision, mutationID); body["command"] = try Self.object(command)
        let result: Response = try await http.decoded("POST", ["bob-apps", app.id, "actions"], body: body); return try valid(result.app)
    }
    public func delete(_ app: SavedBobApp, mutationID: UUID) async throws {
        try await http.empty("DELETE", ["bob-apps", app.id], body: Self.mutation(app.revision, mutationID))
    }
    public func export(_ id: String) async throws -> Data { try await http.file(["bob-apps", id, "export"]).data }
    public func openConversation(_ id: String) async throws -> BobAppConversation {
        try await http.decoded("POST", ["bob-apps", id, "conversation"])
    }
    public func refresh(_ id: String) async throws -> BobAppRefresh {
        let state: BobAppRefresh = try await http.decoded("GET", ["bob-apps", id, "refresh"])
        guard state.config?.isValid != false, !state.enabled || state.config != nil else { throw ApiError.unknown(status: 200) }
        return state
    }
    public func runs(_ id: String) async throws -> [BobAppRun] {
        let response: Runs = try await http.decoded("GET", ["bob-apps", id, "runs"]); return response.runs
    }
    public func configure(_ app: SavedBobApp, enabled: Bool, config: BobAppRefreshConfig?, mutationID: UUID) async throws -> BobAppRefresh {
        guard !enabled || config?.isValid == true else { throw ApiError.invalidRequest }
        var body = Self.mutation(app.revision, mutationID)
        body["enabled"] = enabled; body["consent"] = true; body["config"] = try config.map(Self.object) ?? NSNull()
        return try await http.decoded("PUT", ["bob-apps", app.id, "refresh"], body: body)
    }
    private func valid(_ app: SavedBobApp) throws -> SavedBobApp {
        guard app.revision > 0, app.definition.isValid, app.pendingDefinition?.isValid != false else { throw ApiError.unknown(status: 200) }
        return app
    }
    private static func mutation(_ revision: Int, _ id: UUID) -> [String: Any] { ["expectedRevision": revision, "mutationId": id.uuidString] }
    private static func object(_ value: some Encodable) throws -> Any { try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) }
    private struct Response: Decodable { let app: SavedBobApp }
    private struct Runs: Decodable { let runs: [BobAppRun] }
}
