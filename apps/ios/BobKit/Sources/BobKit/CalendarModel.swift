import Foundation

// Days as "yyyy-MM-dd" and months as "yyyy-MM", so a day never shifts with a time zone.
public enum CalendarDays {
    private static var utc: Calendar { WallClock.calendar(zone: "UTC") }

    public static func add(_ days: Int, to day: String) -> String {
        guard let date = WallClock.instant(day: day, zone: "UTC"),
              let next = utc.date(byAdding: .day, value: days, to: date) else { return day }
        return WallClock.day(next, zone: "UTC")
    }

    public static func month(of day: String) -> String { String(day.prefix(7)) }

    public static func addMonths(_ months: Int, to month: String) -> String {
        guard let date = WallClock.instant(day: "\(month)-01", zone: "UTC"),
              let next = utc.date(byAdding: .month, value: months, to: date) else { return month }
        return String(WallClock.day(next, zone: "UTC").prefix(7))
    }

    // The day a month opens on: today in the current month, otherwise its first.
    public static func openingDay(of month: String, today: String) -> String {
        CalendarDays.month(of: today) == month ? today : "\(month)-01"
    }

    // Whole weeks from Monday, the web's week start, covering the month.
    public static func weeks(of month: String) -> [[String]] {
        guard let first = WallClock.instant(day: "\(month)-01", zone: "UTC") else { return [] }
        let lead = (utc.component(.weekday, from: first) + 5) % 7
        var day = add(-lead, to: "\(month)-01")
        var weeks: [[String]] = []
        repeat {
            let week = (0..<7).map { add($0, to: day) }
            weeks.append(week)
            day = add(7, to: day)
        } while CalendarDays.month(of: day) <= month
        return weeks
    }

    // Monday first, in the person's language.
    public static func weekdaySymbols(locale: Locale = .current) -> [String] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        return Array(symbols[1...]) + symbols[..<1]
    }

    public static func dayNumber(_ day: String) -> String {
        String(Int(day.suffix(2)) ?? 0)
    }

    public static func monthTitle(_ month: String, locale: Locale = .current) -> String {
        format("\(month)-01", template: "LLLLyyyy", locale: locale)
    }

    public static func dayTitle(_ day: String, locale: Locale = .current) -> String {
        format(day, template: "EEEMMMd", locale: locale)
    }

    public static func fullTitle(_ day: String, locale: Locale = .current) -> String {
        format(day, template: "EEEEMMMMd", locale: locale)
    }

    // Today, Tomorrow or the date, with how many things are on it.
    public static func groupTitle(_ day: String, today: String, count: Int, locale: Locale = .current) -> String {
        let name: String
        if day == today {
            name = "Today"
        } else if day == add(1, to: today) {
            name = "Tomorrow"
        } else {
            name = dayTitle(day, locale: locale)
        }
        return "\(name), \(count)"
    }

    private static func format(_ day: String, template: String, locale: Locale) -> String {
        guard let date = WallClock.instant(day: day, zone: "UTC") else { return day }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }

    // The midnights around the month's grid, running on past it far enough to list what's coming up after any day in it.
    public static func loadWindow(month: String, comingUpDays: Int, zone: String) -> (from: Date, to: Date, days: [String])? {
        guard let first = weeks(of: month).first?.first, let last = weeks(of: month).last?.last else { return nil }
        let end = add(comingUpDays + 1, to: last)
        guard let from = WallClock.instant(day: first, zone: zone), let to = WallClock.instant(day: end, zone: zone) else { return nil }
        var days: [String] = []
        var day = first
        while day < end {
            days.append(day)
            day = add(1, to: day)
        }
        return (from, to, days)
    }
}

// One line on a calendar day.
public struct CalendarEntry: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        case event(AgendaItem)
        case google(GoogleAgendaItem)
        case task(TaskItem)
        case reminder(Reminder, at: Date)
    }

    public let id: String
    public let title: String
    public let day: String
    public let sortAt: Date
    public let spaceName: String?
    public let kind: Kind
}

public enum CalendarRules {
    // How far past the selected day the list runs: the web lists the day and the week after it.
    public static let comingUpDays = 7

    // Every day an all-day stretch covers; endDate is exclusive, and a missing or inverted one means the first day alone.
    static func allDayDays(start: String, endExclusive: String?, within days: Set<String>) -> [String] {
        let end = endExclusive.flatMap { $0 > start ? $0 : nil } ?? CalendarDays.add(1, to: start)
        var found: [String] = []
        var day = start
        // Bounded by the longest window we ever load, so a bad date can't spin.
        while day < end, found.count < 400 {
            if days.contains(day) { found.append(day) }
            day = CalendarDays.add(1, to: day)
        }
        return found
    }

    // Everything on these days, by day, each day in time order. Done, trashed and undated tasks are on no day, nor is someone else's task.
    public static func entries(page: AgendaPage?, tasks: [(SpaceSummary, [TaskItem])], reminders: [(SpaceSummary, [Reminder])], spaces: [SpaceSummary], days: [String], me: String?, now: Date, zone: String) -> [String: [CalendarEntry]] {
        let wanted = Set(days)
        let names = Dictionary(spaces.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var entries: [CalendarEntry] = []
        for item in page?.items ?? [] {
            entries += eventEntries(item, spaceName: item.spaceID.flatMap { names[$0] }, wanted: wanted, zone: zone)
        }
        for item in page?.googleItems ?? [] {
            entries += googleEntries(item, wanted: wanted, zone: zone)
        }
        for (space, list) in tasks {
            for task in list {
                if let entry = taskEntry(task, space: space, wanted: wanted, me: me, zone: zone) { entries.append(entry) }
            }
        }
        for (space, list) in reminders {
            for reminder in list {
                for day in days {
                    entries += reminderEntries(reminder, space: space, day: day, now: now, zone: zone)
                }
            }
        }
        var byDay = Dictionary(grouping: entries, by: \.day)
        for (day, list) in byDay {
            byDay[day] = list.sorted { $0.sortAt == $1.sortAt ? $0.id < $1.id : $0.sortAt < $1.sortAt }
        }
        return byDay
    }

    private static func eventEntries(_ item: AgendaItem, spaceName: String?, wanted: Set<String>, zone: String) -> [CalendarEntry] {
        func entry(_ day: String, _ sortAt: Date) -> CalendarEntry {
            CalendarEntry(id: "\(item.rowID):\(day)", title: item.title, day: day, sortAt: sortAt, spaceName: spaceName, kind: .event(item))
        }
        if item.isAllDay, let start = item.startDate {
            return allDayDays(start: start, endExclusive: item.endDate, within: wanted).map { entry($0, dayStart($0, zone: zone)) }
        }
        guard let at = item.startAt else { return [] }
        let day = WallClock.day(at, zone: zone)
        return wanted.contains(day) ? [entry(day, at)] : []
    }

    private static func googleEntries(_ item: GoogleAgendaItem, wanted: Set<String>, zone: String) -> [CalendarEntry] {
        func entry(_ day: String, _ sortAt: Date) -> CalendarEntry {
            CalendarEntry(id: "\(item.sourceKey):\(day)", title: item.title, day: day, sortAt: sortAt, spaceName: nil, kind: .google(item))
        }
        if let start = item.startDate {
            return allDayDays(start: start, endExclusive: item.endDate, within: wanted).map { entry($0, dayStart($0, zone: zone)) }
        }
        guard let at = item.startAt else { return [] }
        let day = WallClock.day(at, zone: zone)
        return wanted.contains(day) ? [entry(day, at)] : []
    }

    private static func taskEntry(_ task: TaskItem, space: SpaceSummary, wanted: Set<String>, me: String?, zone: String) -> CalendarEntry? {
        guard task.status == .open, task.trashedAt == nil, let due = task.due else { return nil }
        if let me, let assignee = task.assigneeUserID, assignee != me { return nil }
        let day: String
        let sortAt: Date
        switch due {
        case .date(let date):
            day = date
            sortAt = dayStart(date, zone: zone)
        case .instant(let at, _):
            day = WallClock.day(at, zone: zone)
            sortAt = at
        }
        guard wanted.contains(day) else { return nil }
        return CalendarEntry(id: "task:\(task.id)", title: task.title, day: day, sortAt: sortAt, spaceName: space.name, kind: .task(task))
    }

    // An hourly reminder is one row a day, at its next ring (or its last, once they have all gone by).
    private static func reminderEntries(_ reminder: Reminder, space: SpaceSummary, day: String, now: Date, zone: String) -> [CalendarEntry] {
        let instants = reminderInstants(reminder, on: day, zone: zone)
        func entry(_ at: Date, id: String) -> CalendarEntry {
            CalendarEntry(id: id, title: reminder.title, day: day, sortAt: at, spaceName: space.name, kind: .reminder(reminder, at: at))
        }
        if reminder.rule?.freq == .hourly {
            guard let at = instants.first(where: { $0 >= now }) ?? instants.last else { return [] }
            return [entry(at, id: "reminder:\(reminder.id):\(day)")]
        }
        return instants.map { entry($0, id: "reminder:\(reminder.id):\($0.timeIntervalSince1970)") }
    }

    // Every instant an active reminder rings on this day. A rule runs in the reminder's own zone, whose day can differ from the reader's.
    public static func reminderInstants(_ reminder: Reminder, on day: String, zone: String) -> [Date] {
        guard reminder.status == .active, let due = reminder.dueAt else { return [] }
        guard let rule = reminder.rule else {
            return WallClock.day(due, zone: zone) == day ? [due] : []
        }
        let ruleZone = reminder.dueZone ?? "UTC"
        let anchorDay = WallClock.day(due, zone: ruleZone)
        let anchorTime = WallClock.time(due, zone: ruleZone)
        var found = Set<Date>()
        for offset in [-1, 0, 1] {
            let date = CalendarDays.add(offset, to: day)
            if rule.freq == .hourly {
                if date < anchorDay || rule.until.map({ date > $0 }) == true { continue }
                for slot in hourlySlots(rule) {
                    if let at = WallClock.instant(day: date, time: slot, zone: ruleZone), at >= due, WallClock.day(at, zone: zone) == day {
                        found.insert(at)
                    }
                }
            } else if occurs(rule, anchor: anchorDay, on: date),
                      let at = WallClock.instant(day: date, time: anchorTime, zone: ruleZone),
                      WallClock.day(at, zone: zone) == day {
                found.insert(at)
            }
        }
        return found.sorted()
    }

    private static func hourlySlots(_ rule: ReminderRule) -> [String] {
        func minutes(_ text: String?, fallback: Int) -> Int {
            let parts = (text ?? "").split(separator: ":").compactMap { Int($0) }
            return parts.count == 2 ? parts[0] * 60 + parts[1] : fallback
        }
        let step = min(12, max(1, rule.interval ?? 1)) * 60
        let start = minutes(rule.window?.start, fallback: 0)
        let end = minutes(rule.window?.end, fallback: 24 * 60 - 1)
        return stride(from: start, through: end, by: step).map { String(format: "%02d:%02d", $0 / 60, $0 % 60) }
    }

    private static func occurs(_ rule: ReminderRule, anchor: String, on date: String) -> Bool {
        guard let anchorDate = WallClock.instant(day: anchor, zone: "UTC"),
              let target = WallClock.instant(day: date, zone: "UTC"), target >= anchorDate else { return false }
        if let until = rule.until, date > until { return false }
        let utc = WallClock.calendar(zone: "UTC")
        let interval = max(1, rule.interval ?? 1)
        let diff = utc.dateComponents([.day], from: anchorDate, to: target).day ?? 0
        let from = utc.dateComponents([.year, .month, .day, .weekday], from: anchorDate)
        let to = utc.dateComponents([.year, .month, .day, .weekday], from: target)
        switch rule.freq {
        case .hourly:
            return false
        case .daily:
            return diff % interval == 0
        case .weekly:
            let anchorWeekday = (from.weekday ?? 1) - 1
            let days = rule.byWeekday.flatMap { $0.isEmpty ? nil : $0 } ?? [anchorWeekday]
            guard days.contains((to.weekday ?? 1) - 1) else { return false }
            return (diff + anchorWeekday) / 7 % interval == 0
        case .monthly:
            let months = ((to.year ?? 0) - (from.year ?? 0)) * 12 + (to.month ?? 0) - (from.month ?? 0)
            return to.day == from.day && months % interval == 0
        case .yearly:
            return to.month == from.month && to.day == from.day && ((to.year ?? 0) - (from.year ?? 0)) % interval == 0
        }
    }

    private static func dayStart(_ day: String, zone: String) -> Date {
        WallClock.instant(day: day, zone: zone) ?? .distantFuture
    }

    // When it happens and where it lives, in the row's own words. An all-day thing never shows an invented time.
    public static func subline(_ entry: CalendarEntry, zone: String, locale: Locale = .current) -> String {
        var parts: [String]
        switch entry.kind {
        case .event(let item):
            let when = item.isAllDay ? "All day" : item.startAt.map { ProductivityText.time($0, zone: zone, locale: locale) } ?? "Event"
            parts = [when]
            if let space = entry.spaceName { parts.append(space) }
            if let response = item.myResponse { parts.append(response.label) }
        case .google(let item):
            let when = item.isAllDay ? "All day" : item.startAt.map { ProductivityText.time($0, zone: zone, locale: locale) } ?? ""
            parts = [when, "Google", "Read-only"]
        case .task(let task):
            parts = ["Task"]
            if let space = entry.spaceName { parts.append(space) }
            if case .instant(let at, _) = task.due { parts.append(ProductivityText.time(at, zone: zone, locale: locale)) }
        case .reminder(let reminder, let at):
            parts = [reminder.rule.map { ReminderRules.describe($0, locale: locale) } ?? "Reminder"]
            if let space = entry.spaceName { parts.append(space) }
            if reminder.rule?.freq != .hourly { parts.append(ProductivityText.time(at, zone: zone, locale: locale)) }
        }
        return parts.joined(separator: " · ")
    }

    // "9:00 AM to 10:00 AM" or "All day" for one occurrence.
    public static func timeText(_ item: AgendaItem, zone: String, locale: Locale = .current) -> String {
        if item.isAllDay { return "All day" }
        guard let start = item.startAt else { return "" }
        let from = ProductivityText.time(start, zone: zone, locale: locale)
        guard let end = item.endAt else { return from }
        return "\(from) to \(ProductivityText.time(end, zone: zone, locale: locale))"
    }

    // A member's name, then the person's own email only if they aren't a member, then a neutral word. Never an id.
    public static func attendeeName(_ attendee: EventAttendee, members: [SpaceMember]) -> String {
        if let member = members.first(where: { $0.userID == attendee.userID }) {
            return memberName(member)
        }
        if let email = attendee.email?.trimmingCharacters(in: .whitespaces), !email.isEmpty { return email }
        return "Someone"
    }

    public static func memberName(_ member: SpaceMember) -> String {
        if let name = member.displayName?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        if let handle = member.handle, !handle.isEmpty { return "@\(handle)" }
        return "Someone"
    }
}

// What the event editor holds, kept as wall-clock text so the picker and the list always agree.
public struct EventDraft: Equatable, Sendable {
    public static let titleLimit = 200
    public static let locationLimit = 500
    public static let notesLimit = 8000

    public var title = ""
    public var allDay = false
    // "yyyy-MM-ddTHH:mm"
    public var startLocal = ""
    public var endLocal = ""
    public var startDate = ""
    // The last day, as a person reads it; the wire's end date is the day after.
    public var endDateInclusive = ""
    public var location = ""
    public var notes = ""

    // A new event on this day: 9:00 to 10:00.
    public init(day: String) {
        startLocal = "\(day)T09:00"
        endLocal = "\(day)T10:00"
        startDate = day
        endDateInclusive = day
    }

    // A new event on this day; on today it starts at the next full hour, so it is not already over.
    public init(day: String, now: Date, zone: String) {
        self.init(day: day)
        let current = Self.local(now, zone: zone)
        guard current.hasPrefix(day), let hour = Int(current.dropFirst(11).prefix(2)), hour >= 9, hour < 23 else { return }
        startLocal = "\(day)T" + String(format: "%02d:00", hour + 1)
        endLocal = hour + 2 < 24 ? "\(day)T" + String(format: "%02d:00", hour + 2) : "\(day)T23:59"
    }

    // The occurrence as it shows, so editing one date never picks up another date's fields.
    public init(occurrence item: AgendaItem, zone: String) {
        title = item.title
        location = item.location ?? ""
        notes = item.body ?? ""
        allDay = item.isAllDay
        if item.isAllDay {
            startDate = item.startDate ?? ""
            let last = CalendarDays.add(-1, to: item.endDate ?? startDate)
            endDateInclusive = last < startDate ? startDate : last
        } else {
            startLocal = item.startAt.map { Self.local($0, zone: zone) } ?? ""
            endLocal = item.endAt.map { Self.local($0, zone: zone) } ?? ""
        }
    }

    public static func local(_ date: Date, zone: String) -> String {
        "\(WallClock.day(date, zone: zone))T\(WallClock.time(date, zone: zone))"
    }

    public static func instant(local: String, zone: String) -> Date? {
        guard local.count == 16 else { return nil }
        return WallClock.instant(day: String(local.prefix(10)), time: String(local.suffix(5)), zone: zone)
    }

    // Turning All day on or off keeps the dates already picked and never sends an empty one.
    public func settingAllDay(_ on: Bool) -> EventDraft {
        guard on != allDay else { return self }
        var next = self
        next.allDay = on
        if on {
            next.startDate = startDate.isEmpty ? String(startLocal.prefix(10)) : startDate
            let endDay = endDateInclusive.isEmpty ? String(endLocal.prefix(10)) : endDateInclusive
            next.endDateInclusive = endDay < next.startDate ? next.startDate : endDay
        } else {
            let day = startLocal.isEmpty ? startDate : String(startLocal.prefix(10))
            if startLocal.isEmpty { next.startLocal = "\(day)T09:00" }
            if endLocal.isEmpty { next.endLocal = "\(day)T10:00" }
        }
        return next
    }

    // A series keeps its times, so choosing every date puts them back.
    public func restoringTimes(from initial: EventDraft) -> EventDraft {
        var next = self
        next.allDay = initial.allDay
        next.startLocal = initial.startLocal
        next.endLocal = initial.endLocal
        next.startDate = initial.startDate
        next.endDateInclusive = initial.endDateInclusive
        return next
    }

    public func timing(zone: String) -> EventTiming? {
        if allDay {
            guard !startDate.isEmpty, endDateInclusive >= startDate else { return nil }
            return .allDay(startDate: startDate, endDate: CalendarDays.add(1, to: endDateInclusive))
        }
        guard let start = Self.instant(local: startLocal, zone: zone), let end = Self.instant(local: endLocal, zone: zone), end > start else { return nil }
        return .timed(start: start, end: end)
    }

    public var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedLocation: String? { Self.textOrNil(location) }
    private var trimmedNotes: String? { Self.textOrNil(notes) }

    private static func textOrNil(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public func isValid(zone: String) -> Bool {
        !trimmedTitle.isEmpty && timing(zone: zone) != nil
    }

    // A warning, never a block: logging something that already happened is fine.
    public func startsBeforeToday(now: Date, zone: String) -> Bool {
        let day = allDay ? startDate : String(startLocal.prefix(10))
        return !day.isEmpty && day < WallClock.day(now, zone: zone)
    }

    public func newEvent(zone: String) -> NewEvent? {
        guard isValid(zone: zone), let timing = timing(zone: zone) else { return nil }
        return NewEvent(title: trimmedTitle, location: trimmedLocation, body: trimmedNotes, zone: zone, timing: timing)
    }

    // Only what differs from the occurrence, so an untouched field is never overwritten by a stale copy of itself.
    public func patch(from initial: EventDraft, zone: String) -> EventPatch {
        var patch = EventPatch()
        if trimmedTitle != initial.trimmedTitle { patch.title = trimmedTitle }
        if trimmedLocation != initial.trimmedLocation { patch.location = .some(trimmedLocation) }
        if trimmedNotes != initial.trimmedNotes { patch.body = .some(trimmedNotes) }
        let timing = timing(zone: zone)
        if timing != initial.timing(zone: zone) { patch.timing = timing }
        return patch
    }
}

// A destination retains scope and occurrence identity; a search result has only the series ID.
public struct CalendarEventTarget: Hashable, Sendable, Identifiable {
    public let eventID: String
    public let spaceID: String?
    public let occurrenceStart: Int64?
    public let date: Date?
    public let day: String?

    public var id: String { "\(spaceID ?? ""):\(eventID):\(occurrenceStart.map(String.init) ?? "series")" }

    public init(eventID: String, spaceID: String? = nil) {
        self.eventID = eventID
        self.spaceID = spaceID
        occurrenceStart = nil
        date = nil
        day = nil
    }

    public init(item: AgendaItem) {
        eventID = item.eventID
        spaceID = item.spaceID
        occurrenceStart = item.originalOccurrenceStart
        date = item.startAt
        day = item.startDate
    }

    // Permissions come from a fresh agenda row, never from the search index or a guessed editable flag.
    public func resolve(
        zone: String,
        event: @Sendable (String) async throws -> CalendarEvent,
        agenda: @Sendable (Date, Date) async throws -> AgendaPage
    ) async throws -> AgendaItem {
        let series = try await event(eventID)
        guard series.id == eventID, series.status != .cancelled,
              spaceID == nil || series.spaceID == spaceID else { throw ApiError.notFound }
        let calendar = WallClock.calendar(zone: zone)
        let start: Date?
        if let day = day ?? (series.allDay ? series.startDate : nil) {
            start = WallClock.instant(day: day, zone: zone)
        } else {
            start = date ?? series.startAt
        }
        guard let start else { throw ApiError.notFound }
        let from = calendar.startOfDay(for: start)
        guard let to = calendar.date(byAdding: .day, value: 1, to: from) else { throw ApiError.invalidRequest }
        let page = try await agenda(from, to)
        if let item = matchingItem(in: page, spaceID: series.spaceID) { return item }
        // A cancelled first date doesn't delete a series. Search can find a later date,
        // but a tapped occurrence must never silently open a different one.
        guard occurrenceStart == nil, date == nil, day == nil, series.rule != nil,
              let horizon = calendar.date(byAdding: .year, value: 2, to: from) else { throw ApiError.notFound }
        let later = try await agenda(from, horizon)
        guard let item = matchingItem(in: later, spaceID: series.spaceID) else { throw ApiError.notFound }
        return item
    }

    private func matchingItem(in page: AgendaPage, spaceID: String) -> AgendaItem? {
        page.items.first {
            $0.eventID == eventID && $0.spaceID == spaceID && !$0.isCancelled &&
                (occurrenceStart == nil || $0.originalOccurrenceStart == occurrenceStart)
        }
    }
}
