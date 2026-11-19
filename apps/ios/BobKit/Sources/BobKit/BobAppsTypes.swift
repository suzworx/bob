import Foundation

public enum BobAppValue: Codable, Equatable, Sendable {
    case text(String), number(Double), boolean(Bool)
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let bool = try? value.decode(Bool.self) { self = .boolean(bool) }
        else if let number = try? value.decode(Double.self), number.isFinite, abs(number) <= 1e12 { self = .number(number) }
        else if let text = try? value.decode(String.self), text.utf16.count <= 2000 { self = .text(text) }
        else { throw DecodingError.dataCorruptedError(in: value, debugDescription: "Invalid app value") }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self { case .text(let text): try value.encode(text); case .number(let number): try value.encode(number); case .boolean(let bool): try value.encode(bool) }
    }
    public var display: String {
        switch self { case .text(let text): text; case .number(let number): number.formatted(); case .boolean(let bool): bool ? "Yes" : "No" }
    }
}
public struct BobAppRecord: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let values: [String: BobAppValue]
    public init(id: String, values: [String: BobAppValue]) { self.id = id; self.values = values }
}
public struct BobAppDefinition: Codable, Equatable, Sendable {
    public struct Field: Codable, Equatable, Identifiable, Sendable {
        public enum Kind: String, Codable, Sendable { case text, number, boolean }
        public let id: String
        public let type: Kind
        public var label: String { BobAppDefinition.label(id) }
    }
    public struct Table: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let fields: [Field]
        public var supportsTaskRefresh: Bool { fields.count == 2 && fields.contains { $0.id == "title" && $0.type == .text } && fields.contains { $0.id == "completed" && $0.type == .boolean } }
    }
    public struct Action: Codable, Equatable, Identifiable, Sendable {
        public enum Operation: String, Codable, Sendable { case create, update, delete }
        public let id: String
        public let table: String
        public let operation: Operation
    }
    public struct Metric: Codable, Equatable, Identifiable, Sendable {
        public enum Operation: String, Codable, Sendable { case count, sum }
        public let id: String
        public let table: String
        public let operation: Operation
        public let field: String?
    }
    public struct View: Codable, Equatable, Identifiable, Sendable {
        public enum Kind: String, Codable, Sendable { case table, checklist, dashboard, slides }
        public struct Slide: Codable, Equatable, Sendable { public let title: String; public let body: String; public let metrics: [String] }
        public let id: String
        public let kind: Kind
        public let title: String
        public let table: String?
        public let fields: [String]?
        public let actions: [String]?
        public let metrics: [String]?
        public let slides: [Slide]?
    }
    public let schemaVersion: Int
    public let title: String
    public let lifecycle: String
    public let tables: [Table]
    public let actions: [Action]
    public let metrics: [Metric]
    public let views: [View]

    public var isValid: Bool {
        guard schemaVersion == 1, lifecycle == "keep", !title.isEmpty, title.utf16.count <= 120,
              (1...8).contains(tables.count), (1...12).contains(views.count), actions.count <= 32, metrics.count <= 32,
              unique(tables.map(\.id)), unique(actions.map(\.id)), unique(metrics.map(\.id)), unique(views.map(\.id)) else { return false }
        guard tables.allSatisfy({ (1...32).contains($0.fields.count) && unique($0.fields.map(\.id)) }),
              actions.allSatisfy({ action in tables.contains { $0.id == action.table } }),
              metrics.allSatisfy({ metric in tables.contains { table in table.id == metric.table && (metric.operation == .count || table.fields.contains { $0.id == metric.field && $0.type == .number }) } }) else { return false }
        return views.allSatisfy { view in
            guard !view.title.isEmpty, view.title.utf16.count <= 120 else { return false }
            switch view.kind {
            case .table, .checklist:
                guard let table = tables.first(where: { $0.id == view.table }), let fields = view.fields, let declaredActions = view.actions, !fields.isEmpty, unique(fields), unique(declaredActions) else { return false }
                return fields.allSatisfy { id in table.fields.contains { $0.id == id } } && declaredActions.allSatisfy { id in actions.contains { $0.id == id && $0.table == table.id } }
            case .dashboard: return view.metrics.map { !$0.isEmpty && validMetrics($0) } ?? false
            case .slides: return view.slides.map { (1...20).contains($0.count) && $0.allSatisfy { !$0.title.isEmpty && $0.title.utf16.count <= 120 && $0.body.utf16.count <= 2000 && validMetrics($0.metrics) } } ?? false
            }
        }
    }
    private func validMetrics(_ ids: [String]) -> Bool { ids.count <= 32 && ids.allSatisfy { id in metrics.contains { $0.id == id } } }
    private func unique(_ ids: [String]) -> Bool { Set(ids).count == ids.count && ids.allSatisfy(Self.validKey) }
    public static func validKey(_ value: String) -> Bool { value.range(of: "^[a-z][a-z0-9_]{0,39}$", options: .regularExpression) != nil && !["constructor", "prototype", "__proto__"].contains(value) }
    public static func label(_ id: String) -> String { let value = id.replacingOccurrences(of: "_", with: " "); return value.prefix(1).uppercased() + value.dropFirst() }
    public func allowedActions(in view: View) -> [Action] { actions.filter { $0.table == view.table && (view.actions ?? []).contains($0.id) } }
    public func previewMetrics(_ state: [String: [BobAppRecord]]) -> [String: Double] {
        Dictionary(uniqueKeysWithValues: metrics.map { metric in
            let records = state[metric.table] ?? []
            let value = metric.operation == .count ? Double(records.count) : records.reduce(0.0) { sum, row in
                if let field = metric.field, case .number(let value) = row.values[field] { return sum + value }; return sum
            }
            return (metric.id, value)
        })
    }
    public enum Starter: String, CaseIterable, Sendable { case checklist, budget, tasks
        public var title: String { switch self { case .checklist: "My checklist"; case .budget: "Budget dashboard"; case .tasks: "Tasks dashboard" } }
    }
    public static func starter(_ kind: Starter) -> Self {
        let budget = kind == .budget; let table = kind == .tasks ? "tasks" : "items"
        let fields = [Field(id: "title", type: .text), Field(id: budget ? "amount" : "completed", type: budget ? .number : .boolean)]
        let metrics = [Metric(id: "items", table: table, operation: .count, field: nil)] + (budget ? [Metric(id: "total", table: table, operation: .sum, field: "amount")] : [])
        return Self(schemaVersion: 1, title: kind.title, lifecycle: "keep", tables: [Table(id: table, fields: fields)], actions: [.create, .update, .delete].map { Action(id: $0.rawValue, table: table, operation: $0) }, metrics: metrics, views: [
            View(id: "records", kind: budget ? .table : .checklist, title: budget ? "Expenses" : "Checklist", table: table, fields: fields.map(\.id), actions: ["create", "update", "delete"], metrics: nil, slides: nil),
            View(id: "dashboard", kind: .dashboard, title: "Dashboard", table: nil, fields: nil, actions: nil, metrics: metrics.map(\.id), slides: nil),
            View(id: "slides", kind: .slides, title: "Presentation", table: nil, fields: nil, actions: nil, metrics: nil, slides: [.init(title: "At a glance", body: "These numbers come from your saved records.", metrics: metrics.map(\.id)), .init(title: "Next steps", body: "Ask Bob to add your story or change this presentation.", metrics: [])])])
    }
}
public enum BobAppLifecycle: String, Codable, Sendable { case draft, active, paused, archived }
public struct BobAppSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let installationId: String; public let spaceId: String?; public let canManage: Bool
    public let revision: Int; public let lifecycle: BobAppLifecycle; public let title: String; public let createdAt: Date; public let updatedAt: Date
}
public struct SavedBobApp: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let installationId: String; public let spaceId: String?; public let canManage: Bool
    public let revision: Int; public let lifecycle: BobAppLifecycle; public let createdAt: Date; public let updatedAt: Date
    public let definition: BobAppDefinition; public let state: [String: [BobAppRecord]]; public let metrics: [String: Double]
    public let pendingDefinition: BobAppDefinition?; public let canUndo: Bool
}
public struct BobAppsPage: Decodable, Sendable { public let apps: [BobAppSummary]; public let nextCursor: String? }
public struct BobAppConversation: Decodable, Sendable { public let conversationId: String; public let spaceId: String }
public enum BobAppOperation: String, Sendable { case activate, pause, resume, archive, restore, applyRevision = "apply_revision", undo, duplicate }
public struct BobAppCommand: Encodable, Sendable {
    public let operation: String; public let action: String; public let id: String; public let values: [String: BobAppValue]?
    public static func write(action: String, id: String, values: [String: BobAppValue]) -> Self { .init(operation: "write", action: action, id: id, values: values) }
    public static func delete(action: String, id: String) -> Self { .init(operation: "delete", action: action, id: id, values: nil) }
}
public struct BobAppRecordDraft: Sendable {
    public let id: String
    public var text: [String: String] = [:]
    public var flags: [String: Bool] = [:]
    public init(table: BobAppDefinition.Table, row: BobAppRecord? = nil, locale: Locale = .current) {
        id = row?.id ?? "r_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        let format = NumberFormatter(); format.locale = locale; format.usesGroupingSeparator = false; format.maximumFractionDigits = 20
        for field in table.fields {
            switch row?.values[field.id] {
            case .text(let value): text[field.id] = value
            case .number(let value): text[field.id] = format.string(from: NSNumber(value: value)) ?? ""
            case .boolean(let value): flags[field.id] = value
            case nil: break
            }
        }
    }
    public func values(table: BobAppDefinition.Table, locale: Locale = .current) throws -> [String: BobAppValue] {
        let format = NumberFormatter(); format.locale = locale; format.numberStyle = .decimal; format.isLenient = false
        var result: [String: BobAppValue] = [:]
        for field in table.fields {
            switch field.type {
            case .text:
                let value = text[field.id] ?? ""; guard value.utf16.count <= 2000 else { throw ApiError.invalidRequest }; result[field.id] = .text(value)
            case .boolean: result[field.id] = .boolean(flags[field.id] ?? false)
            case .number:
                let raw = (text[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let decimal = format.decimalSeparator ?? "."
                let normalized = raw.replacingOccurrences(of: decimal, with: ".")
                guard normalized.range(of: "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)$", options: .regularExpression) != nil,
                      let number = Double(normalized), number.isFinite, abs(number) <= 1e12 else { throw ApiError.invalidRequest }
                result[field.id] = .number(number)
            }
        }
        return result
    }
}
public struct BobAppRefreshConfig: Codable, Equatable, Sendable {
    public struct Schedule: Codable, Equatable, Sendable { public var weekdays: [Int]; public var localTime: String; public var timeZone: String }
    public let source: String
    public var spaceId: String; public var targetTable: String; public var schedule: Schedule
    enum CodingKeys: String, CodingKey { case source, spaceId, targetTable, schedule }
    public init(spaceId: String, targetTable: String, weekdays: [Int], localTime: String, timeZone: String) { self.source = "tasks"; self.spaceId = spaceId; self.targetTable = targetTable; schedule = Schedule(weekdays: weekdays, localTime: localTime, timeZone: timeZone) }
    public var isValid: Bool { source == "tasks" && !spaceId.isEmpty && BobAppDefinition.validKey(targetTable) && !schedule.weekdays.isEmpty && Set(schedule.weekdays).count == schedule.weekdays.count && schedule.weekdays.allSatisfy { (1...7).contains($0) } && schedule.localTime.range(of: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", options: .regularExpression) != nil && TimeZone(identifier: schedule.timeZone) != nil }
}
public struct BobAppRefresh: Decodable, Equatable, Sendable {
    public let enabled: Bool; public let config: BobAppRefreshConfig?; public let nextRunAt: Date?; public let lastRefreshAt: Date?; public let lastError: String?
}
public struct BobAppRun: Decodable, Identifiable, Sendable {
    public enum Status: String, Decodable, Sendable { case pending, running, completed, failed, skipped }
    public let id: String; public let status: Status; public let scheduledAt: Date; public let completedAt: Date?; public let failureCode: String?
}
