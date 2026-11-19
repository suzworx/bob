import Foundation

// The signed-in session lives behind SecureStore: KeychainSecureStore on a device, the in-memory one here in tests.
public enum SecureStoreError: Error, Equatable, Sendable {
    case unavailable
}

public protocol SecureStore: Sendable {
    func read(key: String) throws -> Data?
    func write(_ data: Data, key: String) throws
    func delete(key: String) throws
}

public final class InMemorySecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var available = true

    public init() {}

    public var isAvailable: Bool {
        get { lock.withLock { available } }
        set { lock.withLock { available = newValue } }
    }

    public func read(key: String) throws -> Data? {
        try lock.withLock {
            guard available else { throw SecureStoreError.unavailable }
            return values[key]
        }
    }

    public func write(_ data: Data, key: String) throws {
        try lock.withLock {
            guard available else { throw SecureStoreError.unavailable }
            values[key] = data
        }
    }

    public func delete(key: String) throws {
        try lock.withLock {
            guard available else { throw SecureStoreError.unavailable }
            values[key] = nil
        }
    }
}

public struct StoredSession: Equatable, Codable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var userID: String

    public init(accessToken: String, refreshToken: String, expiresAt: Date, userID: String) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.userID = userID
    }
}

public struct SessionStore: Sendable {
    public static let defaultKey = "bob.session"

    private let store: SecureStore
    private let key: String

    public init(store: SecureStore, key: String = SessionStore.defaultKey) {
        self.store = store
        self.key = key
    }

    public func save(_ session: StoredSession) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(session)
        try store.write(data, key: key)
    }

    // A session that cannot be decoded is cleared and reported as absent; storage errors are rethrown.
    public func load() throws -> StoredSession? {
        guard let data = try store.read(key: key) else {
            return nil
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            return try decoder.decode(StoredSession.self, from: data)
        } catch is DecodingError {
            try store.delete(key: key)
            return nil
        }
    }

    public func clear() throws {
        try store.delete(key: key)
    }

    // Exactly at the boundary counts as expired.
    public static func isExpired(_ session: StoredSession, now: Date, leeway: TimeInterval = 60) -> Bool {
        session.expiresAt <= now.addingTimeInterval(leeway)
    }
}
