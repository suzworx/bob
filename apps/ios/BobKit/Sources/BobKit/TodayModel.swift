import Foundation

public enum TodayGreeting {
    public static func text(name: String?, hour: Int) -> String {
        let opening = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "\(opening)." : "\(opening), \(trimmed)."
    }
}

public enum TodayDateText {
    // Such as "Sunday, October 18".
    public static func dayLine(for date: Date, calendar: Calendar, locale: Locale) -> String {
        format(date, template: "EEEEMMMMd", calendar: calendar, locale: locale)
    }

    static func format(_ date: Date, template: String, calendar: Calendar, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate(template)
        // Newer ICU puts a narrow no-break space before AM/PM; a plain space reads the same and wraps the same.
        return formatter.string(from: date).replacingOccurrences(of: "\u{202F}", with: " ")
    }

    static func time(_ date: Date, calendar: Calendar, locale: Locale) -> String {
        format(date, template: "jmm", calendar: calendar, locale: locale)
    }
}

public struct TodayRow: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let subline: String?
    public let timeText: String
    public let isAllDay: Bool
    public var startAt: Date? = nil
    public var target: CalendarEventTarget? = nil

    public static func make(from item: AgendaItem, calendar: Calendar, locale: Locale) -> TodayRow {
        let timeText: String
        if item.isAllDay {
            timeText = "All day"
        } else {
            timeText = item.startAt.map { TodayDateText.time($0, calendar: calendar, locale: locale) } ?? ""
        }
        return TodayRow(id: rowID(item), title: item.title, subline: subline(for: item), timeText: timeText, isAllDay: item.isAllDay, startAt: item.startAt, target: CalendarEventTarget(item: item))
    }

    static func rowID(_ item: AgendaItem) -> String {
        item.originalOccurrenceStart == nil ? item.eventID : item.rowID
    }

    static let maxSublineLength = 60

    // The location, else the first non-empty line of the body, cut to 60 characters.
    static func subline(for item: AgendaItem) -> String? {
        if let location = item.location?.trimmingCharacters(in: .whitespacesAndNewlines), !location.isEmpty {
            return location
        }
        let line = item.body?
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }
        guard let line else { return nil }
        guard line.count > maxSublineLength else { return line }
        return String(line.prefix(maxSublineLength)).trimmingCharacters(in: .whitespaces)
    }
}

public struct WeekRow: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let subline: String?
    // Such as "Wed 2:00 PM", or "Wed" for an all-day item.
    public let whenText: String
    public var target: CalendarEventTarget? = nil
}

public struct TodayPlan: Equatable, Sendable {
    public let today: [TodayRow]
    public let thisWeek: [WeekRow]

    public init(today: [TodayRow], thisWeek: [WeekRow]) {
        self.today = today
        self.thisWeek = thisWeek
    }

    public static func make(items: [AgendaItem], now: Date, calendar: Calendar, locale: Locale) -> TodayPlan {
        let startOfToday = calendar.startOfDay(for: now)
        guard let startOfTomorrow = calendar.date(byAdding: .day, value: 1, to: startOfToday),
              let weekEnd = calendar.date(byAdding: .day, value: 7, to: startOfToday) else {
            return TodayPlan(today: [], thisWeek: [])
        }
        let dated = items.compactMap { item -> (AgendaItem, Date)? in
            let start = item.startAt ?? item.startDate.flatMap { WallClock.instant(day: $0, zone: calendar.timeZone.identifier) }
            return start.map { (item, $0) }
        }
            .sorted { lhs, rhs in
                let lhsDay = calendar.startOfDay(for: lhs.1), rhsDay = calendar.startOfDay(for: rhs.1)
                if lhsDay != rhsDay { return lhsDay < rhsDay }
                if lhs.0.isAllDay != rhs.0.isAllDay { return lhs.0.isAllDay }
                if lhs.1 != rhs.1 { return lhs.1 < rhs.1 }
                return lhs.0.title < rhs.0.title
            }
        let today = dated.filter { $0.1 >= startOfToday && $0.1 < startOfTomorrow }
            .map { TodayRow.make(from: $0.0, calendar: calendar, locale: locale) }
        let week = dated.filter { $0.1 >= startOfTomorrow && $0.1 < weekEnd }.map { item, start in
            let day = TodayDateText.format(start, template: "EEE", calendar: calendar, locale: locale)
            let when = item.isAllDay ? day : "\(day) \(TodayDateText.time(start, calendar: calendar, locale: locale))"
            return WeekRow(id: TodayRow.rowID(item), title: item.title, subline: TodayRow.subline(for: item), whenText: when, target: CalendarEventTarget(item: item))
        }
        return TodayPlan(today: today, thisWeek: week)
    }

    // The one sentence at the top of Today.
    public func headline(now: Date) -> String {
        if today.isEmpty { return "Nothing planned today." }
        guard let next = today.first(where: { !$0.isAllDay && ($0.startAt ?? .distantPast) >= now }) else {
            return "That's everything for today."
        }
        return "\(next.title) is next, at \(next.timeText)."
    }

    public var eventCountText: String {
        switch today.count {
        case 0: return "No events"
        case 1: return "1 event"
        default: return "\(today.count) events"
        }
    }
}

public enum GetStartedStep: String, CaseIterable, Identifiable, Sendable {
    case connectCalendar
    case inviteFamily
    case tellBobInterests

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .connectCalendar: return "Connect your calendar"
        case .inviteFamily: return "Invite your family"
        case .tellBobInterests: return "Tell Bob what you like"
        }
    }

    public var systemImage: String {
        switch self {
        case .connectCalendar: return "calendar.badge.plus"
        case .inviteFamily: return "person.2"
        case .tellBobInterests: return "heart"
        }
    }

    public static var countText: String { "\(allCases.count) steps" }
}

public struct TodayContent: Equatable, Sendable {
    public let plan: TodayPlan
    public let greetingName: String?
    public let loadedAt: Date

    public init(plan: TodayPlan, greetingName: String?, loadedAt: Date) {
        self.plan = plan
        self.greetingName = greetingName
        self.loadedAt = loadedAt
    }
}

public enum TodayState: Equatable, Sendable {
    case loading
    case loaded(TodayContent)
    // A refresh failed, but an earlier result is still on screen.
    case stale(TodayContent)
    // A refresh failed with nothing to show.
    case failed(ApiError)

    public var content: TodayContent? {
        switch self {
        case .loaded(let content), .stale(let content): return content
        case .loading, .failed: return nil
        }
    }

    public var showsOfflineNote: Bool {
        if case .stale = self { return true }
        return false
    }

    public func afterRefresh(_ result: Result<TodayContent, ApiError>) -> TodayState {
        switch result {
        case .success(let content):
            return .loaded(content)
        case .failure(let error):
            if let content { return .stale(content) }
            return .failed(error)
        }
    }
}
