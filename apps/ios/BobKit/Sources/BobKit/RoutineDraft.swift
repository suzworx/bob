import Foundation

public struct RoutineDraft: Equatable, Sendable {
    public var name = "Email recap"
    public var googleAccountID = ""
    public var instructions = ""
    public var gmailQuery = ""
    public var summaryStyle: RoutineSummaryStyle = .concise
    public var emailResult = false
    public var weekdays = [1, 2, 3, 4, 5, 6, 7]
    public var localTime = "08:00"
    public var timeZone: String
    public var scheduledReadConsent = false
    private var originalAccountID: String?

    public init(timeZone: String = TimeZone.current.identifier) {
        self.timeZone = timeZone
        originalAccountID = nil
    }

    public init(routine: Routine) {
        name = routine.name
        googleAccountID = routine.googleAccountID
        instructions = routine.instructions
        gmailQuery = routine.gmailQuery
        summaryStyle = routine.summaryStyle
        emailResult = routine.emailResult
        weekdays = routine.weekdays
        localTime = routine.localTime
        timeZone = routine.timeZone
        originalAccountID = routine.googleAccountID
    }

    public mutating func rebase(on routine: Routine) {
        originalAccountID = routine.googleAccountID
        if needsConsent { scheduledReadConsent = false }
    }

    public var needsConsent: Bool { originalAccountID != googleAccountID }
    public var isValid: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf16.count <= 100 && instructions.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= 2000
            && gmailQuery.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= 500
            && UUID(uuidString: googleAccountID) != nil && (!needsConsent || scheduledReadConsent)
            && !weekdays.isEmpty && weekdays.count <= 7 && Set(weekdays).count == weekdays.count
            && weekdays.allSatisfy { (1...7).contains($0) }
            && localTime.range(of: #"^(?:[01]\d|2[0-3]):[0-5]\d$"#, options: .regularExpression) != nil
            && !timeZone.hasPrefix("+") && !timeZone.hasPrefix("-") && timeZone.utf16.count <= 100
            && TimeZone(identifier: timeZone) != nil
    }

    var configuration: [String: Any] {
        ["name": name.trimmingCharacters(in: .whitespacesAndNewlines),
         "instructions": instructions.trimmingCharacters(in: .whitespacesAndNewlines),
         "gmailQuery": gmailQuery.trimmingCharacters(in: .whitespacesAndNewlines),
         "summaryStyle": summaryStyle.rawValue, "emailResult": emailResult,
         "weekdays": weekdays.sorted(), "localTime": localTime, "timeZone": timeZone]
    }
}
