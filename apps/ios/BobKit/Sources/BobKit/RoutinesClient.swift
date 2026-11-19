import Foundation

public enum RoutineStatus: String, Codable, CaseIterable, Sendable { case active, paused, archived }
public enum RoutineSummaryStyle: String, Codable, CaseIterable, Sendable { case concise, detailed }

public struct Routine: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let googleAccountID: String
    public let name: String
    public let instructions: String
    public let gmailQuery: String
    public let summaryStyle: RoutineSummaryStyle
    public let emailResult: Bool
    public let weekdays: [Int]
    public let localTime: String
    public let timeZone: String
    public let status: RoutineStatus
    public let revision: Int
    public let nextRunAt: Date?
    public let createdAt: Date
    public let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, instructions, gmailQuery, summaryStyle, emailResult, weekdays, localTime, timeZone, status, revision, nextRunAt, createdAt, updatedAt
        case googleAccountID = "googleAccountId"
    }

    public var scheduleLabel: String {
        let labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        let days = weekdays.count == 7 ? "Every day" : weekdays.compactMap { (1...7).contains($0) ? labels[$0 - 1] : nil }.joined(separator: ", ")
        return "\(days) at \(localTime) · \(timeZone.replacingOccurrences(of: "_", with: " "))"
    }
}

public struct RoutineRun: Decodable, Identifiable, Sendable {
    public enum Status: String, Decodable, Sendable { case pending, running, completed, failed, skipped }
    public let id: String
    public let routineID: String
    public let routineName: String
    public let scheduledAt: Date
    public let startedAt: Date?
    public let completedAt: Date?
    public let status: Status
    public let failureCode: String?
    public let emailOutcome: String?
    public let coverageStart: Date?
    public let coverageEnd: Date?
    public let result: TimelineRecap.Result?

    enum CodingKeys: String, CodingKey {
        case id, routineName, scheduledAt, startedAt, completedAt, status, failureCode, emailOutcome, coverageStart, coverageEnd, result
        case routineID = "routineId"
    }

    public var explanation: String? {
        switch failureCode {
        case "consent_unavailable": "Your Google connection needs attention. Check Gmail access in Integrations."
        case "provider_unavailable": "Google wasn't available for this run."
        case "summary_unavailable": "Bob couldn't prepare this recap. The next scheduled run will try again."
        case "cancelled": "This run was cancelled."
        case "missed": "This scheduled run was missed."
        case "stale": "The routine changed before this run could finish."
        default: nil
        }
    }
}

public struct RoutinesClient: Sendable {
    private let http: JSONRequester

    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }

    public func list() async throws -> [Routine] {
        let response: RoutineList = try await http.decoded("GET", ["routines"], query: [URLQueryItem(name: "includeArchived", value: "true")])
        return response.routines
    }

    public func create(_ draft: RoutineDraft) async throws -> Routine {
        guard draft.isValid, draft.scheduledReadConsent else { throw ApiError.invalidRequest }
        var body = draft.configuration
        body["kind"] = "daily_gmail_digest"
        body["googleAccountId"] = draft.googleAccountID
        body["scheduledReadConsent"] = true
        let response: RoutineResponse = try await http.decoded("POST", ["routines"], body: body)
        return response.routine
    }

    public func update(_ routine: Routine, draft: RoutineDraft) async throws -> Routine {
        try validate(routine.id, revision: routine.revision)
        guard routine.status != .archived, draft.isValid else { throw ApiError.invalidRequest }
        var body = draft.configuration
        body["expectedRevision"] = routine.revision
        if draft.googleAccountID != routine.googleAccountID {
            guard draft.scheduledReadConsent else { throw ApiError.invalidRequest }
            body["googleAccountId"] = draft.googleAccountID
            body["scheduledReadConsent"] = true
        }
        let response: RoutineResponse = try await http.decoded("PATCH", ["routines", routine.id], body: body)
        return response.routine
    }

    public func setStatus(id: String, revision: Int, status: RoutineStatus) async throws -> Routine {
        try validate(id, revision: revision)
        guard status != .archived else { throw ApiError.invalidRequest }
        let response: RoutineResponse = try await http.decoded("PATCH", ["routines", id], body: ["expectedRevision": revision, "status": status.rawValue])
        return response.routine
    }

    public func archive(id: String, revision: Int) async throws {
        try validate(id, revision: revision)
        try await http.empty("DELETE", ["routines", id], body: ["expectedRevision": revision])
    }

    public func runs(id: String) async throws -> [RoutineRun] {
        guard UUID(uuidString: id) != nil else { throw ApiError.invalidRequest }
        let response: RoutineRuns = try await http.decoded("GET", ["routines", id, "runs"])
        return response.runs
    }

    public func run(id: String, runID: String) async throws -> RoutineRun {
        guard UUID(uuidString: id) != nil, UUID(uuidString: runID) != nil else { throw ApiError.invalidRequest }
        let response: RoutineRunResponse = try await http.decoded("GET", ["routines", id, "runs", runID])
        return response.run
    }

    private func validate(_ id: String, revision: Int) throws {
        guard UUID(uuidString: id) != nil, (1...2_147_483_646).contains(revision) else { throw ApiError.invalidRequest }
    }
}

private struct RoutineList: Decodable { let routines: [Routine] }
private struct RoutineResponse: Decodable { let routine: Routine }
private struct RoutineRuns: Decodable { let runs: [RoutineRun] }
private struct RoutineRunResponse: Decodable { let run: RoutineRun }
