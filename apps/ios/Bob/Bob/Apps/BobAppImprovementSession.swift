import BobKit
import Foundation
import Observation

/// Drafts live with this app detail. Only the user/installation conversation pointer persists.
@MainActor @Observable final class BobAppImprovementSession {
    private(set) var model: ChatViewModel?
    private(set) var error: ApiError?
    private(set) var opening = false
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var ownerID: String?
    @ObservationIgnored private let defaults = UserDefaults.standard

    func open(_ app: SavedBobApp) async {
        generation += 1
        let request = generation
        opening = true; error = nil
        defer { if request == generation { opening = false } }
        do {
            guard let client = AppSession.make({ BobAppsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) else { throw ApiError.unauthenticated }
            let services = ChatServiceFactory.make()
            let shared = ProductivityServices.make(conversations: services.conversations).shared
            guard let userID = try await shared.spaces.selfUserID() else { throw ApiError.unauthenticated }
            try check(request)
            if ownerID != userID { model = nil; ownerID = userID }
            let context = try await BobAppImprovementContext.open(client: client, appID: app.id, installationID: app.installationId, spaceID: app.spaceId)
            try check(request)
            let candidate: ChatViewModel
            if let anchor = context.conversation {
                let thread = try await shared.threads.thread(id: anchor.conversationId)
                try context.validateThread(id: thread.id, spaceID: thread.spaceID, archived: thread.archivedAt != nil)
                try check(request)
                let room = ChatRoom(threadID: thread.id, spaceID: thread.spaceID, title: thread.title, requireMention: false, threads: shared.threads, spaces: shared.spaces)
                candidate = ChatViewModel(room: room, appBinding: context.binding)
                await candidate.openRoom()
                guard candidate.openPhase == .ready else { throw ApiError.forbidden }
            } else {
                let key = "bob.app.conversation.\(userID).\(app.installationId)"
                var transcript = ChatTranscript()
                if let id = defaults.string(forKey: key) {
                    guard id.range(of: #"^[A-Za-z0-9_-]{8,64}$"#, options: .regularExpression) != nil else { throw ApiError.invalidRequest }
                    do {
                        let detail = try await services.conversations.conversation(id: id)
                        guard detail.id == id else { throw ApiError.forbidden }
                        transcript = ChatTranscript(detail: detail)
                    } catch ApiError.notFound {
                        try check(request)
                        defaults.removeObject(forKey: key)
                    }
                }
                try check(request)
                candidate = ChatViewModel(service: services.chat, conversations: services.conversations, transcript: transcript, appBinding: context.binding) { [defaults] id in
                    defaults.set(id, forKey: key)
                }
            }
            try check(request)
            if let existing = model, existing.marketingBinding == context.binding,
               existing.transcript.conversationID == candidate.transcript.conversationID {
                await existing.syncFromServer()
                try check(request)
            } else {
                if let existing = model, existing.marketingBinding == context.binding { candidate.preserveUnsent(from: existing) }
                model = candidate
            }
        } catch {
            guard request == generation, !Task.isCancelled else { return }
            self.error = (error as? ApiError) ?? .unknown(status: 0)
        }
    }
    func cancel() { generation += 1; opening = false }
    private func check(_ request: Int) throws {
        guard request == generation, !Task.isCancelled else { throw ApiError.cancelled }
    }
}
