import Foundation

// The Ask Bob proposal card exactly as the server sends it. Step params never reach the app.
// Unknown actions and statuses decode to `.unknown` so a newer server cannot break an older app.
public enum ProposalAction: Equatable, Sendable, Decodable {
    case sendEmail, sendMessage, purchase, deleteItem, shareItem, forget, notifyPeople
    case createReminder, createTask, createNote, createEvent, moveEvent, completeTask
    case unknown(String)

    private static let known: [ProposalAction] = [
        .sendEmail, .sendMessage, .purchase, .deleteItem, .shareItem, .forget, .notifyPeople,
        .createReminder, .createTask, .createNote, .createEvent, .moveEvent, .completeTask
    ]

    public init(rawValue: String) {
        self = Self.known.first { $0.rawValue == rawValue } ?? .unknown(rawValue)
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public var rawValue: String {
        switch self {
        case .sendEmail: return "send_email"
        case .sendMessage: return "send_message"
        case .purchase: return "purchase"
        case .deleteItem: return "delete_item"
        case .shareItem: return "share_item"
        case .forget: return "forget"
        case .notifyPeople: return "notify_people"
        case .createReminder: return "create_reminder"
        case .createTask: return "create_task"
        case .createNote: return "create_note"
        case .createEvent: return "create_event"
        case .moveEvent: return "move_event"
        case .completeTask: return "complete_task"
        case .unknown(let value): return value
        }
    }

    public var needsExplicitApproval: Bool {
        switch self {
        case .sendEmail, .sendMessage, .purchase, .deleteItem, .shareItem, .forget, .notifyPeople, .unknown:
            return true
        case .createReminder, .createTask, .createNote, .createEvent, .moveEvent, .completeTask:
            return false
        }
    }
}

public enum ProposalStatus: Equatable, Sendable, Decodable {
    case pending, approved, declined, failed
    case unknown(String)

    public init(from decoder: any Decoder) throws {
        switch try decoder.singleValueContainer().decode(String.self) {
        case "pending": self = .pending
        case "approved": self = .approved
        case "declined": self = .declined
        case "failed": self = .failed
        case let other: self = .unknown(other)
        }
    }
}

public struct ProposalStep: Equatable, Sendable, Decodable {
    public let action: ProposalAction
    public let title: String
    public let subline: String?
}

public struct ProposalChange: Equatable, Sendable, Decodable {
    public let label: String
    public let before: String?
    public let after: String
}

public struct ProposalPerson: Equatable, Sendable, Decodable {
    public let name: String
    public let detail: String?
}

public struct ProposalReminder: Equatable, Sendable, Decodable {
    public let label: String
    public let offsetMinutes: Int

    private enum CodingKeys: String, CodingKey {
        case label
        case offsetMinutes = "offset_minutes"
    }
}

public struct ApprovalProposal: Equatable, Sendable, Decodable {
    public let id: String
    public let status: ProposalStatus
    public let title: String
    public let steps: [ProposalStep]
    public let changes: [ProposalChange]
    public let notify: [ProposalPerson]
    public let reminder: ProposalReminder?
    public let createdAt: Date
    public let decidedAt: Date?

    public var isPending: Bool { status == .pending }
    public var canDecide: Bool { isPending }

    private enum CodingKeys: String, CodingKey {
        case id, status, title, steps, changes, notify, reminder
        case createdAt = "created_at"
        case decidedAt = "decided_at"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        status = try container.decode(ProposalStatus.self, forKey: .status)
        title = try container.decode(String.self, forKey: .title)
        steps = try container.decode([ProposalStep].self, forKey: .steps)
        changes = try container.decode([ProposalChange].self, forKey: .changes)
        notify = try container.decode([ProposalPerson].self, forKey: .notify)
        reminder = try container.decodeIfPresent(ProposalReminder.self, forKey: .reminder)
        createdAt = Self.date(fromMilliseconds: try container.decode(Int64.self, forKey: .createdAt))
        decidedAt = try container.decodeIfPresent(Int64.self, forKey: .decidedAt).map(Self.date(fromMilliseconds:))
    }

    public static func decode(_ data: Data) throws -> ApprovalProposal {
        try JSONDecoder().decode(ApprovalProposal.self, from: data)
    }

    private static func date(fromMilliseconds ms: Int64) -> Date {
        Date(timeIntervalSince1970: Double(ms) / 1000)
    }
}
