import BobKit
import Foundation

@MainActor enum AdminServices {
    static func access() -> AdministrativeAccessModel {
        let client = AppSession.make { AdminClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        return AdministrativeAccessModel { scope in
            guard let client else { return false }
            return try await client.access(scope)
        }
    }
    static func accounts() -> NativeAdminModel {
        if let pair = AppSession.make({ base, token, reauth in
            (AdminClient(baseURL: base, accessToken: token, reauthenticate: reauth),
             PrivateSpace(client: SpacesClient(baseURL: base, accessToken: token, reauthenticate: reauth)))
        }) {
            return NativeAdminModel(client: pair.0, identity: { try await pair.1.selfID() })
        }
        return NativeAdminModel(client: nil, identity: { nil })
    }
    static func metrics() -> OperatorMetricsModel {
        if let pair = AppSession.make({ base, token, reauth in
            (AdminClient(baseURL: base, accessToken: token, reauthenticate: reauth),
             OperatorMetricsClient(baseURL: base, accessToken: token, reauthenticate: reauth))
        }) {
            return OperatorMetricsModel(probe: { try await pair.0.access(.metrics) }, read: { try await pair.1.document(page: $0, range: $1) })
        }
        return OperatorMetricsModel(probe: { false }, read: { _, _ in throw ApiError.unauthenticated })
    }
    static func date(_ text: String?) -> String {
        guard let text else { return "Never" }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return "Unknown" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
