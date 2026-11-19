import BobKit
import Foundation

@MainActor enum IntegrationServices {
    static func make() -> (model: GoogleAccountsModel, preview: Bool) {
        if let live = AppSession.make({ baseURL, token, reauthenticate in
            GoogleIntegrationsClient(baseURL: baseURL, accessToken: token, reauthenticate: reauthenticate)
        }) {
            return (GoogleAccountsModel(service: live), false)
        }
        #if DEBUG
        return (GoogleAccountsModel(service: demo), true)
        #else
        return (GoogleAccountsModel(service: UnavailableIntegrations()), false)
        #endif
    }
    #if DEBUG
    private static let demo = DemoIntegrations()
    #endif
}

private struct UnavailableIntegrations: GoogleIntegrationsService {
    func accounts() async throws -> [GoogleIntegrationAccount] { throw ApiError.unauthenticated }
    func rename(id: String, name: String?) async throws -> GoogleIntegrationAccount { throw ApiError.unauthenticated }
    func select(id: String) async throws { throw ApiError.unauthenticated }
    func disconnect(id: String) async throws { throw ApiError.unauthenticated }
    func calendars(id: String, pageToken: String?) async throws -> GoogleCalendarPage { throw ApiError.unauthenticated }
    func saveCalendars(id: String, calendarIDs: [String]) async throws { throw ApiError.unauthenticated }
}

#if DEBUG
private actor DemoIntegrations: GoogleIntegrationsService {
    private var rows = [GoogleIntegrationAccount(id: "11111111-1111-4111-8111-111111111111", email: "alex@example.test", customName: "Personal", selected: true, createdAt: Date(timeIntervalSince1970: 1700000000), access: [.calendarRead, .mailRead], needsReconnect: false)]
    private var selected = ["family"]
    func accounts() -> [GoogleIntegrationAccount] { rows }
    func rename(id: String, name: String?) throws -> GoogleIntegrationAccount {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { throw ApiError.notFound }
        let old = rows[index]
        let updated = GoogleIntegrationAccount(id: old.id, email: old.email, customName: name, selected: old.selected, createdAt: old.createdAt, access: old.access, needsReconnect: old.needsReconnect)
        rows[index] = updated
        return updated
    }
    func select(id: String) throws { guard rows.contains(where: { $0.id == id }) else { throw ApiError.notFound } }
    func disconnect(id: String) { rows.removeAll { $0.id == id } }
    func calendars(id: String, pageToken: String?) throws -> GoogleCalendarPage {
        let calendars: [[String: Any]] = ["family", "personal"].map {
            ["id": $0, "title": $0.capitalized, "time_zone": "America/Los_Angeles", "selected": selected.contains($0), "selectable": true, "read_only": true]
        }
        let data = try JSONSerialization.data(withJSONObject: ["calendars": calendars, "selected_calendar_ids": selected])
        return try JSONDecoder().decode(GoogleCalendarPage.self, from: data)
    }
    func saveCalendars(id: String, calendarIDs: [String]) { selected = calendarIDs }
}
#endif
