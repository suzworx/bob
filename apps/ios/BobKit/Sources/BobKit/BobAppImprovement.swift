import Foundation

/// A freshly read app and its exact conversation audience; no ordinary-chat fallback.
public struct BobAppImprovementContext: Sendable {
    public let app: SavedBobApp
    public let binding: ChatAppBinding
    public let conversation: BobAppConversation?

    public static func open(client: BobAppsClient, appID: String, installationID: String, spaceID: String?) async throws -> Self {
        guard UUID(uuidString: appID) != nil, UUID(uuidString: installationID) != nil,
              spaceID == nil || spaceID.flatMap(UUID.init(uuidString:)) != nil else { throw ApiError.invalidRequest }
        try Task.checkCancellation()
        let app = try await client.get(appID)
        try Task.checkCancellation()
        guard app.id == appID, app.installationId == installationID, app.spaceId == spaceID,
              app.lifecycle == .active || app.lifecycle == .draft else { throw ApiError.forbidden }
        // Shared members have write permission even when they cannot manage the installation.
        let binding = ChatAppBinding(installationID: installationID, mode: .refine)
        var conversation: BobAppConversation?
        if let spaceID {
            let anchor = try await client.openConversation(appID)
            try Task.checkCancellation()
            guard anchor.spaceId == spaceID, UUID(uuidString: anchor.conversationId) != nil else { throw ApiError.forbidden }
            conversation = anchor
        }
        return Self(app: app, binding: binding, conversation: conversation)
    }

    public func validateThread(id: String, spaceID: String, archived: Bool) throws {
        guard let conversation, conversation.conversationId == id,
              conversation.spaceId == spaceID, app.spaceId == spaceID, !archived else { throw ApiError.forbidden }
    }
}
