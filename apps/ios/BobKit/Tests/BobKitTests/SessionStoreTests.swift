import XCTest
@testable import BobKit

final class SessionStoreTests: XCTestCase {
    private let expiry = Date(timeIntervalSince1970: 1_700_000_000)

    private func session(_ n: Int = 1) -> StoredSession {
        StoredSession(accessToken: "access-\(n)", refreshToken: "refresh-\(n)", expiresAt: expiry, userID: "user-\(n)")
    }

    private func assertUnavailable(_ body: () throws -> Void, line: UInt = #line) {
        XCTAssertThrowsError(try body(), line: line) { error in
            XCTAssertEqual(error as? SecureStoreError, .unavailable, line: line)
        }
    }

    func testSaveThenLoadRoundTripsEveryField() throws {
        let sessions = SessionStore(store: InMemorySecureStore())
        try sessions.save(session())
        let loaded = try XCTUnwrap(sessions.load())
        XCTAssertEqual(loaded.accessToken, "access-1")
        XCTAssertEqual(loaded.refreshToken, "refresh-1")
        XCTAssertEqual(loaded.expiresAt, expiry)
        XCTAssertEqual(loaded.userID, "user-1")
    }

    func testLoadOnEmptyStoreIsNil() throws {
        XCTAssertNil(try SessionStore(store: InMemorySecureStore()).load())
    }

    func testSaveTwiceKeepsOnlySecond() throws {
        let sessions = SessionStore(store: InMemorySecureStore())
        try sessions.save(session(1))
        try sessions.save(session(2))
        XCTAssertEqual(try sessions.load(), session(2))
    }

    func testClearThenLoadIsNilAndClearTwiceDoesNotThrow() throws {
        let store = InMemorySecureStore()
        let sessions = SessionStore(store: store)
        try sessions.save(session())
        try sessions.clear()
        XCTAssertNil(try sessions.load())
        XCTAssertNil(try store.read(key: SessionStore.defaultKey))
        XCTAssertNoThrow(try sessions.clear())
    }

    func testCorruptDataLoadsAsNilAndIsDeleted() throws {
        let store = InMemorySecureStore()
        try store.write(Data("not json".utf8), key: "bob.session")
        XCTAssertNil(try SessionStore(store: store).load())
        XCTAssertNil(try store.read(key: "bob.session"))
    }

    func testOtherKeyIsUntouchedBySaveLoadAndClear() throws {
        let store = InMemorySecureStore()
        try store.write(Data("other".utf8), key: "other.key")
        let sessions = SessionStore(store: store)
        try sessions.save(session())
        XCTAssertEqual(try sessions.load(), session())
        try sessions.clear()
        XCTAssertEqual(try store.read(key: "other.key"), Data("other".utf8))
    }

    func testCustomKeyIsUsed() throws {
        let store = InMemorySecureStore()
        try SessionStore(store: store, key: "custom.key").save(session())
        XCTAssertNil(try store.read(key: SessionStore.defaultKey))
        XCTAssertNotNil(try store.read(key: "custom.key"))
    }

    func testEncodedBytesAreSortedKeysWithISO8601Date() throws {
        let store = InMemorySecureStore()
        try SessionStore(store: store).save(session())
        let data = try XCTUnwrap(store.read(key: "bob.session"))
        let expected = #"{"accessToken":"access-1","expiresAt":"2023-11-14T22:13:20Z","refreshToken":"refresh-1","userID":"user-1"}"#
        XCTAssertEqual(String(decoding: data, as: UTF8.self), expected)
    }

    func testInMemoryStoreWriteReadReplaceAndDeleteMissing() throws {
        let store = InMemorySecureStore()
        XCTAssertNil(try store.read(key: "k"))
        try store.write(Data("a".utf8), key: "k")
        XCTAssertEqual(try store.read(key: "k"), Data("a".utf8))
        try store.write(Data("b".utf8), key: "k")
        XCTAssertEqual(try store.read(key: "k"), Data("b".utf8))
        try store.delete(key: "k")
        XCTAssertNil(try store.read(key: "k"))
        XCTAssertNoThrow(try store.delete(key: "missing"))
    }

    func testUnavailableStoreThrowsFromEveryMethod() {
        let store = InMemorySecureStore()
        XCTAssertTrue(store.isAvailable)
        store.isAvailable = false
        XCTAssertFalse(store.isAvailable)
        assertUnavailable { _ = try store.read(key: "k") }
        assertUnavailable { try store.write(Data("a".utf8), key: "k") }
        assertUnavailable { try store.delete(key: "k") }
    }

    func testSessionStoreRethrowsUnavailable() {
        let store = InMemorySecureStore()
        store.isAvailable = false
        let sessions = SessionStore(store: store)
        assertUnavailable { try sessions.save(self.session()) }
        assertUnavailable { _ = try sessions.load() }
        assertUnavailable { try sessions.clear() }
    }

    func testIsExpiredWithDefaultLeeway() {
        let s = session()
        XCTAssertFalse(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-3600)))
        XCTAssertTrue(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-60)))
        XCTAssertFalse(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-61)))
        XCTAssertTrue(SessionStore.isExpired(s, now: expiry.addingTimeInterval(1)))
        XCTAssertEqual(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-60)), SessionStore.isExpired(s, now: expiry.addingTimeInterval(-60), leeway: 60))
    }

    func testIsExpiredHonoursCustomLeeway() {
        let s = session()
        XCTAssertTrue(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-300), leeway: 300))
        XCTAssertFalse(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-301), leeway: 300))
        XCTAssertFalse(SessionStore.isExpired(s, now: expiry.addingTimeInterval(-1), leeway: 0))
        XCTAssertTrue(SessionStore.isExpired(s, now: expiry, leeway: 0))
    }
}
