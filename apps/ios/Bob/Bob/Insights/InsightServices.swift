import BobKit
import Foundation

@MainActor enum InsightServices {
    static func insights() -> InsightsFeed {
        if let client = AppSession.make({ InsightsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) {
            return InsightsFeed { try await client.list(category: $0) }
        }
        #if DEBUG
        return InsightsFeed { _ in [] }
        #else
        return InsightsFeed { _ in throw ApiError.unauthenticated }
        #endif
    }

    static func preparation(category: InsightCategory) -> InsightsPreparation {
        if let clients = AppSession.make({ baseURL, token, reauthenticate in
            (InsightsClient(baseURL: baseURL, accessToken: token, reauthenticate: reauthenticate),
             GoogleIntegrationsClient(baseURL: baseURL, accessToken: token, reauthenticate: reauthenticate))
        }) {
            return InsightsPreparation(category: category, accounts: { try await clients.1.accounts() }, prepare: { try await clients.0.prepare(accountID: $0, category: $1) })
        }
        #if DEBUG
        return InsightsPreparation(category: category, accounts: { [] }, prepare: { _, _ in throw ApiError.unauthenticated })
        #else
        return InsightsPreparation(category: category, accounts: { throw ApiError.unauthenticated }, prepare: { _, _ in throw ApiError.unauthenticated })
        #endif
    }

    static func timeline() -> TimelineFeed {
        if let client = AppSession.make({ TimelineClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) {
            return TimelineFeed { try await client.list(query: $0, cursor: $1) }
        }
        #if DEBUG
        return TimelineFeed { query, _ in TimelinePage(day: query.day, timeZone: query.timeZone, entries: [], nextCursor: nil) }
        #else
        return TimelineFeed { _, _ in throw ApiError.unauthenticated }
        #endif
    }
}
