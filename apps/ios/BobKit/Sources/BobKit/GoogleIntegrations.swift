import Foundation
import Observation

public enum GoogleCapability: String, Decodable, Sendable {
    case calendarRead = "calendar.read", calendarWrite = "calendar.write"
    case mailRead = "gmail.read", mailDraft = "gmail.draft", mailSend = "gmail.send", mailModify = "gmail.modify"

    public var title: String {
        switch self {
        case .calendarRead: "Read calendars"
        case .calendarWrite: "Edit calendar events"
        case .mailRead: "Read mail"
        case .mailDraft: "Manage mail drafts"
        case .mailSend: "Send reviewed drafts when asked"
        case .mailModify: "Move mail to Trash and restore"
        }
    }
}

/// Public account metadata only. Provider credentials stay in Core.
public struct GoogleIntegrationAccount: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let email: String
    public let name: String?
    public let customName: String?
    public let selected: Bool
    public let createdAt: Date
    public let access: [GoogleCapability]
    public let needsReconnect: Bool
    public var displayName: String { customName ?? email }

    public init(id: String, email: String, name: String? = nil, customName: String? = nil, selected: Bool, createdAt: Date, access: [GoogleCapability], needsReconnect: Bool) {
        self.id = id; self.email = email; self.name = name; self.customName = customName
        self.selected = selected; self.createdAt = createdAt; self.access = access; self.needsReconnect = needsReconnect
    }
}

public struct GoogleIntegrationCalendar: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let timeZone: String?
    public let selected: Bool
    public let selectable: Bool
    public let readOnly: Bool
    enum CodingKeys: String, CodingKey {
        case id, title, selected, selectable
        case timeZone = "time_zone", readOnly = "read_only"
    }
}

public struct GoogleCalendarPage: Decodable, Sendable {
    public let calendars: [GoogleIntegrationCalendar]
    public let selectedCalendarIDs: [String]
    public let nextPageToken: String?
    enum CodingKeys: String, CodingKey {
        case calendars
        case selectedCalendarIDs = "selected_calendar_ids", nextPageToken = "next_page_token"
    }
}

public protocol GoogleIntegrationsService: Sendable {
    func accounts() async throws -> [GoogleIntegrationAccount]
    func rename(id: String, name: String?) async throws -> GoogleIntegrationAccount
    func select(id: String) async throws
    func disconnect(id: String) async throws
    func calendars(id: String, pageToken: String?) async throws -> GoogleCalendarPage
    func saveCalendars(id: String, calendarIDs: [String]) async throws
}

public struct GoogleIntegrationsClient: GoogleIntegrationsService {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func accounts() async throws -> [GoogleIntegrationAccount] {
        let result: GoogleAccountsResponse = try await http.decoded("GET", ["google-accounts"])
        return result.accounts
    }
    public func rename(id: String, name: String?) async throws -> GoogleIntegrationAccount {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, trimmed.isEmpty || trimmed.utf16.count > 60 { throw ApiError.invalidRequest }
        let result: GoogleAccountResponse = try await http.decoded("PATCH", ["google-accounts", id], body: ["customName": trimmed.map { $0 as Any } ?? NSNull()])
        return result.account
    }
    public func select(id: String) async throws { try await http.empty("POST", ["google-accounts", id, "select"]) }
    public func disconnect(id: String) async throws { try await http.empty("DELETE", ["google-accounts", id]) }
    public func calendars(id: String, pageToken: String? = nil) async throws -> GoogleCalendarPage {
        try await http.decoded("GET", ["google-accounts", id, "calendars"], query: pageToken.map { [URLQueryItem(name: "pageToken", value: $0)] } ?? [])
    }
    public func saveCalendars(id: String, calendarIDs: [String]) async throws {
        guard calendarIDs.count <= 5, Set(calendarIDs).count == calendarIDs.count else { throw ApiError.invalidRequest }
        try await http.empty("PUT", ["google-accounts", id, "calendars", "selection"], body: ["calendarIds": calendarIDs])
    }
}
private struct GoogleAccountsResponse: Decodable { let accounts: [GoogleIntegrationAccount] }
private struct GoogleAccountResponse: Decodable { let account: GoogleIntegrationAccount }

@MainActor @Observable public final class GoogleAccountsModel {
    public private(set) var accounts: [GoogleIntegrationAccount] = []
    public private(set) var loaded = false
    public private(set) var busy = false
    public private(set) var error: ApiError?
    @ObservationIgnored public let service: any GoogleIntegrationsService
    @ObservationIgnored private var generation = 0
    public init(service: any GoogleIntegrationsService) { self.service = service }

    public func refresh() async {
        guard !busy else { return }
        generation += 1
        let request = generation
        error = nil
        do {
            let rows = try await service.accounts()
            guard request == generation, !Task.isCancelled else { return }
            accounts = rows; loaded = true
        } catch {
            guard request == generation, !Self.cancelled(error) else { return }
            self.error = (error as? ApiError) ?? .unknown(status: 0)
        }
    }
    public func rename(_ account: GoogleIntegrationAccount, name: String?) async -> Bool {
        await change {
            let updated = try await self.service.rename(id: account.id, name: name)
            self.accounts = self.accounts.map { $0.id == updated.id ? updated : $0 }
        }
    }
    public func makeDefault(_ account: GoogleIntegrationAccount) async -> Bool {
        await change {
            try await self.service.select(id: account.id)
            self.accounts = try await self.service.accounts()
        }
    }
    public func remove(_ account: GoogleIntegrationAccount) async -> Bool {
        await change {
            try await self.service.disconnect(id: account.id)
            self.accounts.removeAll { $0.id == account.id }
        }
    }
    private func change(_ action: () async throws -> Void) async -> Bool {
        guard !busy else { return false }
        generation += 1 // An older read must never overwrite the write.
        busy = true; error = nil
        defer { busy = false }
        do { try await action(); return true }
        catch { if !Self.cancelled(error) { self.error = (error as? ApiError) ?? .unknown(status: 0) }; return false }
    }
    private static func cancelled(_ error: Error) -> Bool { error is CancellationError || (error as? ApiError) == .cancelled || Task.isCancelled }
    public func cancelReads() { generation += 1 }
}

@MainActor @Observable public final class GoogleCalendarsModel {
    public private(set) var calendars: [GoogleIntegrationCalendar] = []
    public var selected: Set<String> = []
    public private(set) var next: String?
    public private(set) var loaded = false
    public private(set) var busy = false
    public private(set) var error: ApiError?
    @ObservationIgnored private let accountID: String
    @ObservationIgnored private let service: any GoogleIntegrationsService
    @ObservationIgnored private var generation = 0
    public init(accountID: String, service: any GoogleIntegrationsService) { self.accountID = accountID; self.service = service }
    public var outsidePage: [String] { selected.filter { id in !calendars.contains { $0.id == id } }.sorted() }

    public func load(more: Bool = false) async {
        guard !busy, !more || next != nil else { return }
        generation += 1
        let request = generation
        let token = more ? next : nil
        busy = true; error = nil
        defer { if request == generation { busy = false } }
        do {
            let page = try await service.calendars(id: accountID, pageToken: token)
            guard request == generation, !Task.isCancelled else { return }
            if more {
                for calendar in page.calendars {
                    if let index = calendars.firstIndex(where: { $0.id == calendar.id }) { calendars[index] = calendar }
                    else { calendars.append(calendar) }
                }
            } else { calendars = page.calendars; selected = Set(page.selectedCalendarIDs) }
            next = page.nextPageToken == token ? nil : page.nextPageToken
            loaded = true
        } catch {
            guard request == generation, !(error is CancellationError), (error as? ApiError) != .cancelled, !Task.isCancelled else { return }
            self.error = (error as? ApiError) ?? .unknown(status: 0)
        }
    }
    public func save() async -> Bool {
        guard loaded, !busy, selected.count <= 5 else { return false }
        busy = true; error = nil
        defer { busy = false }
        do { try await service.saveCalendars(id: accountID, calendarIDs: selected.sorted()); return true }
        catch { if !(error is CancellationError), (error as? ApiError) != .cancelled { self.error = (error as? ApiError) ?? .unknown(status: 0) }; return false }
    }
    public func cancel() { generation += 1; busy = false }
}
