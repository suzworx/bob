import BobKit
import Foundation

// Made-up data for previews and the demo build, held in memory only.
actor StubAccountService: AccountService {
    private var current = AccountProfile(email: "sam@example.com", name: "Sam Example", timeZone: TimeZone.current.identifier)
    private var lastExport: Date?

    private func pause() async throws {
        if demoDelay > .zero { try await Task.sleep(for: demoDelay) }
    }

    func profile() async -> AccountProfile? { current }

    func setName(_ name: String) async throws {
        try await pause()
        current.name = name
    }

    func setTimeZone(_ zone: String) async throws {
        try await pause()
        current.timeZone = zone
    }

    func usage(_ range: UsageRange) async throws -> UsageReport {
        try await pause()
        let calendar = Calendar(identifier: .gregorian)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let days = (0..<range.days).reversed().map { offset -> UsageDay in
            let date = calendar.date(byAdding: .day, value: -offset, to: Date()) ?? Date()
            let busy = offset % 3 != 2
            return UsageDay(day: formatter.string(from: date), counts: UsageSurfaceCounts(device: busy ? (offset % 4) + 1 : 0, voice: busy ? offset % 3 : 0, typed: busy ? (offset % 5) + 1 : 0))
        }
        let surface = UsageSurfaceCounts(
            device: days.reduce(0) { $0 + $1.counts.device },
            voice: days.reduce(0) { $0 + $1.counts.voice },
            typed: days.reduce(0) { $0 + $1.counts.typed }
        )
        return UsageReport(
            activeDays: days.filter { $0.counts.device + $0.counts.voice + $0.counts.typed > 0 }.count,
            turns: .init(total: surface.device + surface.voice + surface.typed, bySurface: surface, byDay: days, byWeekdayHour: [UsageWeekdayHour(hour: 8, count: 6), UsageWeekdayHour(hour: 20, count: 9)]),
            conversationsCreated: range.days / 3,
            created: .init(tasks: range.days / 4, notes: 2, reminders: 1),
            todosDone: range.days / 2,
            memories: .init(newInRange: 2, total: 9),
            gameMinutes: nil
        )
    }

    // Keeps the server's one-a-minute limit, so its message can be seen.
    func export() async throws -> AccountExport {
        try await pause()
        if let lastExport, Date().timeIntervalSince(lastExport) < 60 { throw ApiError.rateLimited(retryAfterSeconds: nil) }
        lastExport = Date()
        return AccountExport(data: Data(#"{"format":"bob.account-export","version":1,"demo":true}"#.utf8), fileName: "bob-demo-export.json")
    }

    func deleteAccount() async throws { try await pause() }
    func signOutEverywhere() async throws { try await pause() }
}

actor StubNotificationsService: NotificationsService {
    private var items: [InboxNotification]
    private var saved: [NotificationPreference] = [NotificationPreference(kind: .taskUpdate, muted: true)]

    init(now: Date = Date()) {
        func item(_ cursor: Int, _ kind: NotificationKind, read: Bool = false, hours: Double, resource: String = "demo-r", about: NotificationAbout?) -> InboxNotification {
            InboxNotification(id: "demo-n\(cursor)", spaceID: "demo-space", kind: kind, resourceType: "demo", resourceID: resource, cursor: cursor, readAt: read ? now : nil, createdAt: now.addingTimeInterval(-3600 * hours), about: about)
        }
        items = [
            item(6, .reminder, hours: 1, about: NotificationAbout(title: "Water the plants", at: now.addingTimeInterval(3600))),
            item(5, .security, hours: 3, resource: "demo-d1", about: NotificationAbout(title: "Kitchen", action: "device_paired")),
            item(4, .mention, hours: 26, about: NotificationAbout(actorName: "Alex", title: "Weekend plans", spaceName: "Family")),
            item(3, .eventChange, read: true, hours: 30, about: NotificationAbout(actorName: "Alex", title: "Dentist", at: now.addingTimeInterval(86400 * 3), action: "updated")),
            item(2, .invitation, read: true, hours: 60, about: NotificationAbout(actorName: "Alex", spaceName: "Family")),
            item(1, .bobMessage, read: true, hours: 90, about: nil)
        ]
    }

    private func pause() async throws {
        if demoDelay > .zero { try await Task.sleep(for: demoDelay) }
    }

    func list(limit: Int, after: Int?, unreadOnly: Bool) async throws -> InboxPage {
        try await pause()
        let matching = items.filter { item in
            if let after, item.cursor >= after { return false }
            return !unreadOnly || item.isUnread
        }
        let page = Array(matching.prefix(limit))
        return InboxPage(notifications: page, nextCursor: page.count == limit ? page.last?.cursor : nil, unreadCount: items.filter(\.isUnread).count)
    }

    func markRead(ids: [String]) async throws {
        try await pause()
        for index in items.indices where ids.contains(items[index].id) { items[index].readAt = Date() }
    }

    func markRead(upToCursor: Int) async throws {
        try await pause()
        for index in items.indices where items[index].cursor <= upToCursor { items[index].readAt = Date() }
    }

    func preferences() async throws -> [NotificationPreference] {
        try await pause()
        return saved
    }

    func setMuted(_ kind: NotificationKind, muted: Bool) async throws -> NotificationPreference {
        try await pause()
        let preference = NotificationPreference(kind: kind, muted: muted)
        saved.removeAll { $0.kind == kind }
        saved.append(preference)
        return preference
    }
}

actor StubDevicesService: DevicesService {
    private var all: [Device]

    init(now: Date = Date()) {
        all = [
            Device(id: "demo-d1", name: "Kitchen", model: "Bob (Waveshare 1.85C)", pairedAt: now.addingTimeInterval(-86400 * 30), lastSeenAt: now, connected: true, settings: DeviceSettings(volume: 6, mode: .wake, ringSeconds: 30, ringSound: .chime), live: DeviceLive(connected: true, batteryPercent: 82, charging: false, firmware: "1.4.0")),
            Device(id: "demo-d2", name: "Desk", model: "Cardputer", pairedAt: now.addingTimeInterval(-86400 * 60), lastSeenAt: now.addingTimeInterval(-86400 * 2), ringSettingsSupported: false)
        ]
    }

    private func pause() async throws {
        if demoDelay > .zero { try await Task.sleep(for: demoDelay) }
    }

    func devices() async throws -> [Device] {
        try await pause()
        return all
    }

    func activity(deviceID: String) async throws -> [DeviceActivityItem] {
        try await pause()
        guard deviceID == "demo-d1" else { return [] }
        let now = Date()
        return [
            .turn(at: now.addingTimeInterval(-600), title: "Dinner ideas", heard: "What can I make with lentils?", conversationID: "demo-c1"),
            .timer(at: now.addingTimeInterval(-3600), label: "Pasta", dismissed: false),
            .turn(at: now.addingTimeInterval(-7200), title: "Weekend plans", heard: "Is it going to rain on Saturday?", conversationID: "demo-c2")
        ]
    }

    func rename(deviceID: String, name: String) async throws -> String {
        try await pause()
        guard let index = all.firstIndex(where: { $0.id == deviceID }) else { throw ApiError.notFound }
        all[index].name = name
        return name
    }

    // An online device confirms straight away, so "Applying" only stays on an offline one.
    func update(deviceID: String, change: DeviceSettingChange) async throws -> DeviceSettingsUpdate {
        try await pause()
        guard let index = all.firstIndex(where: { $0.id == deviceID }) else { throw ApiError.notFound }
        change.apply(to: &all[index].settings)
        let online = DeviceRules.isOnline(all[index])
        all[index].pending = !online
        return DeviceSettingsUpdate(settings: all[index].settings, delivered: online, pending: !online)
    }

    func remove(deviceID: String) async throws {
        try await pause()
        all.removeAll { $0.id == deviceID }
    }

    func announce(deviceID: String, title: String, body: String?, ring: Bool) async throws -> AnnounceStatus {
        try await pause()
        guard let device = all.first(where: { $0.id == deviceID }), DeviceRules.isOnline(device) else { throw ApiError.noDevice }
        return device.settings.dnd ? .held : .sent
    }

    func talkChoices() async throws -> DeviceTalkChoices {
        try await pause()
        let family = SpaceSummary(id: demoFamily, kind: .group, name: "Family", role: .owner)
        let books = SpaceSummary(id: demoBooks, kind: .group, name: "Book club", role: .member)
        let personal = SpaceSummary(id: demoSpace, kind: .private, name: "Personal", role: .owner)
        let now = Date()
        return DeviceTalkChoices(options: [
            DeviceTalkOption(ref: DeviceTalkRules.threadRef("demo-th1"), title: "Family holiday plans", place: "Family", updatedAt: now, spaceID: demoFamily, threadID: "demo-th1"),
            DeviceTalkOption(ref: "demo-1", title: "Demo chat", place: "General", updatedAt: now.addingTimeInterval(-3600)),
            DeviceTalkOption(ref: DeviceTalkRules.threadRef("demo-th3"), title: "Next month's pick", place: "Book club", updatedAt: now.addingTimeInterval(-86400), spaceID: demoBooks, threadID: "demo-th3")
        ], spaces: [personal, family, books])
    }

    func setTalkingIn(deviceID: String, target: DeviceTalkTarget) async throws {
        try await pause()
        guard let at = all.firstIndex(where: { $0.id == deviceID }) else { throw ApiError.notFound }
        switch target {
        case .newConversation(let spaceID):
            all[at].activeConversationID = nil
            all[at].activeSpaceID = spaceID
        case .conversation(let id, let spaceID):
            all[at].activeConversationID = id
            all[at].activeSpaceID = spaceID
        case .thread(let id, let spaceID):
            all[at].activeConversationID = DeviceTalkRules.threadRef(id)
            all[at].activeSpaceID = spaceID
        }
    }

    func setNewConversationSpace(deviceID: String, spaceID: String?) async throws {
        try await pause()
        guard let at = all.firstIndex(where: { $0.id == deviceID }) else { throw ApiError.notFound }
        all[at].activeSpaceID = spaceID
    }

    func startThread(spaceID: String) async throws -> SpaceThread {
        try await pause()
        return SpaceThread(id: UUID().uuidString, spaceID: spaceID, title: "Device conversation", createdBy: demoUser, createdAt: Date(), updatedAt: Date())
    }

    // Any full code pairs, except XXXX-XXXX, which behaves like an expired one.
    func pair(code: String, name: String?) async throws -> PairedDevice {
        try await pause()
        if code == "XXXXXXXX" { throw ApiError.notFound }
        let device = Device(id: UUID().uuidString, name: name ?? "New device", pairedAt: Date(), lastSeenAt: Date(), connected: true, live: DeviceLive(connected: true, batteryPercent: 100, firmware: "1.4.0"))
        all.append(device)
        return PairedDevice(deviceID: device.id, name: device.name)
    }
}
