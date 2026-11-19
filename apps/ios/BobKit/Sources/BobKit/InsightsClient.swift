import Foundation
import Observation

public enum InsightCategory: String, CaseIterable, Codable, Sendable {
    case future, reflections, past

    public var title: String {
        switch self {
        case .future: "Future"
        case .reflections: "Reflections"
        case .past: "Past"
        }
    }
}

public struct InsightSource: Decodable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case gmail, calendar }
    public let kind: Kind
    public let id: String
    public let label: String
    public let url: String?

    public var safeURL: URL? {
        guard let url, let parsed = URL(string: url), parsed.scheme == "https",
              parsed.host != nil, parsed.user == nil, parsed.password == nil else { return nil }
        return parsed
    }
}

public struct Insight: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let routineID: String?
    public let googleAccountID: String
    public let category: InsightCategory
    public let title: String
    public let summary: String
    public let periodStart: Date
    public let periodEnd: Date
    public let generatedAt: Date
    public let sources: [InsightSource]
    public let partial: Bool
    public let messageCount: Int

    enum CodingKeys: String, CodingKey {
        case id, category, title, summary, periodStart, periodEnd, generatedAt, sources, partial, messageCount
        case routineID = "routineId", googleAccountID = "googleAccountId"
    }
}

public struct InsightsClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // Called only after the person picks an account and explicitly prepares this category.
    public func prepare(accountID: String, category: InsightCategory) async throws -> [Insight] {
        guard UUID(uuidString: accountID) != nil, category != .past else { throw ApiError.invalidRequest }
        let response: InsightsResponse = try await http.decoded("POST", ["insights", "refresh"], body: ["googleAccountId": accountID, "category": category.rawValue])
        return response.insights
    }

    // Reading saved results never starts provider work.
    public func list(category: InsightCategory) async throws -> [Insight] {
        let response: InsightsResponse = try await http.decoded("GET", ["insights"], query: [URLQueryItem(name: "category", value: category.rawValue)])
        return response.insights
    }
}

private struct InsightsResponse: Decodable {
    let insights: [Insight]
}

@MainActor @Observable public final class InsightsFeed {
    public var category: InsightCategory = .future
    public private(set) var rows: [Insight] = []
    public private(set) var phase: InsightLoadPhase = .loading
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let read: @Sendable (InsightCategory) async throws -> [Insight]

    public init(read: @escaping @Sendable (InsightCategory) async throws -> [Insight]) {
        self.read = read
    }

    public func refresh() async {
        generation += 1
        let request = generation
        let category = category
        rows = []
        phase = .loading
        do {
            let rows = try await read(category)
            guard request == generation, category == self.category, !Task.isCancelled else { return }
            self.rows = rows
            phase = .loaded
        } catch {
            guard request == generation, category == self.category, !(error is CancellationError), (error as? ApiError) != .cancelled, !Task.isCancelled else { return }
            phase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }

    public func cancel() { generation += 1 }
}


public enum InsightLoadPhase: Equatable, Sendable {
    case loading, loaded, failed(ApiError)
}
