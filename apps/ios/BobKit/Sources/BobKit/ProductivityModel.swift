import Foundation

// A wall clock in a named zone, so a reminder or task keeps its own zone wherever the phone is.
public enum WallClock {
    public static func calendar(zone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = TimeZone(identifier: zone) ?? .current
        return calendar
    }

    // "yyyy-MM-dd" for the day this instant falls on in the zone.
    public static func day(_ date: Date, zone: String) -> String {
        let parts = calendar(zone: zone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    // "HH:mm" for this instant in the zone.
    public static func time(_ date: Date, zone: String) -> String {
        let parts = calendar(zone: zone).dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    // The instant a day and "HH:mm" name in the zone; nil for anything malformed.
    public static func instant(day: String, time: String = "00:00", zone: String) -> Date? {
        let date = day.split(separator: "-").compactMap { Int($0) }
        let clock = time.split(separator: ":").compactMap { Int($0) }
        guard date.count == 3, clock.count == 2 else { return nil }
        let components = DateComponents(year: date[0], month: date[1], day: date[2], hour: clock[0], minute: clock[1])
        let calendar = calendar(zone: zone)
        guard components.isValidDate(in: calendar) else { return nil }
        return calendar.date(from: components)
    }
}

public enum TaskView: String, CaseIterable, Identifiable, Sendable {
    case open, mine, done

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .open: "Open"
        case .mine: "Mine"
        case .done: "Done"
        }
    }
}

public enum TaskSort: String, CaseIterable, Identifiable, Sendable {
    case list, due, newest

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .list: "List order"
        case .due: "Due date"
        case .newest: "Newest"
        }
    }
}

public struct ProductivityGroup<Row: Identifiable & Sendable>: Identifiable, Sendable {
    public let title: String?
    public let rows: [Row]

    public var id: String { title ?? "" }

    public init(title: String?, rows: [Row]) {
        self.title = title
        self.rows = rows
    }
}

public enum TaskRules {
    public static func filter(_ tasks: [TaskItem], view: TaskView, me: String?) -> [TaskItem] {
        switch view {
        case .open: tasks.filter { $0.status == .open }
        case .mine: tasks.filter { $0.status == .open && me != nil && $0.assigneeUserID == me }
        case .done: tasks.filter { $0.status == .completed }
        }
    }

    public static func sort(_ tasks: [TaskItem], by sort: TaskSort, calendar: Calendar = .current) -> [TaskItem] {
        switch sort {
        case .list:
            return tasks
        case .newest:
            return tasks.sorted { $0.createdAt > $1.createdAt }
        case .due:
            // Undated tasks go last, and ties keep list order.
            return tasks.enumerated().sorted { left, right in
                let leftDue = dueInstant(left.element.due, calendar: calendar) ?? .distantFuture
                let rightDue = dueInstant(right.element.due, calendar: calendar) ?? .distantFuture
                return leftDue == rightDue ? left.offset < right.offset : leftDue < rightDue
            }.map(\.element)
        }
    }

    // The web's one rule: a timed due is overdue once it passes; a date-only due only on a later day.
    public static func isOverdue(_ task: TaskItem, now: Date, calendar: Calendar = .current) -> Bool {
        guard task.status == .open, let due = task.due else { return false }
        switch due {
        case .date(let date):
            return date < WallClock.day(now, zone: calendar.timeZone.identifier)
        case .instant(let at, _):
            return at < now
        }
    }

    // Due today or already late goes under Today; the rest under Later. Nothing due today means one plain list.
    public static func groups(_ tasks: [TaskItem], now: Date, calendar: Calendar = .current) -> [ProductivityGroup<TaskItem>] {
        let today = tasks.filter { isDueToday($0, now: now, calendar: calendar) || isOverdue($0, now: now, calendar: calendar) }
        guard !today.isEmpty else {
            return tasks.isEmpty ? [] : [ProductivityGroup(title: nil, rows: tasks)]
        }
        let ids = Set(today.map(\.id))
        let later = tasks.filter { !ids.contains($0.id) }
        var groups = [ProductivityGroup(title: "Today, \(today.count) left", rows: today)]
        if !later.isEmpty {
            groups.append(ProductivityGroup(title: "Later", rows: later))
        }
        return groups
    }

    private static func isDueToday(_ task: TaskItem, now: Date, calendar: Calendar) -> Bool {
        let zone = calendar.timeZone.identifier
        switch task.due {
        case .date(let date): return date == WallClock.day(now, zone: zone)
        case .instant(let at, _): return WallClock.day(at, zone: zone) == WallClock.day(now, zone: zone)
        case nil: return false
        }
    }

    private static func dueInstant(_ due: TaskDue?, calendar: Calendar) -> Date? {
        switch due {
        case .date(let date): WallClock.instant(day: date, zone: calendar.timeZone.identifier)
        case .instant(let at, _): at
        case nil: nil
        }
    }
}

// What the task editor holds, and the smallest change it makes to a task.
public struct TaskDraft: Equatable, Sendable {
    public var title: String
    public var notes: String
    // "yyyy-MM-dd"; nil means no due date.
    public var dueDay: String?
    // "HH:mm"; nil means all-day.
    public var dueTime: String?

    public init(title: String = "", notes: String = "", dueDay: String? = nil, dueTime: String? = nil) {
        self.title = title
        self.notes = notes
        self.dueDay = dueDay
        self.dueTime = dueTime
    }

    // A timed due is read in its own zone.
    public init(task: TaskItem) {
        self.init(title: task.title, notes: task.body ?? "")
        switch task.due {
        case .date(let date):
            dueDay = date
        case .instant(let at, let zone):
            dueDay = WallClock.day(at, zone: zone)
            dueTime = WallClock.time(at, zone: zone)
        case nil:
            break
        }
    }

    public var isValid: Bool {
        let count = title.trimmingCharacters(in: .whitespacesAndNewlines).count
        return count > 0 && count <= 200 && notes.count <= 8000
    }

    public var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    public var noteBody: String? { notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : notes }

    // A timed due keeps its zone across an edit; a new one uses the zone given.
    public func due(baseDue: TaskDue?, defaultZone: String) -> TaskDue? {
        guard let dueDay else { return nil }
        guard let dueTime else { return .date(dueDay) }
        var zone = defaultZone
        if case .instant(_, let own) = baseDue { zone = own }
        return WallClock.instant(day: dueDay, time: dueTime, zone: zone).map { .instant(at: $0, zone: zone) }
    }

    public func changes(from base: TaskItem, defaultZone: String) -> TaskChanges {
        var changes = TaskChanges()
        if trimmedTitle != base.title { changes.title = trimmedTitle }
        if noteBody != base.body { changes.body = .some(noteBody) }
        let original = TaskDraft(task: base)
        if dueDay != original.dueDay || dueTime != original.dueTime {
            changes.due = .some(due(baseDue: base.due, defaultZone: defaultZone))
        }
        return changes
    }
}

public enum NoteRules {
    public static let titleLimit = 200
    public static let bodyLimit = 20000

    // Pinned first, then most recently edited, leaving out the trash.
    public static func live(_ notes: [Note]) -> [Note] {
        notes.filter { $0.trashedAt == nil }.sorted {
            $0.pinned != $1.pinned ? $0.pinned : $0.updatedAt > $1.updatedAt
        }
    }

    public static func trashed(_ notes: [Note]) -> [Note] {
        notes.filter { $0.trashedAt != nil }.sorted { ($0.trashedAt ?? .distantPast) > ($1.trashedAt ?? .distantPast) }
    }

    public static func groups(_ notes: [Note]) -> [ProductivityGroup<Note>] {
        let sorted = live(notes)
        let pinned = sorted.filter(\.pinned)
        let others = sorted.filter { !$0.pinned }
        if pinned.isEmpty {
            return others.isEmpty ? [] : [ProductivityGroup(title: nil, rows: others)]
        }
        var groups = [ProductivityGroup(title: "Pinned", rows: pinned)]
        if !others.isEmpty {
            groups.append(ProductivityGroup(title: "Recent", rows: others))
        }
        return groups
    }

    // One line of the body for a row, or nil when there is no text.
    public static func preview(_ note: Note, limit: Int = 80) -> String? {
        let line = note.body.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !line.isEmpty else { return nil }
        return line.count > limit ? String(line.prefix(limit)) + "…" : line
    }
}

// The choices the web's reminder dialog offers for repeating.
public enum ReminderRepeat: String, CaseIterable, Identifiable, Sendable {
    case none, hourly, daily, weekdays, weekly, monthly, yearly

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .none: "Does not repeat"
        case .hourly: "Every few hours"
        case .daily: "Every day"
        case .weekdays: "Every weekday"
        case .weekly: "Every week"
        case .monthly: "Every month"
        case .yearly: "Every year"
        }
    }

    public init(rule: ReminderRule?) {
        guard let rule else {
            self = .none
            return
        }
        switch rule.freq {
        case .hourly: self = .hourly
        case .daily: self = .daily
        case .weekly: self = rule.byWeekday == [1, 2, 3, 4, 5] ? .weekdays : .weekly
        case .monthly: self = .monthly
        case .yearly: self = .yearly
        }
    }

    public func rule(everyHours: Int, from: String, until: String) -> ReminderRule? {
        switch self {
        case .none: nil
        case .hourly: ReminderRule(freq: .hourly, interval: everyHours, window: .init(start: from, end: until))
        case .daily: ReminderRule(freq: .daily)
        case .weekdays: ReminderRule(freq: .weekly, byWeekday: [1, 2, 3, 4, 5])
        case .weekly: ReminderRule(freq: .weekly)
        case .monthly: ReminderRule(freq: .monthly)
        case .yearly: ReminderRule(freq: .yearly)
        }
    }
}

public struct SnoozeChoice: Equatable, Sendable, Identifiable {
    public let label: String
    public let until: Date

    public var id: String { label }

    // Always counted from now; Tomorrow is 9:00 AM in the reminder's zone, not 24 hours on.
    public static func choices(now: Date, zone: String) -> [SnoozeChoice] {
        var choices = [
            SnoozeChoice(label: "10 minutes", until: now.addingTimeInterval(600)),
            SnoozeChoice(label: "1 hour", until: now.addingTimeInterval(3600))
        ]
        let calendar = WallClock.calendar(zone: zone)
        if let next = calendar.date(byAdding: .day, value: 1, to: now),
           let nine = WallClock.instant(day: WallClock.day(next, zone: zone), time: "09:00", zone: zone) {
            choices.append(SnoozeChoice(label: "Tomorrow 9:00 AM", until: nine))
        }
        return choices
    }
}

public enum ReminderRules {
    // Soonest first by when they ring. Cancelled ones are gone; a repeating one has only its first ring here, so it gets its own group.
    public static func groups(_ reminders: [Reminder], now: Date, calendar: Calendar = .current) -> [ProductivityGroup<Reminder>] {
        let live = reminders.filter { $0.status != .cancelled }
            .sorted { ($0.dueAt ?? .distantFuture) < ($1.dueAt ?? .distantFuture) }
        let active = live.filter { $0.status == .active }
        let oneOffs = active.filter { $0.rule == nil }
        let endOfToday = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now
        let endOfWeek = calendar.date(byAdding: .day, value: 7, to: calendar.startOfDay(for: now)) ?? now
        func window(_ from: Date?, _ to: Date?) -> [Reminder] {
            oneOffs.filter { reminder in
                let at = reminder.dueAt ?? .distantFuture
                return (from.map { at >= $0 } ?? true) && (to.map { at < $0 } ?? true)
            }
        }
        let groups = [
            ProductivityGroup(title: "Today", rows: window(now, endOfToday)),
            ProductivityGroup(title: "This week", rows: window(endOfToday, endOfWeek)),
            ProductivityGroup(title: "Later", rows: window(endOfWeek, nil)),
            ProductivityGroup(title: "Repeating", rows: active.filter { $0.rule != nil }),
            ProductivityGroup(title: "Paused", rows: live.filter { $0.status == .paused }),
            ProductivityGroup(title: "Earlier", rows: Array(window(nil, now).reversed()))
        ]
        return groups.filter { !$0.rows.isEmpty }
    }

    // The rule in words, for a reminder's subline.
    public static func describe(_ rule: ReminderRule, locale: Locale = .current) -> String {
        let interval = rule.interval ?? 1
        func every(_ unit: String) -> String { interval > 1 ? "Every \(interval) \(unit)s" : "Every \(unit)" }
        switch rule.freq {
        case .hourly:
            let base = every("hour")
            guard let window = rule.window else { return base }
            return "\(base), \(window.start) to \(window.end)"
        case .daily:
            return every("day")
        case .weekly:
            guard let days = rule.byWeekday, !days.isEmpty else { return every("week") }
            if days == [1, 2, 3, 4, 5] { return "Every weekday" }
            var calendar = Calendar(identifier: .gregorian)
            calendar.locale = locale
            let symbols = calendar.shortWeekdaySymbols
            let names = days.filter { symbols.indices.contains($0) }.map { symbols[$0] }
            return "\(every("week")) on \(names.joined(separator: ", "))"
        case .monthly:
            return every("month")
        case .yearly:
            return every("year")
        }
    }
}

// Dates in a row's words, in the zone that row belongs to.
public enum ProductivityText {
    public static func moment(_ date: Date, zone: String? = nil, locale: Locale = .current) -> String {
        format(date, template: "EEEMMMdjmm", zone: zone, locale: locale)
    }

    public static func time(_ date: Date, zone: String? = nil, locale: Locale = .current) -> String {
        format(date, template: "jmm", zone: zone, locale: locale)
    }

    public static func day(_ date: Date, zone: String? = nil, locale: Locale = .current) -> String {
        format(date, template: "MMMd", zone: zone, locale: locale)
    }

    public static func due(_ due: TaskDue, locale: Locale = .current) -> String {
        switch due {
        case .date(let text):
            // Read and written in one zone so the named day never shifts.
            guard let date = WallClock.instant(day: text, zone: "UTC") else { return text }
            return format(date, template: "EEEMMMd", zone: "UTC", locale: locale)
        case .instant(let at, let zone):
            return moment(at, zone: zone, locale: locale)
        }
    }

    private static func format(_ date: Date, template: String, zone: String?, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone.flatMap(TimeZone.init(identifier:)) ?? .current
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }
}
