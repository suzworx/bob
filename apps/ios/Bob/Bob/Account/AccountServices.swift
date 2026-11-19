import BobKit
import Foundation

protocol AccountService: Sendable {
    func profile() async -> AccountProfile?
    func setName(_ name: String) async throws
    func setTimeZone(_ zone: String) async throws
    func usage(_ range: UsageRange) async throws -> UsageReport
    func export() async throws -> AccountExport
    func deleteAccount() async throws
    func signOutEverywhere() async throws
}

protocol NotificationsService: Sendable {
    func list(limit: Int, after: Int?, unreadOnly: Bool) async throws -> InboxPage
    func markRead(ids: [String]) async throws
    func markRead(upToCursor: Int) async throws
    func preferences() async throws -> [NotificationPreference]
    func setMuted(_ kind: NotificationKind, muted: Bool) async throws -> NotificationPreference
}

protocol DevicesService: Sendable {
    func devices() async throws -> [Device]
    func activity(deviceID: String) async throws -> [DeviceActivityItem]
    func rename(deviceID: String, name: String) async throws -> String
    func update(deviceID: String, change: DeviceSettingChange) async throws -> DeviceSettingsUpdate
    func remove(deviceID: String) async throws
    func announce(deviceID: String, title: String, body: String?, ring: Bool) async throws -> AnnounceStatus
    func pair(code: String, name: String?) async throws -> PairedDevice
    func talkChoices() async throws -> DeviceTalkChoices
    func setTalkingIn(deviceID: String, target: DeviceTalkTarget) async throws
    func setNewConversationSpace(deviceID: String, spaceID: String?) async throws
    // A fresh thread for a device to talk in; the server needs a title, and it's renamed once it has turns.
    func startThread(spaceID: String) async throws -> SpaceThread
}

// What a device could talk in, and where it could start.
struct DeviceTalkChoices {
    let options: [DeviceTalkOption]
    let spaces: [SpaceSummary]
}

// The session behind the live account service. Nil parts mean a developer token: nothing to edit and nothing to sign out of.
struct LiveAccountService: AccountService {
    let client: AccountClient
    let auth: SupabaseAuthClient?
    let manager: SessionManager?
    let fixedToken: String?

    private func token() async -> String? {
        if let fixedToken { return fixedToken }
        return try? await manager?.accessToken()
    }

    func profile() async -> AccountProfile? {
        guard let token = await token() else { return nil }
        return AccountProfile(accessToken: token)
    }

    // The token carries the name and zone, so it is refreshed for the server to see them on the next request.
    private func saveMetadata(_ fields: [String: String]) async throws {
        guard let auth, let manager, let token = try await manager.accessToken() else { throw ApiError.unauthenticated }
        try await auth.updateMetadata(accessToken: token, fields)
        _ = try? await manager.accessToken(replacing: token)
    }

    func setName(_ name: String) async throws { try await saveMetadata(["name": name, "full_name": name]) }
    func setTimeZone(_ zone: String) async throws { try await saveMetadata(["time_zone": zone]) }
    func usage(_ range: UsageRange) async throws -> UsageReport { try await client.usage(range) }
    func export() async throws -> AccountExport { try await client.export() }
    func deleteAccount() async throws { try await client.deleteAccount() }

    func signOutEverywhere() async throws {
        guard let auth, let manager, let token = try await manager.accessToken() else { throw ApiError.unauthenticated }
        try await auth.signOutEverywhere(accessToken: token)
    }
}

struct LiveNotificationsService: NotificationsService {
    let client: NotificationsClient

    func list(limit: Int, after: Int?, unreadOnly: Bool) async throws -> InboxPage {
        try await client.list(limit: limit, after: after, unreadOnly: unreadOnly)
    }
    func markRead(ids: [String]) async throws { try await client.markRead(ids: ids) }
    func markRead(upToCursor: Int) async throws { try await client.markRead(upToCursor: upToCursor) }
    func preferences() async throws -> [NotificationPreference] { try await client.preferences() }
    func setMuted(_ kind: NotificationKind, muted: Bool) async throws -> NotificationPreference {
        try await client.setMuted(kind, muted: muted)
    }
}

struct LiveDevicesService: DevicesService {
    let client: DevicesClient
    let conversations: ConversationsService
    let spaces: SpacesClient
    let threads: ThreadsClient

    func talkChoices() async throws -> DeviceTalkChoices {
        async let chats = conversations.list(query: nil, archived: false)
        async let found = spaces.spaces()
        let (recent, all) = try await (chats, found)
        var inSpaces: [(space: SpaceSummary, threads: [SpaceThread])] = []
        // A space whose threads don't load just isn't offered.
        for space in all where SpaceRules.isShared(space) {
            inSpaces.append((space, (try? await threads.threads(spaceID: space.id)) ?? []))
        }
        return DeviceTalkChoices(options: DeviceTalkRules.options(conversations: recent, threads: inSpaces), spaces: all)
    }
    func setTalkingIn(deviceID: String, target: DeviceTalkTarget) async throws { try await client.setTalkingIn(deviceID: deviceID, target: target) }
    func setNewConversationSpace(deviceID: String, spaceID: String?) async throws { try await client.setNewConversationSpace(deviceID: deviceID, spaceID: spaceID) }
    func startThread(spaceID: String) async throws -> SpaceThread { try await threads.create(spaceID: spaceID, title: "Device conversation") }

    func devices() async throws -> [Device] { try await client.devices() }
    func activity(deviceID: String) async throws -> [DeviceActivityItem] { try await client.activity(deviceID: deviceID) }
    func rename(deviceID: String, name: String) async throws -> String { try await client.rename(deviceID: deviceID, name: name) }
    func update(deviceID: String, change: DeviceSettingChange) async throws -> DeviceSettingsUpdate {
        try await client.update(deviceID: deviceID, change: change)
    }
    func remove(deviceID: String) async throws { try await client.remove(deviceID: deviceID) }
    func announce(deviceID: String, title: String, body: String?, ring: Bool) async throws -> AnnounceStatus {
        try await client.announce(deviceID: deviceID, title: title, body: body, ring: ring)
    }

    func pair(code: String, name: String?) async throws -> PairedDevice {
        let found = try await client.lookUpPairing(code: code)
        return try await client.approvePairing(id: found.pairingID, name: name)
    }
}

// What the You tab talks to, and what this build can do with a session.
struct AccountServices {
    let account: AccountService
    let notifications: NotificationsService
    let devices: DevicesService
    // A real session: the profile can be edited, and signing out means something.
    let hasSession: Bool
    // Made-up data, where nothing is really deleted.
    let isDemo: Bool

    @MainActor static func make() -> AccountServices {
        let account = AppSession.make { AccountClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let notifications = AppSession.make { NotificationsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let devices = AppSession.make { DevicesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let conversations = AppSession.make { ConversationsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let spaces = AppSession.make { SpacesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        let threads = AppSession.make { ThreadsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        guard let account, let notifications, let devices, let conversations, let spaces, let threads else { return .demo() }
        return AccountServices(
            account: LiveAccountService(client: account, auth: AppSession.authClient, manager: AppSession.manager, fixedToken: AppSession.manager == nil ? AppConfig.devToken : nil),
            notifications: LiveNotificationsService(client: notifications),
            devices: LiveDevicesService(client: devices, conversations: conversations, spaces: spaces, threads: threads),
            hasSession: AppSession.manager != nil,
            isDemo: false
        )
    }

    static func demo() -> AccountServices {
        AccountServices(account: StubAccountService(), notifications: StubNotificationsService(), devices: StubDevicesService(), hasSession: false, isDemo: true)
    }
}
