import XCTest
@testable import BobKit

private let base = URL(string: "https://api.example.test")!
private let deviceID = "33333333-3333-4333-8333-333333333333"
private let pairingID = "55555555-5555-4555-8555-555555555555"
private let enUS = Locale(identifier: "en_US")

private func stubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ProductivityStub.self]
    return URLSession(configuration: configuration)
}

// Copied from UsageResponseSchema in apps/api/src/account/usage-http.ts.
private let usageJSON = #"{"range":"7d","from":"2026-10-01","to":"2026-10-07","generated_at":"2026-10-07T10:00:00.000Z","active_days":3,"turns":{"total":12,"by_surface":{"device":5,"web_voice":3,"web_text":4},"by_day":[{"day":"2026-10-01","device":1,"web_voice":0,"web_text":2}],"by_weekday_hour":[{"dow":1,"hour":8,"count":2},{"dow":2,"hour":20,"count":3},{"dow":3,"hour":8,"count":2}]},"conversations_created":2,"created":{"tasks":1,"notes":0,"reminders":1},"todos_done":4,"memories":{"new_in_range":1,"total":9},"game_minutes":null}"#

// Copied from NotificationSummarySchema in apps/api/src/notifications/http.ts.
private func inboxJSON(type: String = "assignment", read: String = "null", about: String = #"{"actor_name":"Sam","title":"Book car","space_name":"Home","at":null,"date":"2026-10-22","action":null}"#) -> String {
    #"{"id":"66666666-6666-4666-8666-666666666666","space_id":"11111111-1111-4111-8111-111111111111","type":"\#(type)","resource_type":"task","resource_id":"22222222-2222-4222-8222-222222222222","revision":1,"cursor":41,"read_at":\#(read),"created_at":1700000000000,"about":\#(about)}"#
}

// Copied from DeviceSummarySchema in apps/api/src/devices/schemas.ts.
private let settingsJSON = #"{"volume":7,"muted":false,"mode":"wake","dnd":true,"ring_seconds":45,"ring_sound":"chime","wake_word":"bob"}"#
private let deviceJSON = #"{"id":"\#(deviceID)","name":"Kitchen","model":"Bob (Waveshare 1.85C)","paired_at":1700000000000,"last_seen_at":1700000500000,"connected":true,"settings":\#(settingsJSON),"pending":true,"settings_supported":true,"ring_settings_supported":false,"wake_word_supported":true,"live":{"connected":true,"battery_pct":82,"charging":true,"fw_version":"1.2.3"},"active_conversation_id":null,"active_space_id":null}"#

final class AccountClientTests: XCTestCase {
    private let client = AccountClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testDefaultSessionNeverWritesToDisk() {
        XCTAssertNil(MemoryClient.memoryOnlySession.configuration.urlCache)
    }

    func testUsageDecodesTheRealShape() async throws {
        ProductivityStub.route("GET /api/me/usage", 200, usageJSON)
        let usage = try await client.usage(.month)
        XCTAssertEqual(ProductivityStub.last?.query, "range=30d")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(usage.activeDays, 3)
        XCTAssertEqual(usage.turns.bySurface, UsageSurfaceCounts(device: 5, voice: 3, typed: 4))
        XCTAssertEqual(usage.turns.byDay.first?.day, "2026-10-01")
        XCTAssertEqual(usage.turns.byDay.first?.counts.typed, 2)
        XCTAssertEqual(usage.memories?.newInRange, 1)
        XCTAssertNil(usage.gameMinutes)
    }

    func testExportKeepsBytesAndFallsBackToAName() async throws {
        ProductivityStub.route("GET /api/account/export", 200, #"{"format":"bob.account-export"}"#)
        let file = try await client.export()
        XCTAssertEqual(ProductivityStub.last?.path, "/api/account/export")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual(String(data: file.data, encoding: .utf8), #"{"format":"bob.account-export"}"#)
        XCTAssertEqual(file.fileName, "bob-export.json")
        XCTAssertEqual(file.baseName, "bob-export")
    }

    func testExportNameComesFromTheHeaderAndCannotEscape() {
        XCTAssertEqual(AccountClient.fileName(disposition: #"attachment; filename="bob-export-2026-10-31.json""#), "bob-export-2026-10-31.json")
        XCTAssertEqual(AccountClient.fileName(disposition: #"attachment; filename="../../evil.json""#), "bob-export.json")
        XCTAssertEqual(AccountClient.fileName(disposition: nil), "bob-export.json")
    }

    func testExportLimitIsItsOwnError() async {
        ProductivityStub.route("GET /api/account/export", 429, #"{"error":{"code":"rate_limited"}}"#)
        do {
            _ = try await client.export()
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .rateLimited(retryAfterSeconds: nil))
        }
    }

    func testDeleteSendsTheConfirmation() async throws {
        ProductivityStub.route("DELETE /api/account", 204, "")
        try await client.deleteAccount()
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
        XCTAssertEqual(ProductivityStub.last?.path, "/api/account")
        XCTAssertEqual(ProductivityStub.last?.body?["confirm"] as? Bool, true)
    }

    func testDeleteRefusalCarriesTheCount() async {
        ProductivityStub.route("DELETE /api/account", 409, #"{"error":{"code":"owns_groups","count":2}}"#)
        do {
            try await client.deleteAccount()
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .ownsGroups(count: 2))
            XCTAssertEqual(ApiErrorMapper.userMessage(.ownsGroups(count: 2)), "You own 2 shared spaces. Give each one to another member first, then try again.")
        }
    }
}

final class SupabaseAccountTests: XCTestCase {
    private let client = SupabaseAuthClient(apiBaseURL: base, session: stubSession())

    override func setUp() {
        ProductivityStub.reset()
        ProductivityStub.route("GET /api/public-config", 200, #"{"supabaseUrl":"https://auth.example.test","supabasePublishableKey":"pub"}"#)
    }

    func testMetadataGoesToTheUserRoute() async throws {
        ProductivityStub.route("PUT /auth/v1/user", 200, "{}")
        try await client.updateMetadata(accessToken: "tok", ["time_zone": "Asia/Kolkata"])
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        XCTAssertEqual((ProductivityStub.last?.body?["data"] as? [String: String])?["time_zone"], "Asia/Kolkata")
    }

    func testAFailedSaveThrows() async {
        ProductivityStub.route("PUT /auth/v1/user", 500, "{}")
        do {
            try await client.updateMetadata(accessToken: "tok", ["name": "Sam"])
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? ApiError, .upstream)
        }
    }

    func testSignOutEverywhereIsGlobalAndAGoneSessionCountsAsDone() async throws {
        ProductivityStub.route("POST /auth/v1/logout", 204, "")
        try await client.signOutEverywhere(accessToken: "tok")
        XCTAssertEqual(ProductivityStub.last?.query, "scope=global")
        XCTAssertEqual(ProductivityStub.last?.auth, "Bearer tok")
        ProductivityStub.route("POST /auth/v1/logout", 403, "{}")
        try await client.signOutEverywhere(accessToken: "tok")
        ProductivityStub.route("POST /auth/v1/logout", 500, "{}")
        do {
            try await client.signOutEverywhere(accessToken: "tok")
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? ApiError, .upstream)
        }
    }
}

final class AccountRulesTests: XCTestCase {
    private func token(_ claims: String) -> String {
        let payload = Data(claims.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "e30.\(payload).sig"
    }

    func testProfileComesFromTheToken() throws {
        let profile = try XCTUnwrap(AccountProfile(accessToken: token(#"{"email":"sam@example.test","user_metadata":{"name":"  ","full_name":"Sam Example","time_zone":"Asia/Kolkata"}}"#)))
        XCTAssertEqual(profile, AccountProfile(email: "sam@example.test", name: "Sam Example", timeZone: "Asia/Kolkata"))
    }

    func testNoNameIsMadeUpFromTheEmail() throws {
        let profile = try XCTUnwrap(AccountProfile(accessToken: token(#"{"email":"sam@example.test"}"#)))
        XCTAssertNil(profile.name)
        XCTAssertNil(AccountProfile(accessToken: "not a token"))
    }

    func testNameLimits() {
        XCTAssertEqual(AccountProfile.validName("  Sam "), "Sam")
        XCTAssertNil(AccountProfile.validName("   "))
        XCTAssertNil(AccountProfile.validName(String(repeating: "x", count: 61)))
    }

    func testZones() {
        let known = ["Asia/Ho_Chi_Minh", "Europe/Paris"]
        XCTAssertEqual(AccountProfile.zones(matching: "", known: known).first, "UTC")
        XCTAssertEqual(AccountProfile.zones(matching: " ho chi ", known: known), ["Asia/Ho_Chi_Minh"])
        XCTAssertEqual(AccountProfile.zoneLabel("Asia/Ho_Chi_Minh"), "Asia/Ho Chi Minh")
    }

    func testDeleteConfirmationNeedsTheEmail() {
        XCTAssertTrue(AccountDeletion.isConfirmed(typed: " SAM@example.test ", email: "sam@example.test"))
        XCTAssertFalse(AccountDeletion.isConfirmed(typed: "sam", email: "sam@example.test"))
        XCTAssertFalse(AccountDeletion.isConfirmed(typed: "", email: "sam@example.test"))
        XCTAssertTrue(AccountDeletion.isConfirmed(typed: "delete my account", email: nil))
    }

    func testBusiestHourAddsUpTheWeek() {
        XCTAssertEqual(UsageRules.busiestHour([UsageWeekdayHour(hour: 8, count: 2), UsageWeekdayHour(hour: 20, count: 3), UsageWeekdayHour(hour: 8, count: 2)]), 8)
        XCTAssertEqual(UsageRules.busiestHour([UsageWeekdayHour(hour: 9, count: 1), UsageWeekdayHour(hour: 7, count: 1)]), 9)
        XCTAssertNil(UsageRules.busiestHour([]))
        XCTAssertTrue(UsageRules.hourLabel(20, locale: enUS).hasPrefix("8"))
    }

    func testNoActivity() {
        let none = UsageSurfaceCounts(device: 0, voice: 0, typed: 0)
        func report(turns: Int = 0, notes: Int = 0) -> UsageReport {
            UsageReport(activeDays: 0, turns: .init(total: turns, bySurface: none, byDay: [], byWeekdayHour: []), conversationsCreated: 0, created: .init(tasks: 0, notes: notes, reminders: 0), todosDone: 0, memories: nil, gameMinutes: nil)
        }
        XCTAssertTrue(UsageRules.hasNoActivity(report()))
        XCTAssertFalse(UsageRules.hasNoActivity(report(turns: 1)))
        XCTAssertFalse(UsageRules.hasNoActivity(report(notes: 1)))
    }

    func testNewAccountErrorsMapByCode() {
        XCTAssertEqual(ApiErrorMapper.map(status: 409, body: Data(#"{"error":{"code":"no_device"}}"#.utf8), retryAfter: nil), .noDevice)
        XCTAssertEqual(ApiErrorMapper.map(status: 409, body: Data(#"{"error":{"code":"ring_unsupported"}}"#.utf8), retryAfter: nil), .settingUnsupported)
        XCTAssertEqual(ApiErrorMapper.map(status: 409, body: Data(#"{"error":{"code":"wake_word_unsupported"}}"#.utf8), retryAfter: nil), .settingUnsupported)
        XCTAssertEqual(ApiErrorMapper.map(status: 409, body: nil, retryAfter: nil), .unknown(status: 409))
    }
}

final class NotificationsClientTests: XCTestCase {
    private let client = NotificationsClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testListDecodesAndSendsItsQuery() async throws {
        ProductivityStub.route("GET /api/notifications", 200, #"{"notifications":[\#(inboxJSON())],"next_cursor":41,"unread_count":3}"#)
        let page = try await client.list(limit: 25, after: 90, unreadOnly: true)
        XCTAssertEqual(ProductivityStub.last?.query, "limit=25&after=90&unread=true")
        XCTAssertEqual(page.nextCursor, 41)
        XCTAssertEqual(page.unreadCount, 3)
        let item = try XCTUnwrap(page.notifications.first)
        XCTAssertEqual(item.kind, .assignment)
        XCTAssertEqual(item.cursor, 41)
        XCTAssertTrue(item.isUnread)
        XCTAssertEqual(item.createdAt, Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(item.about?.actorName, "Sam")
        XCTAssertEqual(item.about?.date, "2026-10-22")
    }

    func testAKindFromANewerServerStillLists() async throws {
        ProductivityStub.route("GET /api/notifications", 200, #"{"notifications":[\#(inboxJSON(type: "brand_new", read: "1700000001000", about: "null"))],"next_cursor":null,"unread_count":0}"#)
        let item = try await client.list().notifications.first
        XCTAssertEqual(item?.kind, .other)
        XCTAssertEqual(item?.isUnread, false)
        XCTAssertNil(item?.about)
    }

    func testMarkReadBodies() async throws {
        ProductivityStub.route("PUT /api/notifications/read", 200, #"{"moved":1}"#)
        try await client.markRead(ids: ["a"])
        XCTAssertEqual(ProductivityStub.last?.body?["ids"] as? [String], ["a"])
        XCTAssertNil(ProductivityStub.last?.body?["up_to_cursor"])
        try await client.markRead(upToCursor: 41)
        XCTAssertEqual(ProductivityStub.last?.body?["up_to_cursor"] as? Int, 41)
        XCTAssertNil(ProductivityStub.last?.body?["ids"])
    }

    func testPreferences() async throws {
        let row = #"{"id":"a","user_id":"b","space_id":null,"thread_id":null,"type":"mention","muted":true,"quiet_hours_start":null,"quiet_hours_end":null,"quiet_zone":null}"#
        ProductivityStub.route("GET /api/notification-preferences", 200, #"{"preferences":[\#(row)]}"#)
        let preferences = try await client.preferences()
        XCTAssertTrue(NotificationRules.isMuted(preferences, kind: .mention))
        XCTAssertFalse(NotificationRules.isMuted(preferences, kind: .reminder))

        ProductivityStub.route("PUT /api/notification-preferences", 200, row)
        let saved = try await client.setMuted(.taskUpdate, muted: true)
        XCTAssertEqual(saved.muted, true)
        XCTAssertEqual(ProductivityStub.last?.body?["type"] as? String, "task_update")
        XCTAssertEqual(ProductivityStub.last?.body?["muted"] as? Bool, true)
    }
}

final class NotificationRulesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func row(_ kind: NotificationKind, spaceID: String? = "s", resourceType: String = "x", about: NotificationAbout?) -> NotificationRow {
        NotificationRules.row(InboxNotification(id: "n", spaceID: spaceID, kind: kind, resourceType: resourceType, resourceID: "r", cursor: 1, createdAt: now, about: about), zone: "UTC", now: now, locale: enUS)
    }

    func testAGoneItemKeepsAGenericLineAndOpensNothing() {
        XCTAssertEqual(row(.mention, about: nil), NotificationRow(label: "You were mentioned", description: "Mention", target: nil))
        XCTAssertEqual(row(.invitation, resourceType: "space_member", about: nil).label, "A new member joined")
    }

    func testTargetsInThisApp() {
        XCTAssertEqual(row(.assignment, about: NotificationAbout(title: "Book")).target, .task("r"))
        XCTAssertNil(row(.assignment, spaceID: nil, about: NotificationAbout(title: "Book")).target)
        XCTAssertEqual(row(.reminder, spaceID: nil, about: NotificationAbout()).target, .reminders)
        XCTAssertEqual(row(.bobMessage, about: NotificationAbout(title: "Hi")).target, .note("r"))
        XCTAssertEqual(row(.eventChange, about: NotificationAbout()).target, .calendar)
        XCTAssertEqual(row(.security, about: NotificationAbout(title: "Kitchen", action: "device_paired")).target, .device("r"))
        XCTAssertEqual(row(.security, about: NotificationAbout(action: "device_removed")).target, .devices)
        XCTAssertEqual(row(.mention, about: NotificationAbout()).target, .thread(id: "r", spaceID: "s"))
        XCTAssertNil(row(.mention, spaceID: nil, about: NotificationAbout()).target)
        XCTAssertEqual(row(.invitation, about: NotificationAbout()).target, .members(spaceID: "s"))
    }

    func testWording() {
        XCTAssertEqual(row(.mention, about: NotificationAbout(actorName: "Sam", title: "Plans", spaceName: "Home")).label, "Sam mentioned you in Plans")
        XCTAssertEqual(row(.eventChange, about: NotificationAbout(title: "Lunch", action: "cancelled")).label, "Lunch was cancelled")
        XCTAssertEqual(row(.eventChange, about: NotificationAbout(actorName: "Sam", title: "Lunch", action: "tentative")).label, "Sam said maybe to Lunch")
        XCTAssertEqual(row(.invitation, resourceType: "space_member", about: NotificationAbout(actorName: "Sam", spaceName: "Home")).label, "Sam joined Home")
        XCTAssertEqual(row(.security, about: NotificationAbout(title: "Kitchen", action: "device_paired")).label, "Kitchen was paired")
        XCTAssertEqual(row(.assignment, about: NotificationAbout(title: "Book", spaceName: "Home", date: "2026-10-22")).description, "Assigned to you · Home · due Oct 22")
    }

    func testWhen() throws {
        func when(_ at: Date) -> String? {
            NotificationRules.whenLabel(at: at, date: nil, zone: "UTC", now: now, locale: enUS)
        }
        XCTAssertTrue(try XCTUnwrap(when(now)).hasPrefix("today "))
        XCTAssertTrue(try XCTUnwrap(when(now.addingTimeInterval(86400))).hasPrefix("tomorrow "))
        XCTAssertTrue(try XCTUnwrap(when(now.addingTimeInterval(86400 * 10))).hasPrefix("Jan 25, "))
        XCTAssertEqual(NotificationRules.whenLabel(at: nil, date: "2026-10-22", zone: "UTC", now: now, locale: enUS), "Oct 22")
        XCTAssertNil(NotificationRules.whenLabel(at: nil, date: nil, zone: "UTC", now: now))
        XCTAssertNotNil(NotificationRules.whenLabel(at: now, date: nil, zone: "Not/AZone", now: now, locale: enUS))
    }

    func testUnreadLabel() {
        XCTAssertEqual(NotificationRules.unreadLabel(3), "3")
        XCTAssertEqual(NotificationRules.unreadLabel(120), "99+")
    }

    func testSettingsLeaveSecurityOut() {
        XCTAssertFalse(NotificationRules.settings.contains { $0.kind == .security })
        XCTAssertEqual(NotificationRules.settings.count, 7)
    }
}

final class DevicesClientTests: XCTestCase {
    private let client = DevicesClient(baseURL: base, session: stubSession(), accessToken: { "tok" })

    override func setUp() { ProductivityStub.reset() }

    func testListDecodesTheRealShape() async throws {
        ProductivityStub.route("GET /api/devices", 200, #"{"devices":[\#(deviceJSON)],"active_conversation":null,"active_space":null}"#)
        let devices = try await client.devices()
        let device = try XCTUnwrap(devices.first)
        XCTAssertEqual(ProductivityStub.last?.path, "/api/devices")
        XCTAssertEqual(device.name, "Kitchen")
        XCTAssertEqual(device.pairedAt, Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(device.settings, DeviceSettings(volume: 7, muted: false, mode: .wake, dnd: true, ringSeconds: 45, ringSound: .chime, wakeWord: .bob))
        XCTAssertTrue(device.pending)
        XCTAssertFalse(device.ringSettingsSupported)
        XCTAssertEqual(device.live, DeviceLive(connected: true, batteryPercent: 82, charging: true, firmware: "1.2.3"))
    }

    func testActivityDecodesEveryKind() async throws {
        let body = #"{"items":[{"kind":"turn","at":1700000000000,"title":"Plans","heard_excerpt":"what's on","conversation_id":"cnv_1"},{"kind":"turn","at":1700000000001,"title":"Team","heard_excerpt":"","thread_id":"\#(pairingID)","space_id":"\#(pairingID)"},{"kind":"timer","at":1700000000002,"label":null,"status":"dismissed","scope":"account"}]}"#
        ProductivityStub.route("GET /api/devices/\(deviceID)/activity", 200, body)
        let items = try await client.activity(deviceID: deviceID)
        XCTAssertEqual(ProductivityStub.last?.query, "limit=5")
        XCTAssertEqual(items[0], .turn(at: Date(timeIntervalSince1970: 1_700_000_000), title: "Plans", heard: "what's on", conversationID: "cnv_1"))
        XCTAssertEqual(items[1], .turn(at: Date(timeIntervalSince1970: 1_700_000_000.001), title: "Team", heard: "", conversationID: nil))
        XCTAssertEqual(items[2], .timer(at: Date(timeIntervalSince1970: 1_700_000_000.002), label: nil, dismissed: true))
    }

    func testRenameAndRemove() async throws {
        ProductivityStub.route("PATCH /api/devices/\(deviceID)", 200, #"{"id":"\#(deviceID)","name":"Den"}"#)
        let name = try await client.rename(deviceID: deviceID, name: "Den")
        XCTAssertEqual(name, "Den")
        XCTAssertEqual(ProductivityStub.last?.body?["name"] as? String, "Den")

        ProductivityStub.route("DELETE /api/devices/\(deviceID)", 204, "")
        try await client.remove(deviceID: deviceID)
        XCTAssertEqual(ProductivityStub.last?.method, "DELETE")
    }

    func testASettingsChangeSendsOnlyThatField() async throws {
        ProductivityStub.route("PATCH /api/devices/\(deviceID)/settings", 200, #"{"id":"\#(deviceID)","settings":\#(settingsJSON),"delivered":false,"pending":true}"#)
        let update = try await client.update(deviceID: deviceID, change: .ringSeconds(45))
        XCTAssertFalse(update.delivered)
        XCTAssertEqual(update.settings.ringSeconds, 45)
        XCTAssertEqual(ProductivityStub.last?.body?.count, 1)
        XCTAssertEqual(ProductivityStub.last?.body?["ring_seconds"] as? Int, 45)

        _ = try await client.update(deviceID: deviceID, change: .mode(.announceOnly))
        XCTAssertEqual(ProductivityStub.last?.body?["mode"] as? String, "announce_only")
        _ = try await client.update(deviceID: deviceID, change: .wakeWord(.bob))
        XCTAssertEqual(ProductivityStub.last?.body?["wake_word"] as? String, "bob")
    }

    func testRefusedRingChange() async {
        ProductivityStub.route("PATCH /api/devices/\(deviceID)/settings", 409, #"{"error":{"code":"ring_unsupported"}}"#)
        do {
            _ = try await client.update(deviceID: deviceID, change: .ringSound(.pulse))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .settingUnsupported)
        }
    }

    func testAnnounce() async throws {
        ProductivityStub.route("POST /api/devices/\(deviceID)/announce", 202, #"{"status":"held"}"#)
        let status = try await client.announce(deviceID: deviceID, title: "Dinner", body: nil, ring: false)
        XCTAssertEqual(status, .held)
        let body = try XCTUnwrap(ProductivityStub.last?.body)
        XCTAssertEqual(body["kind"] as? String, "notice")
        XCTAssertEqual(body["title"] as? String, "Dinner")
        XCTAssertEqual(body["ring"] as? Bool, false)
        XCTAssertNil(body["body"])

        ProductivityStub.route("POST /api/devices/\(deviceID)/announce", 409, #"{"error":{"code":"no_device"}}"#)
        do {
            _ = try await client.announce(deviceID: deviceID, title: "Dinner", body: "Now", ring: true)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? ApiError, .noDevice)
        }
    }

    func testPairing() async throws {
        ProductivityStub.route("POST /api/pair/lookup", 200, #"{"pairing_id":"\#(pairingID)","device_model":"Cardputer","requested_at":1700000000000,"expires_at":1700000600000}"#)
        let found = try await client.lookUpPairing(code: "K7QX4TZP")
        XCTAssertEqual(found, PairingLookup(pairingID: pairingID, deviceModel: "Cardputer"))
        XCTAssertEqual(ProductivityStub.last?.body?["user_code"] as? String, "K7QX4TZP")

        ProductivityStub.route("POST /api/pair/approve", 200, #"{"device_id":"\#(deviceID)","name":"Den"}"#)
        let paired = try await client.approvePairing(id: pairingID, name: "Den")
        XCTAssertEqual(paired, PairedDevice(deviceID: deviceID, name: "Den"))
        XCTAssertEqual(ProductivityStub.last?.body?["pairing_id"] as? String, pairingID)
        XCTAssertEqual(ProductivityStub.last?.body?["name"] as? String, "Den")
        _ = try await client.approvePairing(id: pairingID, name: nil)
        XCTAssertNil(ProductivityStub.last?.body?["name"])
    }

    func testPairingErrorsAreTheirOwn() async {
        ProductivityStub.route("POST /api/pair/lookup", 404, #"{"error":{"code":"not_found"}}"#)
        do {
            _ = try await client.lookUpPairing(code: "K7QX4TZP")
            XCTFail("expected not found")
        } catch {
            XCTAssertEqual(error as? ApiError, .notFound)
        }
    }
}

final class DeviceRulesTests: XCTestCase {
    private let paired = Date(timeIntervalSince1970: 1_700_000_000)
    private let utc = TimeZone(identifier: "UTC")!

    func testStatusLine() {
        let online = Device(id: "a", name: "Den", pairedAt: paired, connected: true, live: DeviceLive(connected: true, batteryPercent: 82, charging: true))
        XCTAssertEqual(DeviceRules.status(online), "Connected · 82%, charging")
        XCTAssertEqual(DeviceRules.status(Device(id: "a", name: "Den", pairedAt: paired, live: DeviceLive(connected: true))), "Connected")
        XCTAssertEqual(DeviceRules.status(Device(id: "a", name: "Den", pairedAt: paired)), "Offline · never connected")
        XCTAssertEqual(DeviceRules.status(Device(id: "a", name: "Den", pairedAt: paired, lastSeenAt: paired), locale: enUS, zone: utc), "Offline · seen Nov 14")
    }

    func testProductSplitsTheHardwareOff() {
        XCTAssertEqual(DeviceRules.product("Bob (Waveshare 1.85C)").name, "Bob")
        XCTAssertEqual(DeviceRules.product("Bob (Waveshare 1.85C)").hardware, "Waveshare 1.85C")
        XCTAssertEqual(DeviceRules.product("Cardputer").name, "Cardputer")
        XCTAssertNil(DeviceRules.product("Cardputer").hardware)
    }

    func testRingOptionsKeepTheStoredLength() {
        XCTAssertEqual(DeviceRules.ringOptions(current: 30), [10, 20, 30, 45, 60, 90, 120])
        XCTAssertEqual(DeviceRules.ringOptions(current: 25), [10, 20, 25, 30, 45, 60, 90, 120])
        XCTAssertEqual(DeviceRules.ringLabel(60), "1 minute")
        XCTAssertEqual(DeviceRules.ringLabel(45), "45 seconds")
    }

    func testSummaries() {
        XCTAssertEqual(DeviceRules.soundSummary(DeviceSettings(volume: 7, ringSeconds: 60, ringSound: .chime)), "Volume 7 · Chime ring, 1 minute")
        XCTAssertEqual(DeviceRules.soundSummary(DeviceSettings(muted: true)), "Muted · Classic ring, 30 seconds")
        XCTAssertEqual(DeviceRules.listeningSummary(Device(id: "a", name: "D", pairedAt: paired, settings: DeviceSettings(mode: .wake))), "Wake word · \"Hey Bob\"")
        XCTAssertEqual(DeviceRules.listeningSummary(Device(id: "a", name: "D", pairedAt: paired, settings: DeviceSettings(mode: .wake), wakeWordSupported: false)), "Wake word")
    }

    func testSpeakerTestNeedsAReachableDevice() {
        XCTAssertEqual(DeviceRules.testBlockedReason(Device(id: "a", name: "Den", pairedAt: paired)), "Den is offline")
        XCTAssertEqual(DeviceRules.testBlockedReason(Device(id: "a", name: "Den", pairedAt: paired, connected: true, settings: DeviceSettings(muted: true))), "Unmute to test")
        XCTAssertEqual(DeviceRules.testBlockedReason(Device(id: "a", name: "Den", pairedAt: paired, connected: true, settings: DeviceSettings(dnd: true))), "Turn off Do not disturb to test")
        XCTAssertNil(DeviceRules.testBlockedReason(Device(id: "a", name: "Den", pairedAt: paired, connected: true)))
    }

    func testChangeAppliesToSettings() {
        var settings = DeviceSettings()
        DeviceSettingChange.volume(9).apply(to: &settings)
        DeviceSettingChange.dnd(true).apply(to: &settings)
        XCTAssertEqual(settings.volume, 9)
        XCTAssertTrue(settings.dnd)
    }

    func testPairCode() {
        XCTAssertEqual(PairCode.formatted("k7qx4"), "K7QX-4")
        XCTAssertEqual(PairCode.formatted("k7qx-4tzp-extra"), "K7QX-4TZP")
        XCTAssertEqual(PairCode.formatted("k7q"), "K7Q")
        XCTAssertEqual(PairCode.normalized("k7 qx-4tzp"), "K7QX4TZP")
        XCTAssertTrue(PairCode.isComplete("K7QX-4TZP"))
        XCTAssertFalse(PairCode.isComplete("K7QX-4TZ"))
        XCTAssertEqual(PairCode.formatted("é1"), "1")
    }

    func testRetryLabel() {
        XCTAssertEqual(PairCode.retryLabel(seconds: 900), "15 minutes")
        XCTAssertEqual(PairCode.retryLabel(seconds: 61), "2 minutes")
        XCTAssertEqual(PairCode.retryLabel(seconds: 3600), "1 hour")
        XCTAssertEqual(PairCode.retryLabel(seconds: 1), "1 second")
    }
}
