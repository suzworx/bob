import Foundation

// Who may do what, the same as the web's menus. The server enforces it either way.
public enum SpaceRules {
    public static func isPrivileged(_ role: SpaceRole) -> Bool {
        role == .owner || role == .admin
    }

    public static func canRename(_ space: SpaceSummary) -> Bool {
        space.kind != .private && isPrivileged(space.role)
    }

    public static func canArchive(_ space: SpaceSummary) -> Bool {
        space.kind == .group && space.role == .owner
    }

    public static func canLeave(_ space: SpaceSummary) -> Bool {
        space.kind != .private && space.role != .owner
    }

    public static func canInvite(_ space: SpaceSummary) -> Bool {
        space.kind != .private && isPrivileged(space.role)
    }

    // A private space has no threads or members.
    public static func isShared(_ space: SpaceSummary) -> Bool {
        space.kind != .private
    }

    public static func canRemove(member: SpaceMember, in space: SpaceSummary, me: String?) -> Bool {
        guard member.role != .owner else { return false }
        return member.userID == me ? space.kind != .private : isPrivileged(space.role)
    }

    public static func canChangeRole(of member: SpaceMember, in space: SpaceSummary, me: String?) -> Bool {
        space.role == .owner && member.userID != me && member.role != .owner
    }

    public static func canMakeOwner(_ member: SpaceMember, in space: SpaceSummary, me: String?) -> Bool {
        space.role == .owner && space.kind == .group && member.userID != me && member.role != .owner
    }

    public static func canArchive(thread: SpaceThread, in space: SpaceSummary, me: String?) -> Bool {
        thread.createdBy == me || isPrivileged(space.role)
    }

    // Most recent activity first, as the web lists them.
    public static func byActivity(_ spaces: [SpaceSummary]) -> [SpaceSummary] {
        spaces.sorted { ($0.lastActivityAt ?? $0.updatedAt ?? .distantPast) > ($1.lastActivityAt ?? $1.updatedAt ?? .distantPast) }
    }

    // "Just you", or who it's for and what's in it.
    public static func subline(_ space: SpaceSummary) -> String {
        guard space.kind != .private else { return "Just you" }
        var parts = [space.kind == .pair ? "Pair" : "Group"]
        if space.threadCount > 0 {
            parts.append("\(space.threadCount) \(space.threadCount == 1 ? "thread" : "threads")")
        }
        return parts.joined(separator: " · ")
    }

    public static func displayName(_ member: SpaceMember) -> String {
        name(displayName: member.displayName, email: member.email, handle: member.handle)
    }

    public static func name(displayName: String?, email: String? = nil, handle: String? = nil) -> String {
        for candidate in [displayName, handle, email] {
            if let candidate, !candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return candidate }
        }
        return "Someone"
    }

    public static func initials(_ name: String) -> String {
        let letters = name.split(whereSeparator: { $0.isWhitespace || $0 == "@" || $0 == "." }).prefix(2).compactMap(\.first)
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }

    // The web's check: something, an @, something, a dot, something; and the server's limit.
    public static func isValidEmail(_ text: String) -> Bool {
        let email = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard email.count <= 254, !email.contains(where: \.isWhitespace) else { return false }
        let parts = email.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        return domain.count >= 2 && domain.allSatisfy { !$0.isEmpty }
    }

    public static func cleanName(_ text: String, limit: Int) -> String? {
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty || name.count > limit ? nil : name
    }

    public static let spaceNameLimit = 60
    public static let threadTitleLimit = 120
}

// An invitation as a person has it: the bare token, or the whole link.
public struct InvitationCode: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case space, groupChat
        // A bare token could be either, so both get asked.
        case unknown
    }

    public let token: String
    public let kind: Kind

    public init(token: String, kind: Kind) {
        self.token = token
        self.kind = kind
    }

    public init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var path = trimmed
        if let url = URLComponents(string: trimmed), url.host != nil || trimmed.hasPrefix("/") {
            path = url.path
        }
        let pieces = path.split(separator: "/").map(String.init)
        var token = trimmed
        var kind = Kind.unknown
        if let index = pieces.lastIndex(where: { $0 == "invite" || $0 == "join-chat" }), index + 1 < pieces.count {
            token = pieces[index + 1].removingPercentEncoding ?? pieces[index + 1]
            kind = pieces[index] == "invite" ? .space : .groupChat
        }
        // Tokens are URL-safe base64 of 32 bytes, so anything else is not one and never reaches a URL.
        guard token.count == 43, token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            return nil
        }
        self.token = token
        self.kind = kind
    }

    public static func spaceLink(token: String, base: URL) -> String {
        base.appendingPathComponent("invite").appendingPathComponent(token).absoluteString
    }

    public static func groupChatLink(token: String, base: URL) -> String {
        base.appendingPathComponent("join-chat").appendingPathComponent(token).absoluteString
    }
}

// A person in a shared chat, as the conversation needs them.
public struct RoomPerson: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let handle: String?
    // A stable colour per person.
    public let fillIndex: Int

    public init(id: String, name: String, handle: String? = nil, fillIndex: Int = 0) {
        self.id = id
        self.name = name
        self.handle = handle
        self.fillIndex = fillIndex
    }

    public var initials: String { SpaceRules.initials(name) }
}

// Bob's name, what people type and what the server's parser reads. The server reads @bob; people see @Bob.
public enum RoomMentions {
    public static let wireHandle = "bob"
    public static let shownName = "Bob"

    private static let code = try? NSRegularExpression(pattern: "```[\\s\\S]*?(?:```|$)|`[^`]*`")
    private static let wire = address(wireHandle)

    // Not after a word character or a backslash, and not continued by another handle character, so @bob.bob is a person.
    private static func address(_ handle: String) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: "(^|[^A-Za-z0-9_\\\\])@\(handle)(?![A-Za-z0-9_]|[.-]+[A-Za-z0-9_])", options: [.caseInsensitive])
    }

    // Whether this message asks Bob. Code is skipped, as the server skips it.
    public static func addressesBob(_ body: String) -> Bool {
        let text = outsideCode(body).joined(separator: " ")
        guard let wire else { return false }
        return wire.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    // In a group chat only @Bob asks him. Alone in a space, there is no one else a plain message could be for.
    public static func shouldAskBob(_ body: String, requireMention: Bool, memberIDs: [String], me: String?) -> Bool {
        if addressesBob(body) { return true }
        return !requireMention && memberIDs.count == 1 && memberIDs.first == me && me != nil
    }

    // "@Bob" typed here becomes the handle the server reads, unless someone in the room is really called that.
    public static func toWire(_ text: String, handles: [String]) -> String {
        if handles.contains(where: { $0.lowercased() == wireHandle }) { return text }
        return replacing(in: text, regex: wire, with: "@\(wireHandle)")
    }

    public static func toShown(_ body: String) -> String {
        replacing(in: body, regex: wire, with: "@\(shownName)")
    }

    // The @word being typed at the end of the draft, if there is one.
    public static func activeQuery(in draft: String) -> String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex {
            let before = draft[draft.index(before: at)]
            guard !(before.isLetter || before.isNumber || before == "_" || before == "\\") else { return nil }
        }
        let query = draft[draft.index(after: at)...]
        return query.contains(where: { $0.isWhitespace }) ? nil : String(query)
    }

    public static func matches(_ query: String, people: [RoomPerson]) -> [RoomPerson] {
        let bob = RoomPerson(id: "bob", name: shownName, handle: "bob")
        let everyone = people.filter { $0.handle != nil } + [bob]
        guard !query.isEmpty else { return everyone }
        return everyone.filter { ($0.handle ?? "").localizedCaseInsensitiveContains(query) || $0.name.localizedCaseInsensitiveContains(query) }
    }

    public static func inserting(_ person: RoomPerson, into draft: String) -> String {
        guard let handle = person.handle, activeQuery(in: draft) != nil, let at = draft.lastIndex(of: "@") else { return draft }
        return String(draft[..<at]) + "@\(handle) "
    }

    // The words of a message, marking where someone real is mentioned, so only they stand out.
    public static func segments(_ text: String, handles: [String]) -> [(text: String, isMention: Bool)] {
        let known = Set(handles.map { $0.lowercased() } + ["bob"])
        guard let regex = try? NSRegularExpression(pattern: "(?<![A-Za-z0-9_\\\\])@[A-Za-z0-9][A-Za-z0-9._-]{0,39}") else { return [(text, false)] }
        var out: [(text: String, isMention: Bool)] = []
        var last = text.startIndex
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let range = Range(match.range, in: text) else { continue }
            var name = text[text.index(after: range.lowerBound)..<range.upperBound]
            while let tail = name.last, tail == "." || tail == "-" { name.removeLast() }
            guard known.contains(name.lowercased()) else { continue }
            let end = name.endIndex
            if last < range.lowerBound { out.append((String(text[last..<range.lowerBound]), false)) }
            out.append((String(text[range.lowerBound..<end]), true))
            last = end
        }
        if last < text.endIndex { out.append((String(text[last...]), false)) }
        return out
    }

    private static func outsideCode(_ body: String) -> [String] {
        pieces(of: body).filter { !$0.isCode }.map(\.text)
    }

    private static func pieces(of body: String) -> [(text: String, isCode: Bool)] {
        guard let code else { return [(body, false)] }
        var out: [(text: String, isCode: Bool)] = []
        var last = body.startIndex
        for match in code.matches(in: body, range: NSRange(body.startIndex..., in: body)) {
            guard let range = Range(match.range, in: body) else { continue }
            out.append((String(body[last..<range.lowerBound]), false))
            out.append((String(body[range]), true))
            last = range.upperBound
        }
        out.append((String(body[last...]), false))
        return out
    }

    private static func replacing(in text: String, regex: NSRegularExpression?, with mention: String) -> String {
        guard let regex else { return text }
        let template = "$1" + NSRegularExpression.escapedTemplate(for: mention)
        return pieces(of: text).map { piece in
            piece.isCode ? piece.text : regex.stringByReplacingMatches(in: piece.text, range: NSRange(piece.text.startIndex..., in: piece.text), withTemplate: template)
        }.joined()
    }
}

// Turns what a thread holds into what the one conversation view shows.
public enum RoomTranscript {
    public static func chatMessage(_ message: ThreadMessage, people: [RoomPerson], me: String?) -> ChatMessage {
        let isDeleted = message.tombstonedAt != nil
        let author: ChatAuthor?
        if let id = message.authorUserID {
            let person = people.first { $0.id == id }
            author = ChatAuthor(id: id, name: person?.name ?? "Someone", initials: person?.initials ?? "?", fillIndex: person?.fillIndex ?? 0, isMe: id == me)
        } else {
            author = ChatAuthor(id: "bob", name: RoomMentions.shownName, initials: "B", fillIndex: 0, isMe: false)
        }
        let note: String?
        switch message.origin {
        case .webText: note = nil
        case .webVoice: note = "spoken"
        case .device: note = "via a device"
        }
        let isBob = message.authorUserID == nil
        return ChatMessage(
            id: message.id,
            role: isBob ? .bob : .person,
            text: isBob ? message.body : RoomMentions.toShown(message.body),
            state: .complete,
            originNote: note,
            isStored: true,
            createdAt: message.createdAt,
            author: author,
            isEdited: message.revision > 1 && !isDeleted,
            isDeleted: isDeleted
        )
    }

    // The newest message per author carries its actions in plain sight.
    public static func newestPerAuthor(_ messages: [ChatMessage]) -> Set<String> {
        var newest: [String: String] = [:]
        for message in messages where !message.isDeleted && message.state != .streaming {
            newest[message.author?.id ?? ""] = message.id
        }
        return Set(newest.values)
    }

    // A stable colour for each person, in the order they joined.
    public static func people(_ members: [SpaceMember]) -> [RoomPerson] {
        members.enumerated().map { index, member in
            RoomPerson(id: member.userID, name: SpaceRules.displayName(member), handle: member.handle, fillIndex: index)
        }
    }
}

// One conversation a device could talk in: a private chat, or a space's thread.
public struct DeviceTalkOption: Equatable, Sendable, Identifiable {
    public let ref: String
    public let title: String
    public let place: String
    public let updatedAt: Date
    public let spaceID: String?
    public let threadID: String?

    public var id: String { ref }

    public init(ref: String, title: String, place: String, updatedAt: Date, spaceID: String? = nil, threadID: String? = nil) {
        self.ref = ref
        self.title = title
        self.place = place
        self.updatedAt = updatedAt
        self.spaceID = spaceID
        self.threadID = threadID
    }

    // A private pick keeps where the device starts new conversations; a thread moves it to the thread's own space, as the server requires.
    public func target(defaultSpace: String?) -> DeviceTalkTarget {
        if let threadID, let spaceID { return .thread(id: threadID, spaceID: spaceID) }
        return .conversation(id: ref, spaceID: defaultSpace)
    }
}

public enum DeviceTalkRules {
    // The server names a device's thread with this prefix.
    private static let threadPrefix = "thr_"

    public static func threadRef(_ id: String) -> String { threadPrefix + id }

    // Private chats and every space's open threads, newest first.
    public static func options(conversations: [ConversationSummary], threads: [(space: SpaceSummary, threads: [SpaceThread])]) -> [DeviceTalkOption] {
        let chats = conversations.map { DeviceTalkOption(ref: $0.id, title: $0.displayTitle, place: "General", updatedAt: $0.updatedAt) }
        let inSpaces = threads.flatMap { group in
            group.threads.filter { $0.archivedAt == nil }.map {
                DeviceTalkOption(ref: threadRef($0.id), title: $0.title, place: group.space.name, updatedAt: $0.updatedAt, spaceID: group.space.id, threadID: $0.id)
            }
        }
        return (chats + inSpaces).sorted { $0.updatedAt > $1.updatedAt }
    }

    // What the "Talking in" row says.
    public static func talkingIn(_ device: Device, options: [DeviceTalkOption], spaces: [SpaceSummary]) -> String {
        guard let ref = device.activeConversationID else {
            return "A new conversation, in \(spaceName(device.activeSpaceID, spaces: spaces))"
        }
        guard let option = options.first(where: { $0.ref == ref }) else { return "A conversation" }
        return "\(option.title), in \(option.place)"
    }

    public static func spaceName(_ id: String?, spaces: [SpaceSummary]) -> String {
        guard let id else { return "General" }
        return spaces.first { $0.id == id }?.name ?? "General"
    }

    public static func matching(_ options: [DeviceTalkOption], query: String) -> [DeviceTalkOption] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? options : options.filter { $0.title.localizedCaseInsensitiveContains(text) }
    }
}
