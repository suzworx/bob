import Foundation
import Security

// The session's home on a device: readable after the first unlock so a background refresh works, and never copied to another device.
public struct KeychainSecureStore: SecureStore {
    private let service: String

    public init(service: String = "app.bob.ios") {
        self.service = service
    }

    public func read(key: String) throws -> Data? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw SecureStoreError.unavailable
        }
        return result as? Data
    }

    public func write(_ data: Data, key: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(baseQuery(key: key) as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess {
            return
        }
        guard status == errSecItemNotFound else {
            throw SecureStoreError.unavailable
        }
        let added = SecItemAdd(baseQuery(key: key).merging(attributes) { _, new in new } as CFDictionary, nil)
        guard added == errSecSuccess else {
            throw SecureStoreError.unavailable
        }
    }

    public func delete(key: String) throws {
        let status = SecItemDelete(baseQuery(key: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecureStoreError.unavailable
        }
    }

    private func baseQuery(key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }
}
