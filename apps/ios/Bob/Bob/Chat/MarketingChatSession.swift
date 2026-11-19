import BobKit
import Foundation

/// Own this in the signed-in shell. Only opaque conversation pointers persist; drafts and replies stay in memory.
@MainActor final class MarketingChatSession {
    private let defaults: UserDefaults
    private var generation = 0
    private var ownerID: String?
    private var models: [String: ChatViewModel] = [:]
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func open(_ target: MarketingChatTarget, prefill: String, services: ChatServices, shared: SharedServices) async throws -> ChatViewModel {
        generation += 1
        let request = generation
        guard let mode = ChatAppBinding.Mode(rawValue: target.mode),
              target.channel == nil || target.channel.flatMap(ChatAppBinding.Channel.init(rawValue:)) != nil,
              let marketing = AppSession.make({ MarketingClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }),
              let apps = AppSession.make({ BobAppsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) else { throw ApiError.invalidRequest }
        let binding = ChatAppBinding(installationID: target.installationID, mode: mode, campaignID: target.campaignID, channel: target.channel.flatMap(ChatAppBinding.Channel.init(rawValue:)))
        guard binding.isValid else { throw ApiError.invalidRequest }
        let installation = try await marketing.installation(id: target.installationID)
        guard installation.id == target.installationID, installation.appId == target.appID, installation.spaceId == target.spaceID,
              (mode == .run ? installation.writable : installation.configurable) else { throw ApiError.forbidden }
        guard let userID = try await shared.spaces.selfUserID() else { throw ApiError.unauthenticated }
        guard request == generation, !Task.isCancelled else { throw ApiError.cancelled }
        if ownerID != userID { models = [:]; ownerID = userID }
        let contextKey = [userID, target.installationID, target.mode, target.campaignID ?? "new", target.channel ?? "all"].joined(separator: ":")
        let model: ChatViewModel
        if let spaceID = target.spaceID {
            let anchor = try await apps.openConversation(target.appID)
            guard anchor.spaceId == spaceID else { throw ApiError.forbidden }
            let thread = try await shared.threads.thread(id: anchor.conversationId)
            guard thread.id == anchor.conversationId, thread.spaceID == spaceID, thread.archivedAt == nil else { throw ApiError.forbidden }
            let room = ChatRoom(threadID: thread.id, spaceID: spaceID, title: thread.title, requireMention: false, threads: shared.threads, spaces: shared.spaces)
            model = ChatViewModel(room: room, appBinding: binding)
            await model.openRoom()
            guard model.openPhase == .ready else { throw ApiError.forbidden }
        } else {
            let key = "bob.marketing.conversation.\(userID).\(target.installationID)"
            var transcript = ChatTranscript()
            if let id = defaults.string(forKey: key) {
                guard id.range(of: #"^[A-Za-z0-9_-]{8,64}$"#, options: .regularExpression) != nil else { throw ApiError.invalidRequest }
                do {
                    let detail = try await services.conversations.conversation(id: id)
                    guard detail.id == id else { throw ApiError.forbidden }
                    transcript = ChatTranscript(detail: detail)
                } catch ApiError.notFound { defaults.removeObject(forKey: key) }
            }
            model = ChatViewModel(service: services.chat, conversations: services.conversations, transcript: transcript, appBinding: binding) { [defaults] id in
                defaults.set(id, forKey: key)
            }
        }
        guard request == generation, !Task.isCancelled else { throw ApiError.cancelled }
        if let existing = models[contextKey], existing.marketingBinding == binding,
           existing.transcript.conversationID == model.transcript.conversationID {
            await existing.syncFromServer()
            guard request == generation, !Task.isCancelled else { throw ApiError.cancelled }
            if existing.draft.isEmpty { existing.draft = prefill }
            return existing
        }
        model.draft = prefill
        if let existing = models[contextKey], existing.marketingBinding == binding {
            model.preserveUnsent(from: existing)
        }
        models[contextKey] = model
        return model
    }

    func cancel() { generation += 1 }
}
