import Foundation

public enum DeviceMode: String, Decodable, CaseIterable, Identifiable, Sendable {
    case pushToTalk = "ptt", wake, announceOnly = "announce_only"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .pushToTalk: "Push to talk"
        case .wake: "Wake word"
        case .announceOnly: "Announcements only"
        }
    }
}

public enum RingSound: String, Decodable, CaseIterable, Identifiable, Sendable {
    case classic, chime, pulse

    public var id: String { rawValue }
    public var title: String { rawValue.capitalized }
}

public enum WakeWord: String, Decodable, CaseIterable, Identifiable, Sendable {
    case bob

    public var id: String { rawValue }

    public var title: String { "Hey Bob" }
}

public struct DeviceSettings: Decodable, Equatable, Sendable {
    public var volume: Int
    public var muted: Bool
    public var mode: DeviceMode
    public var dnd: Bool
    public var ringSeconds: Int
    public var ringSound: RingSound
    public var wakeWord: WakeWord

    public init(volume: Int = 5, muted: Bool = false, mode: DeviceMode = .pushToTalk, dnd: Bool = false, ringSeconds: Int = 30, ringSound: RingSound = .classic, wakeWord: WakeWord = .bob) {
        self.volume = volume
        self.muted = muted
        self.mode = mode
        self.dnd = dnd
        self.ringSeconds = ringSeconds
        self.ringSound = ringSound
        self.wakeWord = wakeWord
    }

    enum CodingKeys: String, CodingKey {
        case volume, muted, mode, dnd
        case ringSeconds = "ring_seconds"
        case ringSound = "ring_sound"
        case wakeWord = "wake_word"
    }
}

// One setting to change: the server takes only the fields being changed.
public enum DeviceSettingChange: Equatable, Sendable {
    case volume(Int), muted(Bool), mode(DeviceMode), dnd(Bool), ringSeconds(Int), ringSound(RingSound), wakeWord(WakeWord)

    var body: [String: Any] {
        switch self {
        case .volume(let value): ["volume": value]
        case .muted(let value): ["muted": value]
        case .mode(let value): ["mode": value.rawValue]
        case .dnd(let value): ["dnd": value]
        case .ringSeconds(let value): ["ring_seconds": value]
        case .ringSound(let value): ["ring_sound": value.rawValue]
        case .wakeWord(let value): ["wake_word": value.rawValue]
        }
    }

    public var name: String {
        switch self {
        case .volume: "the volume"
        case .muted: "Mute"
        case .mode: "how it listens"
        case .dnd: "Do not disturb"
        case .ringSeconds: "the ring length"
        case .ringSound: "the ring sound"
        case .wakeWord: "the wake word"
        }
    }

    public func apply(to settings: inout DeviceSettings) {
        switch self {
        case .volume(let value): settings.volume = value
        case .muted(let value): settings.muted = value
        case .mode(let value): settings.mode = value
        case .dnd(let value): settings.dnd = value
        case .ringSeconds(let value): settings.ringSeconds = value
        case .ringSound(let value): settings.ringSound = value
        case .wakeWord(let value): settings.wakeWord = value
        }
    }
}

// What the connected device last reported; the extras are nil when it hasn't.
public struct DeviceLive: Decodable, Equatable, Sendable {
    public var connected: Bool
    public var batteryPercent: Int?
    public var charging: Bool?
    public var firmware: String?

    public init(connected: Bool = false, batteryPercent: Int? = nil, charging: Bool? = nil, firmware: String? = nil) {
        self.connected = connected
        self.batteryPercent = batteryPercent
        self.charging = charging
        self.firmware = firmware
    }

    enum CodingKeys: String, CodingKey {
        case connected, charging
        case batteryPercent = "battery_pct"
        case firmware = "fw_version"
    }
}

public struct Device: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public var name: String
    public let model: String
    public let pairedAt: Date
    public let lastSeenAt: Date?
    public var connected: Bool
    public var settings: DeviceSettings
    // A change the device hasn't confirmed yet.
    public var pending: Bool
    public let settingsSupported: Bool
    public let ringSettingsSupported: Bool
    public let wakeWordSupported: Bool
    public var live: DeviceLive
    // What it talks in: a conversation id, or "thr_" and a thread's id. Nil means its next turn starts a new one.
    public var activeConversationID: String?
    // Where a new conversation on it starts. Nil means the person's main space.
    public var activeSpaceID: String?

    public init(id: String, name: String, model: String = "Cardputer", pairedAt: Date, lastSeenAt: Date? = nil, connected: Bool = false, settings: DeviceSettings = DeviceSettings(), pending: Bool = false, settingsSupported: Bool = true, ringSettingsSupported: Bool = true, wakeWordSupported: Bool = true, live: DeviceLive = DeviceLive(), activeConversationID: String? = nil, activeSpaceID: String? = nil) {
        self.id = id
        self.name = name
        self.model = model
        self.pairedAt = pairedAt
        self.lastSeenAt = lastSeenAt
        self.connected = connected
        self.settings = settings
        self.pending = pending
        self.settingsSupported = settingsSupported
        self.ringSettingsSupported = ringSettingsSupported
        self.wakeWordSupported = wakeWordSupported
        self.live = live
        self.activeConversationID = activeConversationID
        self.activeSpaceID = activeSpaceID
    }

    enum CodingKeys: String, CodingKey {
        case id, name, model, connected, settings, pending, live
        case activeConversationID = "active_conversation_id"
        case activeSpaceID = "active_space_id"
        case pairedAt = "paired_at"
        case lastSeenAt = "last_seen_at"
        case settingsSupported = "settings_supported"
        case ringSettingsSupported = "ring_settings_supported"
        case wakeWordSupported = "wake_word_supported"
    }
}

public struct DeviceSettingsUpdate: Decodable, Equatable, Sendable {
    public let settings: DeviceSettings
    public let delivered: Bool
    public let pending: Bool

    public init(settings: DeviceSettings, delivered: Bool, pending: Bool) {
        self.settings = settings
        self.delivered = delivered
        self.pending = pending
    }
}

public enum DeviceActivityItem: Decodable, Equatable, Sendable {
    // A turn in a private conversation has its id; one in a space thread does not open here.
    case turn(at: Date, title: String, heard: String, conversationID: String?)
    case timer(at: Date, label: String?, dismissed: Bool)

    enum CodingKeys: String, CodingKey {
        case kind, at, title, label, status
        case heard = "heard_excerpt"
        case conversationID = "conversation_id"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let at = try values.decode(Date.self, forKey: .at)
        if try values.decode(String.self, forKey: .kind) == "timer" {
            self = .timer(at: at, label: try values.decodeIfPresent(String.self, forKey: .label), dismissed: try values.decode(String.self, forKey: .status) == "dismissed")
        } else {
            self = .turn(at: at, title: try values.decode(String.self, forKey: .title), heard: try values.decode(String.self, forKey: .heard), conversationID: try values.decodeIfPresent(String.self, forKey: .conversationID))
        }
    }
}

public enum AnnounceStatus: String, Decodable, Sendable {
    // Held while the device is busy or in do not disturb.
    case sent, held
}

public struct PairingLookup: Decodable, Equatable, Sendable {
    public let pairingID: String
    public let deviceModel: String

    public init(pairingID: String, deviceModel: String) {
        self.pairingID = pairingID
        self.deviceModel = deviceModel
    }

    enum CodingKeys: String, CodingKey {
        case pairingID = "pairing_id"
        case deviceModel = "device_model"
    }
}

public struct PairedDevice: Decodable, Equatable, Sendable {
    public let deviceID: String
    public let name: String

    public init(deviceID: String, name: String) {
        self.deviceID = deviceID
        self.name = name
    }

    enum CodingKeys: String, CodingKey {
        case name
        case deviceID = "device_id"
    }
}

public enum DeviceTalkTarget: Equatable, Sendable {
    case newConversation(spaceID: String?)
    case conversation(id: String, spaceID: String?)
    case thread(id: String, spaceID: String)
}

public enum DeviceHandoffReceipt: Equatable, Sendable { case sent, pending }

private struct DeviceHandoffResponse: Decodable {
    let receipt: DeviceHandoffReceipt
    enum CodingKeys: String, CodingKey { case status, activeConversation = "active_conversation", activeSpace = "active_space" }
    private struct Pointer: Decodable { let id: String }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.status) {
            guard try values.decode(String.self, forKey: .status) == "pending" else { throw DecodingError.dataCorruptedError(forKey: .status, in: values, debugDescription: "Unknown handoff status") }
            receipt = .pending
        } else {
            guard values.contains(.activeConversation), values.contains(.activeSpace) else { throw DecodingError.dataCorruptedError(forKey: .activeConversation, in: values, debugDescription: "Missing device pointers") }
            _ = try values.decodeIfPresent(Pointer.self, forKey: .activeConversation)
            _ = try values.decodeIfPresent(Pointer.self, forKey: .activeSpace)
            receipt = .sent
        }
    }
}

public struct DevicesClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func devices() async throws -> [Device] {
        let response: DevicesResponse = try await http.decoded("GET", ["devices"])
        return response.devices
    }

    // Points a device at a private chat, a space's thread, or nothing: its next turn then starts a new conversation.
    public func setTalkingIn(deviceID: String, target: DeviceTalkTarget) async throws {
        try await http.empty("PUT", ["devices", "active-conversation"], body: Self.handoffBody(deviceID: deviceID, target: target))
    }

    public func handoff(deviceID: String, target: DeviceTalkTarget) async throws -> DeviceHandoffReceipt {
        let response: DeviceHandoffResponse = try await http.decoded("PUT", ["devices", "active-conversation"], body: Self.handoffBody(deviceID: deviceID, target: target))
        return response.receipt
    }

    private static func handoffBody(deviceID: String, target: DeviceTalkTarget) -> [String: Any] {
        var body: [String: Any] = ["device_id": deviceID]
        switch target {
        case .newConversation(let spaceID):
            body["conversation_id"] = NSNull()
            body["space_id"] = spaceID ?? NSNull()
        case .conversation(let id, let spaceID):
            body["conversation_id"] = id
            body["space_id"] = spaceID ?? NSNull()
        case .thread(let id, let spaceID):
            body["conversation_id"] = NSNull()
            body["space_id"] = spaceID
            body["thread_id"] = id
        }
        return body
    }

    // Where new conversations on this device start. Nil is the person's main space.
    public func setNewConversationSpace(deviceID: String, spaceID: String?) async throws {
        try await http.empty("PUT", ["devices", "active-space"], body: ["device_id": deviceID, "space_id": spaceID ?? NSNull()])
    }

    public func activity(deviceID: String, limit: Int = 5) async throws -> [DeviceActivityItem] {
        let response: ActivityResponse = try await http.decoded("GET", ["devices", deviceID, "activity"], query: [URLQueryItem(name: "limit", value: String(limit))])
        return response.items
    }

    public func rename(deviceID: String, name: String) async throws -> String {
        let response: RenameResponse = try await http.decoded("PATCH", ["devices", deviceID], body: ["name": name])
        return response.name
    }

    public func update(deviceID: String, change: DeviceSettingChange) async throws -> DeviceSettingsUpdate {
        try await http.decoded("PATCH", ["devices", deviceID, "settings"], body: change.body)
    }

    public func remove(deviceID: String) async throws {
        try await http.empty("DELETE", ["devices", deviceID])
    }

    // A card on the device's screen. ApiError.noDevice when it isn't connected: nothing is queued.
    public func announce(deviceID: String, title: String, body: String?, ring: Bool) async throws -> AnnounceStatus {
        var payload: [String: Any] = ["kind": "notice", "title": title, "ring": ring]
        if let body { payload["body"] = body }
        let response: AnnounceResponse = try await http.decoded("POST", ["devices", deviceID, "announce"], body: payload)
        return response.status
    }

    public func lookUpPairing(code: String) async throws -> PairingLookup {
        try await http.decoded("POST", ["pair", "lookup"], body: ["user_code": code])
    }

    public func approvePairing(id: String, name: String?) async throws -> PairedDevice {
        var payload: [String: Any] = ["pairing_id": id]
        if let name { payload["name"] = name }
        return try await http.decoded("POST", ["pair", "approve"], body: payload)
    }
}

private struct DevicesResponse: Decodable {
    let devices: [Device]
}

private struct ActivityResponse: Decodable {
    let items: [DeviceActivityItem]
}

private struct RenameResponse: Decodable {
    let name: String
}

private struct AnnounceResponse: Decodable {
    let status: AnnounceStatus
}

public enum DeviceRules {
    public static let nameLimit = 40
    public static let announceTitleLimit = 28
    public static let announceBodyLimit = 200
    private static let ringChoices = [10, 20, 30, 45, 60, 90, 120]

    // The one "is it online" rule every row and screen uses.
    public static func isOnline(_ device: Device) -> Bool {
        device.connected || device.live.connected
    }

    // "Connected · 82%, charging", "Offline · seen Oct 16", "Offline · never connected".
    public static func status(_ device: Device, locale: Locale = .current, zone: TimeZone = .current) -> String {
        if isOnline(device) {
            guard let battery = device.live.batteryPercent else { return "Connected" }
            return "Connected · \(battery)%\(device.live.charging == true ? ", charging" : "")"
        }
        guard let seen = device.lastSeenAt else { return "Offline · never connected" }
        return "Offline · seen \(day(seen, locale: locale, zone: zone))"
    }

    public static func day(_ date: Date, locale: Locale = .current, zone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter.string(from: date)
    }

    public static func battery(_ live: DeviceLive) -> String {
        guard let percent = live.batteryPercent else { return "Unknown" }
        return "\(percent)%\(live.charging == true ? ", charging" : "")"
    }

    // The server lists a Bob board as "Bob (Waveshare 1.85C)": the name a person knows, then the hardware.
    public static func product(_ model: String) -> (name: String, hardware: String?) {
        let trimmed = model.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasSuffix(")"), let open = trimmed.firstIndex(of: "("), open != trimmed.startIndex else {
            return (trimmed, nil)
        }
        let name = trimmed[..<open].trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? (trimmed, nil) : (name, String(trimmed[trimmed.index(after: open)..<trimmed.index(before: trimmed.endIndex)]))
    }

    public static func ringLabel(_ seconds: Int) -> String {
        switch seconds {
        case 60: "1 minute"
        case 120: "2 minutes"
        default: "\(seconds) seconds"
        }
    }

    // The offered lengths, plus the stored one when it isn't among them.
    public static func ringOptions(current: Int) -> [Int] {
        ringChoices.contains(current) ? ringChoices : (ringChoices + [current]).sorted()
    }

    public static func soundSummary(_ settings: DeviceSettings) -> String {
        "\(settings.muted ? "Muted" : "Volume \(settings.volume)") · \(settings.ringSound.title) ring, \(ringLabel(settings.ringSeconds))"
    }

    public static func listeningSummary(_ device: Device) -> String {
        guard device.settings.mode == .wake, device.wakeWordSupported else { return device.settings.mode.title }
        return "\(device.settings.mode.title) · \"\(device.settings.wakeWord.title)\""
    }

    // Why the speaker can't be tested right now, or nil when it can.
    public static func testBlockedReason(_ device: Device) -> String? {
        if !isOnline(device) { return "\(device.name) is offline" }
        if device.settings.muted { return "Unmute to test" }
        if device.settings.dnd { return "Turn off Do not disturb to test" }
        return nil
    }

    public static func announceOutcome(_ status: AnnounceStatus, name: String) -> String {
        status == .sent ? "Sent to \(name)." : "\(name) will show it when free."
    }
}

// The code on a device's screen, as a person types it.
public enum PairCode {
    public static func normalized(_ raw: String) -> String {
        String(raw.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) })
    }

    // Shape only: the server decides whether it exists.
    public static func isComplete(_ raw: String) -> Bool {
        normalized(raw).count == 8
    }

    // Uppercase, with one hyphen after the fourth character.
    public static func formatted(_ raw: String) -> String {
        let code = String(normalized(raw).prefix(8))
        return code.count > 4 ? "\(code.prefix(4))-\(code.dropFirst(4))" : code
    }

    public static func retryLabel(seconds: Int) -> String {
        func unit(_ count: Int, _ name: String) -> String { count == 1 ? "1 \(name)" : "\(count) \(name)s" }
        if seconds >= 3600 { return unit(Int((Double(seconds) / 3600).rounded(.up)), "hour") }
        if seconds >= 60 { return unit(Int((Double(seconds) / 60).rounded(.up)), "minute") }
        return unit(seconds, "second")
    }
}
