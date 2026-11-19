import Foundation

// A due is honest about date-only versus time-specific: a date never becomes a midnight instant.
public enum TaskDue: Equatable, Hashable, Sendable, Decodable {
    case date(String)
    case instant(at: Date, zone: String)

    private enum CodingKeys: String, CodingKey {
        case kind, date, at, zone
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(String.self, forKey: .kind) == "date" {
            self = .date(try container.decode(String.self, forKey: .date))
        } else {
            self = .instant(at: try container.decode(Date.self, forKey: .at), zone: try container.decode(String.self, forKey: .zone))
        }
    }

    var json: [String: Any] {
        switch self {
        case .date(let date):
            ["kind": "date", "date": date]
        case .instant(let at, let zone):
            ["kind": "instant", "at": AgendaClient.epochMilliseconds(at), "zone": zone]
        }
    }
}

public enum TaskStatus: String, Decodable, Sendable {
    case open, completed

    public var toggled: TaskStatus { self == .open ? .completed : .open }
}

public struct TaskItem: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let spaceID: String
    public let parentTaskID: String?
    public var title: String
    public var body: String?
    public var status: TaskStatus
    public var assigneeUserID: String?
    public var due: TaskDue?
    public let orderKey: String
    public var revision: Int
    public let createdBy: String
    public var completedAt: Date?
    public var completedBy: String?
    public var trashedAt: Date?
    public let createdAt: Date
    public var updatedAt: Date

    public init(id: String, spaceID: String, parentTaskID: String? = nil, title: String, body: String? = nil, status: TaskStatus = .open, assigneeUserID: String? = nil, due: TaskDue? = nil, orderKey: String, revision: Int = 1, createdBy: String, completedAt: Date? = nil, completedBy: String? = nil, trashedAt: Date? = nil, createdAt: Date, updatedAt: Date) {
        self.id = id
        self.spaceID = spaceID
        self.parentTaskID = parentTaskID
        self.title = title
        self.body = body
        self.status = status
        self.assigneeUserID = assigneeUserID
        self.due = due
        self.orderKey = orderKey
        self.revision = revision
        self.createdBy = createdBy
        self.completedAt = completedAt
        self.completedBy = completedBy
        self.trashedAt = trashedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, title, body, status, due, revision
        case spaceID = "space_id"
        case parentTaskID = "parent_task_id"
        case assigneeUserID = "assignee_user_id"
        case orderKey = "order_key"
        case createdBy = "created_by"
        case completedAt = "completed_at"
        case completedBy = "completed_by"
        case trashedAt = "trashed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

// What an edit may change. For the double optionals, nil leaves the field alone and .some(nil) clears it.
public struct TaskChanges: Equatable, Sendable {
    public var status: TaskStatus?
    public var title: String?
    public var body: String??
    public var due: TaskDue??
    public var assigneeUserID: String??
    // Moves the task to another space.
    public var spaceID: String?

    public init(status: TaskStatus? = nil, title: String? = nil, body: String?? = nil, due: TaskDue?? = nil, assigneeUserID: String?? = nil, spaceID: String? = nil) {
        self.status = status
        self.title = title
        self.body = body
        self.due = due
        self.assigneeUserID = assigneeUserID
        self.spaceID = spaceID
    }

    public var isEmpty: Bool { status == nil && title == nil && body == nil && due == nil && assigneeUserID == nil && spaceID == nil }

    func json(revision: Int) -> [String: Any] {
        var json: [String: Any] = ["revision": revision]
        if let status { json["status"] = status.rawValue }
        if let title { json["title"] = title }
        if let body { json["body"] = body ?? NSNull() }
        if let due { json["due"] = due?.json ?? NSNull() }
        if let assigneeUserID { json["assignee_user_id"] = assigneeUserID ?? NSNull() }
        if let spaceID { json["space_id"] = spaceID }
        return json
    }
}

public enum TaskItemMove: Equatable, Sendable {
    case after(String)
    case before(String)
}

public struct TaskSubscriber: Decodable, Equatable, Sendable {
    public let taskID: String
    public let userID: String

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case userID = "user_id"
    }
}

// Tasks, their checklist items (which are child tasks) and who follows them.
public struct TasksClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = .shared, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // Top-level tasks in the server's order; checklist items come from items(taskID:).
    public func tasks(spaceID: String) async throws -> [TaskItem] {
        let response: TasksResponse = try await http.decoded("GET", ["spaces", spaceID, "tasks"])
        return response.tasks.filter { $0.parentTaskID == nil }
    }

    // Newest deletion first. The server's trashed list also carries live tasks, so those are dropped.
    public func trashedTasks(spaceID: String) async throws -> [TaskItem] {
        let response: TasksResponse = try await http.decoded("GET", ["spaces", spaceID, "tasks"], query: [URLQueryItem(name: "trashed", value: "true")])
        return response.tasks
            .filter { $0.trashedAt != nil && $0.parentTaskID == nil }
            .sorted { ($0.trashedAt ?? .distantPast) > ($1.trashedAt ?? .distantPast) }
    }

    public func create(spaceID: String, title: String, body: String? = nil, due: TaskDue? = nil, assigneeUserID: String? = nil) async throws -> TaskItem {
        var json = Self.newTask(title: title, body: body, due: due)
        if let assigneeUserID { json["assignee_user_id"] = assigneeUserID }
        return try await http.decoded("POST", ["spaces", spaceID, "tasks"], body: json)
    }

    public func task(id: String) async throws -> TaskItem {
        try await http.decoded("GET", ["tasks", id])
    }

    public func update(id: String, revision: Int, changes: TaskChanges) async throws -> TaskItem {
        try await http.decoded("PATCH", ["tasks", id], body: changes.json(revision: revision))
    }

    public func setStatus(id: String, revision: Int, status: TaskStatus) async throws -> TaskItem {
        try await update(id: id, revision: revision, changes: TaskChanges(status: status))
    }

    // Moves it to the trash; restore brings it back.
    public func delete(id: String) async throws {
        try await http.empty("DELETE", ["tasks", id])
    }

    public func restore(id: String) async throws -> TaskItem {
        try await http.decoded("POST", ["tasks", id, "restore"])
    }

    public func items(taskID: String) async throws -> [TaskItem] {
        let response: ItemsResponse = try await http.decoded("GET", ["tasks", taskID, "items"])
        return response.items
    }

    public func addItem(taskID: String, title: String) async throws -> TaskItem {
        try await http.decoded("POST", ["tasks", taskID, "items"], body: Self.newTask(title: title, body: nil, due: nil))
    }

    public func moveItem(taskID: String, itemID: String, revision: Int, move: TaskItemMove) async throws -> TaskItem {
        var body: [String: Any] = ["revision": revision]
        switch move {
        case .after(let id): body["after_item_id"] = id
        case .before(let id): body["before_item_id"] = id
        }
        return try await http.decoded("PATCH", ["tasks", taskID, "items", itemID], body: body)
    }

    public func subscribers(taskID: String) async throws -> [TaskSubscriber] {
        let response: SubscribersResponse = try await http.decoded("GET", ["tasks", taskID, "subscribers"])
        return response.subscribers
    }

    public func addSubscriber(taskID: String, userID: String) async throws {
        let _: TaskSubscriber = try await http.decoded("POST", ["tasks", taskID, "subscribers"], body: ["user_id": userID])
    }

    public func removeSubscriber(taskID: String, userID: String) async throws {
        try await http.empty("DELETE", ["tasks", taskID, "subscribers", userID])
    }

    private static func newTask(title: String, body: String?, due: TaskDue?) -> [String: Any] {
        var json: [String: Any] = ["title": title]
        if let body { json["body"] = body }
        if let due { json["due"] = due.json }
        return json
    }
}

private struct TasksResponse: Decodable {
    let tasks: [TaskItem]
}

private struct ItemsResponse: Decodable {
    let items: [TaskItem]
}

private struct SubscribersResponse: Decodable {
    let subscribers: [TaskSubscriber]
}
