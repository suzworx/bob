import Foundation

/// The app context explicitly selected for one turn. A new run sends null, never an inferred campaign.
public struct ChatAppBinding: Encodable, Equatable, Sendable {
    public enum Mode: String, Encodable, Sendable { case run, refine }
    public enum Channel: String, Encodable, Sendable { case instagram, linkedin }
    public let installationID: String
    public let mode: Mode
    public let campaignID: String?
    public let channel: Channel?

    public init(installationID: String, mode: Mode, campaignID: String? = nil, channel: Channel? = nil) {
        self.installationID = installationID
        self.mode = mode
        self.campaignID = campaignID
        self.channel = channel
    }

    public var isValid: Bool {
        UUID(uuidString: installationID) != nil && (mode == .refine || campaignID == nil || campaignID.flatMap(UUID.init(uuidString:)) != nil)
    }

    enum CodingKeys: String, CodingKey {
        case installationID = "installationId", campaignID = "campaignId", mode, channel
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(installationID, forKey: .installationID)
        try container.encode(mode, forKey: .mode)
        try container.encodeIfPresent(channel, forKey: .channel)
        if mode == .run { try container.encode(campaignID, forKey: .campaignID) }
    }

    var object: [String: Any] {
        var body: [String: Any] = ["installationId": installationID, "mode": mode.rawValue]
        if mode == .run { body["campaignId"] = campaignID.map { $0 as Any } ?? NSNull() }
        if let channel { body["channel"] = channel.rawValue }
        return body
    }
}
