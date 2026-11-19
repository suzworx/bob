import Foundation
import Observation

/// Preparation stays separate from feed refresh: navigation and pull-to-refresh never read providers.
@MainActor @Observable public final class InsightsPreparation {
    public let category: InsightCategory
    public var selectedAccountID: String?
    public private(set) var accounts: [GoogleIntegrationAccount] = []
    public private(set) var accountsPhase: InsightLoadPhase = .loading
    public private(set) var busy = false
    public private(set) var error: ApiError?
    public private(set) var notice: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var accountGeneration = 0
    @ObservationIgnored private let readAccounts: @Sendable () async throws -> [GoogleIntegrationAccount]
    @ObservationIgnored private let run: @Sendable (String, InsightCategory) async throws -> [Insight]

    public init(category: InsightCategory, accounts: @escaping @Sendable () async throws -> [GoogleIntegrationAccount], prepare: @escaping @Sendable (String, InsightCategory) async throws -> [Insight]) {
        self.category = category; readAccounts = accounts; run = prepare
    }
    public var eligibleAccounts: [GoogleIntegrationAccount] {
        guard category != .past else { return [] }
        let capability: GoogleCapability = category == .future ? .calendarRead : .mailRead
        return accounts.filter { !$0.needsReconnect && $0.access.contains(capability) }
    }
    public var canPrepare: Bool {
        !busy && accountsPhase == .loaded && eligibleAccounts.contains { $0.id == selectedAccountID }
    }
    public func loadAccounts() async {
        accountGeneration += 1
        let request = accountGeneration
        accountsPhase = .loading
        do {
            let found = try await readAccounts()
            guard request == accountGeneration, !Task.isCancelled else { return }
            accounts = found
            accountsPhase = .loaded
            if !eligibleAccounts.contains(where: { $0.id == selectedAccountID }) { selectedAccountID = nil }
        } catch {
            guard request == accountGeneration, !cancelled(error) else { return }
            accountsPhase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }
    @discardableResult public func prepare() async -> Bool {
        guard canPrepare, let accountID = selectedAccountID else { return false }
        generation += 1
        let request = generation
        busy = true; error = nil; notice = nil
        defer { if request == generation { busy = false } }
        do {
            let rows = try await run(accountID, category)
            guard request == generation, !Task.isCancelled else { return false }
            notice = rows.isEmpty
                ? category == .future ? "No outlook was prepared. Check your calendar selection in Integrations." : "Bob needs at least two saved email summaries from different periods to reflect on."
                : "Your fresh perspective is ready below."
            return true
        } catch {
            guard request == generation, !cancelled(error) else { return false }
            self.error = (error as? ApiError) ?? .unknown(status: 0)
            return false
        }
    }
    public func cancel() { generation += 1; accountGeneration += 1; busy = false }
    private func cancelled(_ error: Error) -> Bool {
        Task.isCancelled || error is CancellationError || (error as? ApiError) == .cancelled
    }
}
