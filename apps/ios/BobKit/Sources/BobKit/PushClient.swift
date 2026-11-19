import Foundation

public struct PushDeviceRegistration: Equatable, Sendable {
    public enum Environment: String, Sendable { case sandbox, production }
    public let installationID: String
    public let token: String
    public let environment: Environment
    public let topic: String
    public let appVersion: String
    public let localTimerIDs: [String]

    public init(installationID: String, token: String, environment: Environment, topic: String, appVersion: String, localTimerIDs: [String]) {
        self.installationID = installationID; self.token = token; self.environment = environment
        self.topic = topic; self.appVersion = appVersion; self.localTimerIDs = localTimerIDs
    }

    var valid: Bool {
        UUID(uuidString: installationID) != nil && token.range(of: "^(?:[a-fA-F0-9]{2}){32,256}$", options: .regularExpression) != nil &&
            topic.range(of: "^[a-zA-Z0-9.-]{1,120}$", options: .regularExpression) != nil &&
            !appVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && appVersion.count <= 40 &&
            localTimerIDs.count <= 60 && localTimerIDs.allSatisfy { UUID(uuidString: $0) != nil }
    }
}

/// This client captures one immutable access token. A queued logout can never
/// accidentally authenticate as the next person who signs in on this phone.
public struct PushClient: Sendable {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = PushClient.registrationSession, token: String) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: { token }, reauthenticate: nil)
    }

    public static var registrationSession: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 10
        return URLSession(configuration: configuration)
    }

    public func register(_ input: PushDeviceRegistration) async throws -> Bool {
        guard input.valid else { throw ApiError.invalidRequest }
        let response: Registered = try await http.decoded("POST", ["push", "devices"], body: [
            "installation_id": input.installationID, "token": input.token, "environment": input.environment.rawValue,
            "topic": input.topic, "app_version": input.appVersion, "local_timer_ids": input.localTimerIDs
        ])
        guard response.registered else { throw ApiError.unknown(status: 200) }
        return response.deliveryAvailable
    }

    public func remove(installationID: String) async throws {
        guard UUID(uuidString: installationID) != nil else { throw ApiError.invalidRequest }
        try await http.empty("DELETE", ["push", "devices", installationID])
    }

    private struct Registered: Decodable {
        let registered: Bool
        let deliveryAvailable: Bool
        enum CodingKeys: String, CodingKey { case registered; case deliveryAvailable = "delivery_available" }
    }
}

public struct PushRegistrationSession: Sendable {
    public let accountID: String
    let register: @MainActor @Sendable (PushDeviceRegistration) async throws -> Bool
    let remove: @MainActor @Sendable (String) async throws -> Void

    public init(accountID: String, register: @escaping @MainActor @Sendable (PushDeviceRegistration) async throws -> Bool,
                remove: @escaping @MainActor @Sendable (String) async throws -> Void) {
        self.accountID = accountID; self.register = register; self.remove = remove
    }
}

/// Serializes remote mutations, including compensating deletion of a POST that
/// finishes after logout. Every deletion retains the original account's client.
@MainActor public final class PushRegistrationCoordinator {
    public private(set) var deliveryAvailable: Bool?
    public private(set) var errorMessage: String?
    public private(set) var accountID: String?
    private var generation = 0
    private var mutations: Task<Void, Never>?
    private var bound: (session: PushRegistrationSession, installationID: String)?

    public init() {}

    public func register(_ input: PushDeviceRegistration, session: PushRegistrationSession) async {
        generation += 1
        let attempt = generation
        accountID = session.accountID
        deliveryAvailable = nil
        errorMessage = nil
        await enqueue { [self] in
            guard generation == attempt else { return }
            if let old = bound, old.session.accountID != session.accountID || old.installationID != input.installationID {
                try? await old.session.remove(old.installationID)
                bound = nil
            }
            guard generation == attempt else { return }
            bound = (session, input.installationID)
            do {
                let available = try await session.register(input)
                guard generation == attempt else {
                    try? await session.remove(input.installationID)
                    bound = nil
                    return
                }
                deliveryAvailable = available
            } catch {
                if generation == attempt {
                    deliveryAvailable = nil
                    errorMessage = "Bob couldn't connect iPhone push alerts. Try again when you're online."
                }
            }
        }
    }

    public func signOut() async {
        generation += 1
        accountID = nil
        deliveryAvailable = nil
        errorMessage = nil
        await enqueue { [self] in
            if let old = bound { try? await old.session.remove(old.installationID) }
            bound = nil
        }
    }

    private func enqueue(_ operation: @escaping @MainActor () async -> Void) async {
        let previous = mutations
        let next = Task { @MainActor in await previous?.value; await operation() }
        mutations = next
        await next.value
    }
}
