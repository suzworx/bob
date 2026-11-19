import Foundation

public struct Note: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceID: String
    public var title: String
    public var body: String
    public var pinned: Bool
    public var revision: Int
    public let createdBy: String
    public var updatedBy: String
    public var aiAssisted: Bool
    public var trashedAt: Date?
    public let createdAt: Date
    public var updatedAt: Date

    public init(id: String, spaceID: String, title: String, body: String = "", pinned: Bool = false, revision: Int = 1, createdBy: String, updatedBy: String, aiAssisted: Bool = false, trashedAt: Date? = nil, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.spaceID = spaceID
        self.title = title
        self.body = body
        self.pinned = pinned
        self.revision = revision
        self.createdBy = createdBy
        self.updatedBy = updatedBy
        self.aiAssisted = aiAssisted
        self.trashedAt = trashedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, title, body, pinned, revision
        case spaceID = "space_id"
        case createdBy = "created_by"
        case updatedBy = "updated_by"
        case aiAssisted = "ai_assisted"
        case trashedAt = "trashed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct NoteRevision: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let noteID: String
    public let revision: Int
    public let title: String
    public let body: String
    public let editorUserID: String
    public let aiAssisted: Bool
    public let createdAt: Date

    public init(id: String, noteID: String, revision: Int, title: String, body: String, editorUserID: String, aiAssisted: Bool = false, createdAt: Date) {
        self.id = id
        self.noteID = noteID
        self.revision = revision
        self.title = title
        self.body = body
        self.editorUserID = editorUserID
        self.aiAssisted = aiAssisted
        self.createdAt = createdAt
    }

    enum CodingKeys: String, CodingKey {
        case id, revision, title, body
        case noteID = "note_id"
        case editorUserID = "editor_user_id"
        case aiAssisted = "ai_assisted"
        case createdAt = "created_at"
    }
}

// Notes in a space. Pin state belongs to the space, and deleting moves a note to the trash.
public struct NotesClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = .shared, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // With the trash included, as the web reads it, so one call fills both lists.
    public func notes(spaceID: String, includingTrashed: Bool = true) async throws -> [Note] {
        let query = includingTrashed ? [URLQueryItem(name: "trashed", value: "true")] : []
        let response: NotesResponse = try await http.decoded("GET", ["spaces", spaceID, "notes"], query: query)
        return response.notes
    }

    public func search(spaceID: String, query: String) async throws -> [Note] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let response: NotesResponse = try await http.decoded("GET", ["spaces", spaceID, "notes", "search"], query: [URLQueryItem(name: "q", value: String(trimmed.prefix(200)))])
        return response.notes
    }

    public func create(spaceID: String, title: String, body: String? = nil) async throws -> Note {
        var json: [String: Any] = ["title": title]
        if let body, !body.isEmpty { json["body"] = body }
        return try await http.decoded("POST", ["spaces", spaceID, "notes"], body: json)
    }

    public func note(id: String) async throws -> Note {
        try await http.decoded("GET", ["notes", id])
    }

    public func update(id: String, revision: Int, title: String, body: String) async throws -> Note {
        try await http.decoded("PATCH", ["notes", id], body: ["revision": revision, "title": title, "body": body])
    }

    public func setPinned(id: String, pinned: Bool) async throws -> Note {
        try await http.decoded(pinned ? "PUT" : "DELETE", ["notes", id, "pin"])
    }

    public func delete(id: String) async throws {
        try await http.empty("DELETE", ["notes", id])
    }

    public func restore(id: String) async throws -> Note {
        try await http.decoded("POST", ["notes", id, "restore"])
    }

    // A copy in a shared space; the private note itself stays as it is. The title always goes, the body by choice.
    public func publish(noteID: String, toSpace spaceID: String, includingBody: Bool) async throws -> Note {
        let fields: [String: Any] = ["title": true, "body": includingBody]
        return try await http.decoded("POST", ["notes", noteID, "publish"], body: ["space_id": spaceID, "fields": fields])
    }

    public func revisions(noteID: String) async throws -> [NoteRevision] {
        let response: RevisionsResponse = try await http.decoded("GET", ["notes", noteID, "revisions"])
        return response.revisions
    }
}

private struct NotesResponse: Decodable {
    let notes: [Note]
}

private struct RevisionsResponse: Decodable {
    let revisions: [NoteRevision]
}
