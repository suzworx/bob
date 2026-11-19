import BobKit
import Foundation
import Observation

// How other screens reach the chat sheet.
struct ChatRouting {
    var open: (String) -> Void = { _ in }
    // Starts a new chat, with words waiting in the composer if there are any.
    var new: (String?) -> Void = { _ in }
    var marketing: (MarketingChatTarget, String) -> Void = { _, _ in }
}

// What makes a chat a shared one. The view and the composer are the same; only the number of people in the room varies.
struct ChatRoom {
    let threadID: String
    let spaceID: String
    let title: String?
    // A group chat only ever hears Bob when he's asked. A space's thread also reaches him if the person is alone there.
    let requireMention: Bool
    let threads: ThreadsService
    let spaces: SpacesService
}

// Runs the chat: one turn at a time, streamed into the transcript, in the conversation that is open. A room posts instead of streaming: Bob answers as a message everyone sees.
@MainActor @Observable final class ChatViewModel {
    enum OpenPhase: Equatable {
        case ready
        case opening
        case failed(id: String, error: ApiError)
    }

    private static let goneNotice = "That chat isn't here any more, so here's a fresh one."
    private static let deleteFailed = "Couldn't delete those messages."
    // A turn the person left keeps running on the server for at most two minutes.
    private static let followAttempts = 30
    private static let followInterval: Duration = .seconds(4)
    // Long enough for the server to store a stopped reply.
    private static let stopSettle: Duration = .seconds(2)
    // Words on screen at most this often, so a long reply isn't redrawn for every token.
    private static let deltaInterval: Duration = .milliseconds(40)
    private static let feedbackFailed = "Couldn't send that. Try again in a moment."

    private(set) var transcript: ChatTranscript
    private(set) var openPhase: OpenPhase = .ready
    private(set) var saveFailed = false
    private(set) var retrying = false
    // A plain sentence about what just happened to the chat.
    var notice: String?
    // A failed action, shown as an alert.
    var message: String?
    private(set) var composerContext = UUID()
    var draft: String = ""
    private(set) var attachments: [ChatOutgoingAttachment] = []
    private(set) var preparingAttachments = false
    var attachmentError: String?
    @ObservationIgnored private var attachmentDrafts: [String: [ChatOutgoingAttachment]] = [:]
    @ObservationIgnored private var attachmentTask: Task<Void, Never>?

    @ObservationIgnored private var appBinding: ChatAppBinding?
    @ObservationIgnored private var appConversationCreated: ((String) -> Void)?
    @ObservationIgnored private let service: ChatStreaming
    @ObservationIgnored private let conversations: ConversationsService?
    @ObservationIgnored private let makeID: () -> String
    // Unsent words per chat. In memory only: conversation text never reaches disk.
    @ObservationIgnored private var drafts: [String: String] = [:]
    // Observed so the Send button enables as soon as a turn ends.
    private var turnTask: Task<Void, Never>?
    // The person's client message id of the current turn: the server's stop route is keyed by it.
    @ObservationIgnored private var turnMessageID: String?
    // Words waiting for the next redraw.
    @ObservationIgnored private var pendingDeltas: [ChatStreamEvent] = []
    @ObservationIgnored private var deltaFlush: Task<Void, Never>?
    // Replies with a rating on its way, so the same thumb can't be sent twice.
    private(set) var ratingsInFlight: Set<String> = []
    // Bumped by anything that changes what's open, so an older read-back can't land on top of it.
    @ObservationIgnored private var generation = 0

    @ObservationIgnored let room: ChatRoom?
    private(set) var roomPeople: [RoomPerson] = []
    private(set) var posting = false
    // Whom the room is asking Bob for right now; his turn shows as typing.
    private(set) var bobThinking = false
    @ObservationIgnored private var roomMe: String?
    @ObservationIgnored private var roomMemberIDs: [String] = []
    @ObservationIgnored private var roomStored: [ThreadMessage] = []
    @ObservationIgnored private var roomPending: [ChatMessage] = []
    @ObservationIgnored private var roomTitle: String?
    @ObservationIgnored private var roomReadThrough: Int?
    @ObservationIgnored private var roomNewest: Set<String> = []
    @ObservationIgnored private var roomOpened = false

    init(service: ChatStreaming, conversations: ConversationsService? = nil, transcript: ChatTranscript = ChatTranscript(), makeID: @escaping () -> String = { UUID().uuidString }, room: ChatRoom? = nil, appBinding: ChatAppBinding? = nil, appConversationCreated: ((String) -> Void)? = nil) {
        self.appBinding = appBinding
        self.appConversationCreated = appConversationCreated
        self.service = service
        self.conversations = conversations
        self.transcript = transcript
        self.makeID = makeID
        self.room = room
        roomTitle = room?.title
    }

    // A room never streams, so there's nothing behind this.
    convenience init(room: ChatRoom, appBinding: ChatAppBinding? = nil) {
        self.init(service: RoomHasNoStream(), room: room, appBinding: appBinding)
    }

    func preserveUnsent(from other: ChatViewModel) {
        if !other.draft.isEmpty { draft = other.draft }
        attachments = other.attachments
    }

    var marketingBinding: ChatAppBinding? { appBinding }

    var canSend: Bool {
        if room != nil {
            return !posting && openPhase == .ready && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return turnTask == nil && !preparingAttachments && openPhase == .ready && transcript.canSend(draft: draft, hasAttachments: !attachments.isEmpty)
    }

    // A room's Bob can't be stopped: the server can't cancel a run yet.
    var canStop: Bool {
        room == nil && transcript.canStop
    }

    // Who the @ picker offers for what's being typed. Nil when nothing is being typed after an @.
    var mentionMatches: [RoomPerson]? {
        guard room != nil, let query = RoomMentions.activeQuery(in: draft) else { return nil }
        let matches = RoomMentions.matches(query, people: roomPeople)
        return matches.isEmpty ? nil : matches
    }

    func insertMention(_ person: RoomPerson) {
        draft = RoomMentions.inserting(person, into: draft)
    }

    var roomHandles: [String] { roomPeople.compactMap(\.handle) }

    func hasVisibleActions(_ message: ChatMessage) -> Bool {
        if room != nil { return roomNewest.contains(message.id) }
        return message.id == (message.role == .bob ? transcript.lastReplyID : transcript.lastPersonMessage?.id)
    }

    func canRegenerate(_ message: ChatMessage) -> Bool {
        room == nil && message.id == transcript.lastReplyID && isIdle && transcript.conversationID != nil && message.state != .streaming
    }

    var isIdle: Bool {
        turnTask == nil && openPhase == .ready && !retrying && !preparingAttachments
    }

    // Non-nil while a reopened chat waits on Bob: the view follows it for as long as it stays the same.
    var followKey: String? {
        guard room == nil, isIdle, transcript.isUnanswered else { return nil }
        return transcript.conversationID
    }

    // Opening a chat leaves any running turn alone on the server, as the web does: its reply is there when the chat is reopened.
    func open(_ id: String) {
        guard conversations != nil, id != transcript.conversationID || openPhase != .ready || appBinding != nil else {
            return
        }
        leaveCurrent()
        transcript = ChatTranscript(conversationID: id)
        draft = drafts[id] ?? ""
        attachments = attachmentDrafts[id] ?? []
        load(id)
    }

    func retryOpen() {
        guard case .failed(let id, _) = openPhase else { return }
        if room != nil {
            Task { await openRoom() }
            return
        }
        load(id)
    }

    func newChat() {
        leaveCurrent()
        transcript = ChatTranscript()
        openPhase = .ready
        draft = drafts[""] ?? ""
        attachments = attachmentDrafts[""] ?? []
    }

    func conversationDeleted(_ id: String) {
        drafts[id] = nil
        attachmentDrafts[id] = nil
        if transcript.conversationID == id {
            draft = ""
            attachments = []
            newChat()
        }
    }

    func conversationRenamed(_ id: String, title: String) {
        if transcript.conversationID == id {
            transcript.setTitle(title)
        }
    }

    private func leaveCurrent() {
        composerContext = UUID()
        attachmentDrafts[transcript.conversationID ?? ""] = attachments.isEmpty ? nil : attachments
        attachmentTask?.cancel()
        attachmentTask = nil
        preparingAttachments = false
        attachmentError = nil
        attachments = []
        appBinding = nil
        appConversationCreated = nil
        drafts[transcript.conversationID ?? ""] = draft.isEmpty ? nil : draft
        generation += 1
        discardDeltas()
        turnTask?.cancel()
        turnTask = nil
        turnMessageID = nil
        saveFailed = false
        retrying = false
        notice = nil
    }

    private func load(_ id: String) {
        guard let conversations else { return }
        openPhase = .opening
        generation += 1
        let loading = generation
        Task {
            do {
                let detail = try await conversations.conversation(id: id)
                guard loading == generation else { return }
                transcript = ChatTranscript(detail: detail)
                openPhase = .ready
            } catch ApiError.notFound {
                guard loading == generation else { return }
                appBinding = nil
                appConversationCreated = nil
                drafts[id] = nil
                attachmentDrafts[id] = nil
                draft = ""
                attachments = []
                transcript = ChatTranscript()
                openPhase = .ready
                notice = Self.goneNotice
            } catch {
                guard loading == generation, !isCancelled(error) else { return }
                openPhase = .failed(id: id, error: apiError(error))
            }
        }
    }

    func send() {
        guard canSend else {
            return
        }
        let text = draft
        let draftKey = transcript.conversationID ?? ""
        drafts[draftKey] = nil
        attachmentDrafts[draftKey] = nil
        draft = ""
        if room != nil {
            postToRoom(text)
            return
        }
        let files = attachments
        attachments = []
        startNewTurn(text: text, origin: .text, workflowID: nil, attachments: files)
    }

    func removeAttachment(_ id: UUID) { attachments.removeAll { $0.id == id }; attachmentError = nil }

    func prepareAttachments(_ read: @escaping @Sendable () async throws -> [ChatOutgoingAttachment]) {
        guard room == nil, isIdle, !transcript.isStreaming, !preparingAttachments else { return }
        let request = generation
        preparingAttachments = true
        attachmentError = nil
        attachmentTask = Task {
            defer { if request == generation { preparingAttachments = false; attachmentTask = nil } }
            do {
                let incoming = try await read()
                guard request == generation, !Task.isCancelled else { return }
                try ChatOutgoingAttachment.validate(attachments + incoming)
                attachments += incoming
            } catch {
                guard request == generation, !Task.isCancelled else { return }
                attachmentError = (error as? ChatAttachmentError)?.message ?? ChatAttachmentError.unreadable.message
            }
        }
    }

    // A spoken turn: the same conversation and the same stream, recorded as spoken. Words in the composer stay there.
    func sendVoice(_ text: String, workflowID: String) -> Bool {
        guard room == nil, turnTask == nil, !preparingAttachments, openPhase == .ready, transcript.canSend(draft: text) else {
            return false
        }
        startNewTurn(text: text, origin: .voice, workflowID: workflowID)
        return true
    }

    private func startNewTurn(text: String, origin: ChatOrigin, workflowID: String?, attachments: [ChatOutgoingAttachment] = []) {
        let userMessageID = makeID()
        let replyMessageID = makeID()
        transcript.beginTurn(userMessageID: userMessageID, replyMessageID: replyMessageID, text: text, at: Date(), origin: origin, attachments: attachments.map(\.display))
        guard transcript.isStreaming else {
            return
        }
        start(text: text, messageID: userMessageID, turn: .new, origin: origin, workflowID: workflowID, attachments: attachments)
    }

    // How much of an interrupted reply was heard. The server only knows the reply by its own id, so this waits for the stopped reply to be stored and reads it back. It's a nicety, so failing is quiet.
    func noteHeard(characters: Int) {
        guard characters > 0, let conversations, let id = transcript.conversationID, let personID = transcript.lastPersonMessage?.id else {
            return
        }
        Task {
            try? await Task.sleep(for: Self.stopSettle)
            guard let detail = try? await conversations.conversation(id: id),
                  let person = detail.messages.firstIndex(where: { $0.id == personID }),
                  person + 1 < detail.messages.count, detail.messages[person + 1].role == .assistant else {
                return
            }
            try? await conversations.markHeard(conversationID: id, messageID: detail.messages[person + 1].id, heardCharacters: characters)
        }
    }

    private func start(text: String, messageID: String, turn: ChatTurn, origin: ChatOrigin = .text, workflowID: String? = nil, attachments: [ChatOutgoingAttachment] = []) {
        generation += 1
        saveFailed = false
        notice = nil
        turnMessageID = messageID
        let stream = service.send(text: text, messageID: messageID, conversationID: transcript.conversationID, turn: turn, origin: origin, workflowID: workflowID, appBinding: appBinding, attachments: attachments)
        turnTask = Task { [weak self] in
            // A tool may have succeeded even when the reply stream fails or is
            // cancelled. Reconcile confirmed Core timers on every exit.
            defer { Task { await TimerNotifications.shared.refresh(requestPermission: true) } }
            do {
                for try await event in stream {
                    guard !Task.isCancelled else {
                        return
                    }
                    self?.ingest(event)
                }
                guard !Task.isCancelled else {
                    return
                }
                self?.flushDeltas()
                // A stream that ends without a finish part still completes the reply, so sending is never stuck.
                self?.transcript.apply(.done)
            } catch let error as ApiError {
                if !Task.isCancelled {
                    self?.flushDeltas()
                    self?.transcript.fail(error)
                }
            } catch {
                if !Task.isCancelled {
                    self?.flushDeltas()
                    self?.transcript.fail(.unknown(status: 0))
                }
            }
            self?.endTurn(messageID)
        }
    }

    // Words wait for the next redraw; anything else lands at once, after the words before it.
    private func ingest(_ event: ChatStreamEvent) {
        switch event {
        case .textDelta, .reasoningDelta:
            pendingDeltas.append(event)
            guard deltaFlush == nil else { return }
            deltaFlush = Task { [weak self] in
                try? await Task.sleep(for: Self.deltaInterval)
                guard !Task.isCancelled else { return }
                self?.flushDeltas()
            }
        default:
            flushDeltas()
            transcript.apply(event)
            if case .toolOutputAvailable = event {
                Task { await TimerNotifications.shared.refresh(requestPermission: true) }
            }
            if appBinding != nil, let id = transcript.conversationID { appConversationCreated?(id) }
        }
    }

    private func flushDeltas() {
        deltaFlush?.cancel()
        deltaFlush = nil
        let events = pendingDeltas
        pendingDeltas = []
        for event in events {
            transcript.apply(event)
        }
    }

    private func discardDeltas() {
        deltaFlush?.cancel()
        deltaFlush = nil
        pendingDeltas = []
    }

    func canRate(_ message: ChatMessage) -> Bool {
        message.role == .bob && message.traceID != nil && message.state != .streaming && !ratingsInFlight.contains(message.id)
    }

    // Thumbs on a reply. Shown as chosen once the server has it.
    func rate(_ message: ChatMessage, positive: Bool) {
        guard let conversations, let traceID = message.traceID, canRate(message), message.feedback != positive else {
            return
        }
        ratingsInFlight.insert(message.id)
        Task {
            defer { ratingsInFlight.remove(message.id) }
            do {
                try await conversations.sendFeedback(traceID: traceID, positive: positive)
                // A read-back may have given the reply its stored id while this was on its way.
                let current = transcript.messages.first { $0.traceID == traceID }
                if let current {
                    transcript.setFeedback(messageID: current.id, positive: positive)
                }
            } catch {
                guard !isCancelled(error) else { return }
                self.message = Self.feedbackFailed
            }
        }
    }

    // Sends a suggestion the person tapped, as if they had typed it.
    func send(suggestion: String) {
        draft = suggestion
        send()
    }

    func stop() {
        guard transcript.canStop else {
            return
        }
        flushDeltas()
        transcript.stop()
        turnTask?.cancel()
        turnTask = nil
        guard let messageID = turnMessageID else {
            return
        }
        turnMessageID = nil
        let service = service
        Task {
            await service.stop(messageID: messageID)
            await TimerNotifications.shared.refresh(requestPermission: true)
        }
        // The server keeps what was said so far under an id of its own, which editing needs.
        generation += 1
        let stopped = generation
        Task { [weak self] in
            try? await Task.sleep(for: Self.stopSettle)
            guard let self, stopped == self.generation else { return }
            await self.syncFromServer()
        }
    }

    // After a failure the server may or may not hold the person's message, so ask before sending: resending a stored one would say it twice.
    func retry() {
        guard room == nil, turnTask == nil, !preparingAttachments, !retrying, transcript.failureMessage != nil, let person = transcript.lastPersonMessage else {
            return
        }
        guard let conversations, let id = transcript.conversationID else {
            resend(person)
            return
        }
        retrying = true
        generation += 1
        let retried = generation
        Task {
            defer { if retried == generation { retrying = false } }
            do {
                let detail = try await conversations.conversation(id: id)
                guard retried == generation else { return }
                if detail.messages.last(where: { $0.role == .user })?.id == person.id {
                    retrying = false
                    transcript.restore(detail)
                    regenerate()
                } else {
                    retrying = false
                    resend(person)
                }
            } catch {
                guard retried == generation, !isCancelled(error) else { return }
                message = ApiErrorMapper.userMessage(apiError(error))
            }
        }
    }

    private func resend(_ person: ChatMessage) {
        do {
            let files = try person.attachments.map(ChatOutgoingAttachment.init(stored:))
            transcript.removeFrom(messageID: person.id)
            startNewTurn(text: person.text, origin: person.originNote == ChatOrigin.voice.note ? .voice : .text, workflowID: nil, attachments: files)
        } catch { message = "The attachment couldn't be recovered. Please choose the file again." }
    }

    func regenerate() {
        guard room == nil, isIdle, transcript.conversationID != nil, let person = transcript.lastPersonMessage else {
            return
        }
        transcript.beginRegenerate(replyMessageID: makeID())
        guard transcript.isStreaming else {
            return
        }
        start(text: person.text, messageID: person.id, turn: .regenerate)
    }

    func canEdit(_ message: ChatMessage) -> Bool {
        if room != nil { return message.isMine && message.isStored && !message.isDeleted }
        return isIdle && transcript.editTurn(for: message.id) != nil
    }

    // Everything from this message on is replaced by the new words and a new reply.
    func edit(_ message: ChatMessage, text: String) {
        if room != nil {
            editInRoom(message, text: text)
            return
        }
        guard isIdle, let turn = transcript.editTurn(for: message.id) else {
            return
        }
        let files: [ChatOutgoingAttachment]
        do { files = try message.attachments.map(ChatOutgoingAttachment.init(stored:)) }
        catch { self.message = "The attachment couldn't be recovered. Please choose the file again."; return }
        let userMessageID = makeID()
        transcript.removeFrom(messageID: message.id)
        transcript.beginTurn(userMessageID: userMessageID, replyMessageID: makeID(), text: text, at: Date(), attachments: files.map(\.display))
        guard transcript.isStreaming else {
            return
        }
        start(text: text, messageID: userMessageID, turn: turn, attachments: files)
    }

    func canDeleteFrom(_ message: ChatMessage) -> Bool {
        if room != nil { return message.isMine && message.isStored && !message.isDeleted }
        return isIdle && message.role == .person && message.isStored && transcript.conversationID != nil
    }

    func deleteFrom(_ message: ChatMessage) async {
        if room != nil {
            await deleteInRoom(message)
            return
        }
        guard let conversations, let id = transcript.conversationID, canDeleteFrom(message) else {
            return
        }
        do {
            try await conversations.deleteMessages(conversationID: id, from: message.id)
            guard transcript.conversationID == id else { return }
            // A read-back from before the delete must not bring the messages back.
            generation += 1
            transcript.removeFrom(messageID: message.id)
        } catch {
            guard !isCancelled(error) else { return }
            self.message = Self.deleteFailed
        }
    }

    // Reads the open chat back. A reply the server should hold but doesn't is kept on screen, and said out loud only when the caller is checking for it.
    func syncFromServer(checkSaved: Bool = false) async {
        if room != nil {
            await syncRoom()
            return
        }
        guard let conversations, let id = transcript.conversationID, isIdle, transcript.failureMessage == nil else {
            return
        }
        generation += 1
        let reading = generation
        do {
            let detail = try await conversations.conversation(id: id)
            guard reading == generation, isIdle else { return }
            let stored = detail.messages.filter { $0.role == .assistant }.count
            if stored < transcript.storableReplyCount {
                saveFailed = checkSaved
                return
            }
            transcript.restore(detail)
        } catch {
            if checkSaved, reading == generation, !isCancelled(error) {
                saveFailed = true
            }
        }
    }

    // The web reloads on the server's message event. There is no reconnecting to a turn's stream anywhere, so this reads the chat back until the reply is there.
    func followUnanswered() async {
        for _ in 0..<Self.followAttempts {
            try? await Task.sleep(for: Self.followInterval)
            guard !Task.isCancelled, transcript.isUnanswered else { return }
            await syncFromServer()
        }
    }

    func dismissSaveFailed() {
        saveFailed = false
    }

    // Only the turn that is still current clears the handle; a stopped turn was already cleared.
    private func endTurn(_ messageID: String) {
        guard turnMessageID == messageID else {
            return
        }
        turnTask = nil
        turnMessageID = nil
        // The read-back gives the reply the id the server stored it under, and shows if it wasn't.
        if case .complete = transcript.messages.last?.state {
            Task { await syncFromServer(checkSaved: true) }
        }
    }

    // MARK: A shared chat

    private static let roomPollInterval: Duration = .seconds(5)

    func openRoom() async {
        guard let room else { return }
        if roomStored.isEmpty { openPhase = .opening }
        do {
            async let members = room.spaces.members(spaceID: room.spaceID)
            async let me = room.spaces.selfUserID()
            let (people, myID) = try await (members, me)
            roomPeople = RoomTranscript.people(people)
            roomMemberIDs = people.map(\.userID)
            roomMe = myID
            let loaded = try await room.threads.messages(threadID: room.threadID)
            openPhase = .ready
            settle(loaded)
        } catch where isCancelled(error) {
            return
        } catch {
            if roomStored.isEmpty {
                openPhase = .failed(id: room.threadID, error: apiError(error))
            }
        }
    }

    // There's no account stream on iPhone yet, so an open room looks every few seconds for what others said.
    func followRoom() async {
        await openRoom()
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.roomPollInterval)
            guard !Task.isCancelled else { return }
            await syncRoom()
        }
    }

    private func syncRoom() async {
        guard let room else { return }
        // A failure keeps what's on screen; the next look may work.
        guard let loaded = try? await room.threads.messages(threadID: room.threadID), openPhase == .ready else { return }
        settle(loaded)
    }

    private func settle(_ loaded: ThreadMessages) {
        guard let room else { return }
        // Nothing new: no redraw, so reading isn't disturbed.
        guard !roomOpened || loaded.messages != roomStored else { return }
        roomOpened = true
        roomStored = loaded.messages
        rebuildRoom()
        // More than one screen of history: only what was really shown counts as read.
        let last = loaded.messages.last?.sequence
        guard let last, last != roomReadThrough else { return }
        roomReadThrough = last
        let threads = room.threads
        let through = loaded.isCapped ? last : nil
        Task { try? await threads.markRead(threadID: room.threadID, through: through) }
    }

    private func rebuildRoom() {
        guard let room else { return }
        var shown = roomStored.map { RoomTranscript.chatMessage($0, people: roomPeople, me: roomMe) }
        shown += roomPending
        if bobThinking {
            shown.append(ChatMessage(id: "bob-thinking", role: .bob, text: "", state: .streaming, author: ChatAuthor(id: "bob", name: RoomMentions.shownName, initials: "B", isMe: false)))
        }
        roomNewest = RoomTranscript.newestPerAuthor(shown)
        transcript.setRoom(id: room.threadID, title: roomTitle, messages: shown)
    }

    func setRoomTitle(_ title: String) {
        roomTitle = title
        rebuildRoom()
    }

    private func postToRoom(_ typed: String) {
        guard let room else { return }
        let shown = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = RoomMentions.toWire(shown, handles: roomHandles)
        let binding = appBinding
        let clientID = makeID()
        let author = roomPeople.first { $0.id == roomMe }
        let pending = ChatMessage(id: "pending-\(clientID)", role: .person, text: shown, state: .complete, createdAt: Date(), author: ChatAuthor(id: roomMe ?? "", name: author?.name ?? "You", initials: author?.initials ?? "", isMe: true))
        roomPending.append(pending)
        posting = true
        notice = nil
        rebuildRoom()
        AccessibilityAnnouncer.say("Sending your message")
        Task {
            defer { posting = false }
            do {
                let posted = try await room.threads.post(threadID: room.threadID, body: body, clientMessageID: clientID)
                roomPending.removeAll { $0.id == pending.id }
                if !roomStored.contains(where: { $0.id == posted.id }) { roomStored.append(posted) }
                rebuildRoom()
                if binding != nil || RoomMentions.shouldAskBob(body, requireMention: room.requireMention, memberIDs: roomMemberIDs, me: roomMe) {
                    ask(posted, binding: binding)
                }
            } catch {
                roomPending.removeAll { $0.id == pending.id }
                rebuildRoom()
                // The words come back so nothing typed is lost.
                if draft.isEmpty { draft = shown }
                self.message = "Your message didn't send. Try again."
            }
        }
    }

    private func ask(_ trigger: ThreadMessage, binding: ChatAppBinding? = nil) {
        guard let room else { return }
        bobThinking = true
        rebuildRoom()
        Task {
            var note: String?
            do {
                switch try await room.threads.askBob(threadID: room.threadID, triggerMessageID: trigger.id, appBinding: binding) {
                case .answered: break
                case .busy: note = "Bob is already answering in this thread. Ask again when that reply lands."
                case .cancelled: note = "Bob stopped before answering."
                case .pending: note = "Bob is still working on it. His reply will appear here."
                case .failed: note = "Bob could not answer. Try asking again."
                }
            } catch {
                note = isCancelled(error) ? nil : binding != nil && (error as? ApiError) == .unknown(status: 409) ? "This app changed. Return to the app and reopen its conversation before trying again." : "Bob could not answer. Try asking again."
            }
            bobThinking = false
            notice = note
            rebuildRoom()
            await syncRoom()
        }
    }

    private func editInRoom(_ message: ChatMessage, text: String) {
        guard let room, let old = roomStored.first(where: { $0.id == message.id }) else { return }
        let body = RoomMentions.toWire(text, handles: roomHandles)
        Task {
            do {
                let edited = try await room.threads.edit(messageID: message.id, body: body)
                replaceStored(edited)
                // Fixing a forgotten @Bob asks him; fixing a typo in a message that already did doesn't ask twice.
                let asks = { (text: String) in RoomMentions.shouldAskBob(text, requireMention: room.requireMention, memberIDs: self.roomMemberIDs, me: self.roomMe) }
                if asks(body), !asks(old.body) { ask(edited) }
            } catch {
                self.message = "That edit didn't save. Try again."
            }
        }
    }

    private func deleteInRoom(_ message: ChatMessage) async {
        guard let room else { return }
        do {
            replaceStored(try await room.threads.delete(messageID: message.id))
            AccessibilityAnnouncer.say("Message deleted")
        } catch {
            self.message = "That message couldn't be deleted. Try again."
        }
    }

    private func replaceStored(_ message: ThreadMessage) {
        guard let index = roomStored.firstIndex(where: { $0.id == message.id }) else { return }
        roomStored[index] = message
        rebuildRoom()
    }
}

private struct RoomHasNoStream: ChatStreaming {
    func send(text: String, messageID: String, conversationID: String?, turn: ChatTurn, origin: ChatOrigin, workflowID: String?) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    func stop(messageID: String) async {}
}
