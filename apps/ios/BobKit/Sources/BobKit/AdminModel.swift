import Foundation
import Observation

@MainActor @Observable public final class AdministrativeAccessModel {
    public private(set) var admin = false
    public private(set) var metrics = false
    public private(set) var error: ApiError?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let probe: @Sendable (AdministrativeAccess) async throws -> Bool
    public init(probe: @escaping @Sendable (AdministrativeAccess) async throws -> Bool) { self.probe = probe }
    public func refresh() async {
        generation += 1; let request = generation
        admin = false; metrics = false; error = nil
        async let a = result(.admin); async let m = result(.metrics)
        let results = await (a, m)
        guard request == generation, !Task.isCancelled else { return }
        switch results.0 { case .success(let allowed): admin = allowed; case .failure(let problem): error = problem }
        switch results.1 { case .success(let allowed): metrics = allowed; case .failure(let problem): error = problem }
    }
    private func result(_ scope: AdministrativeAccess) async -> Result<Bool, ApiError> {
        do { return .success(try await probe(scope)) }
        catch { return .failure((error as? ApiError) ?? .unknown(status: 0)) }
    }
}

@MainActor @Observable public final class NativeAdminModel {
    public enum Tab: String, CaseIterable { case accounts, waitlist }
    public var tab: Tab = .accounts
    public var query = ""
    public var filter: AdminWaitlistStatus = .all
    public private(set) var allowed = false
    public private(set) var accounts: [AdminAccount] = []
    public private(set) var entries: [AdminWaitlistEntry] = []
    public private(set) var accountCounts: AdminAccountCounts?
    public private(set) var waitlistCounts: AdminWaitlistCounts?
    public private(set) var nextCursor: String?
    public private(set) var phase: InsightLoadPhase = .loading
    public private(set) var busy = false
    public private(set) var message: String?
    public private(set) var selfID: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var searchedQuery = ""
    @ObservationIgnored private var searchedFilter = AdminWaitlistStatus.all
    @ObservationIgnored private let client: AdminClient?
    @ObservationIgnored private let identity: @Sendable () async throws -> String?
    public init(client: AdminClient?, identity: @escaping @Sendable () async throws -> String?) { self.client = client; self.identity = identity }
    public func load(more: Bool = false) async {
        guard !busy else { return }
        guard let client else { phase = .failed(.unauthenticated); return }
        if more && nextCursor == nil { return }
        generation += 1; let request = generation; let tab = tab
        let cursor = more ? nextCursor : nil
        let query = more ? searchedQuery : query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filter = more ? searchedFilter : filter
        busy = true; message = nil
        if !more { phase = .loading }
        defer { if request == generation { busy = false } }
        do {
            guard try await client.access(.admin) else { throw ApiError.forbidden }
            let owner = try await identity()
            guard owner != nil else { throw ApiError.unauthenticated }
            if tab == .accounts {
                let page = try await client.accounts(query: query, cursor: cursor)
                guard current(request, tab: tab) else { return }
                let known = more ? Set(accounts.map(\.id)) : []
                accounts = (more ? accounts : []) + page.accounts.filter { !known.contains($0.id) }
                accountCounts = page.counts; nextCursor = page.nextCursor == cursor ? nil : page.nextCursor
            } else {
                let page = try await client.waitlist(query: query, status: filter, cursor: cursor)
                guard current(request, tab: tab) else { return }
                let known = more ? Set(entries.map(\.id)) : []
                entries = (more ? entries : []) + page.entries.filter { !known.contains($0.id) }
                waitlistCounts = page.counts; nextCursor = page.nextCursor == cursor ? nil : page.nextCursor
            }
            selfID = owner; allowed = true; phase = .loaded; searchedQuery = query; searchedFilter = filter
        } catch {
            guard current(request, tab: tab), !cancelled(error) else { return }
            refusal(error)
            if more && allowed { message = "Couldn't load more people. Try again." }
            else { phase = .failed((error as? ApiError) ?? .unknown(status: 0)) }
        }
    }
    public func manage(_ account: AdminAccount, action: AdminAccountAction) async -> Bool {
        guard allowed, !busy, let client, account.actions(selfID: selfID).contains(action), accounts.contains(where: { $0.id == account.id }) else { return false }
        busy = true; generation += 1; let request = generation
        defer { if request == generation { busy = false } }
        do {
            try await client.manage(accountID: account.id, action: action)
            guard request == generation, !Task.isCancelled else { return false }
            busy = false; await load(); return true
        } catch {
            guard request == generation, !cancelled(error) else { return false }
            busy = false; refusal(error)
            message = (error as? ApiError) == .unknown(status: 409)
                ? "This change is protected. You can't disable yourself, remove your own admin access, or remove the last admin."
                : "Couldn't confirm this change. Refresh to check the account before trying again."
            return false
        }
    }
    public func invite(email: String, retry: Bool) async throws -> AdminInvitationResult {
        guard allowed, !busy, let client else { throw ApiError.forbidden }
        busy = true; generation += 1; let request = generation
        defer { if request == generation { busy = false } }
        do {
            let result = try await client.invite(email: email, retry: retry)
            guard request == generation, !Task.isCancelled else { throw ApiError.cancelled }
            return result
        } catch { if request == generation { refusal(error) }; throw error }
    }
    public func cancel() { generation += 1; busy = false }
    private func current(_ request: Int, tab: Tab) -> Bool { request == generation && tab == self.tab && !Task.isCancelled }
    private func cancelled(_ error: Error) -> Bool { Task.isCancelled || error is CancellationError || (error as? ApiError) == .cancelled }
    private func refusal(_ error: Error) {
        if Self.accessRefused(error) { allowed = false; accounts = []; entries = []; accountCounts = nil; waitlistCounts = nil; nextCursor = nil; phase = .failed(.forbidden) }
    }
    static func accessRefused(_ error: Error) -> Bool {
        [.unauthenticated, .forbidden, .notFound].contains((error as? ApiError) ?? .unknown(status: 0))
    }
}
