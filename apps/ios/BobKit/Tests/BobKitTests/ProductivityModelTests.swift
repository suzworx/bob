import XCTest
@testable import BobKit

private func task(_ id: String, status: TaskStatus = .open, assignee: String? = nil, due: TaskDue? = nil, created: TimeInterval = 0, body: String? = nil) -> TaskItem {
    TaskItem(id: id, spaceID: "s", title: id, body: body, status: status, assigneeUserID: assignee, due: due, orderKey: id, createdBy: "u", createdAt: Date(timeIntervalSince1970: created), updatedAt: Date(timeIntervalSince1970: created))
}

private func note(_ id: String, pinned: Bool = false, updated: TimeInterval = 0, trashed: TimeInterval? = nil, body: String = "") -> Note {
    Note(id: id, spaceID: "s", title: id, body: body, pinned: pinned, createdBy: "u", updatedBy: "u", trashedAt: trashed.map(Date.init(timeIntervalSince1970:)), createdAt: .distantPast, updatedAt: Date(timeIntervalSince1970: updated))
}

private var utc: Calendar {
    WallClock.calendar(zone: "UTC")
}

// 2026-10-30 12:00 UTC.
private let noon = WallClock.instant(day: "2026-10-30", time: "12:00", zone: "UTC")!

final class WallClockTests: XCTestCase {
    func testAWallTimeKeepsItsZone() throws {
        let at = try XCTUnwrap(WallClock.instant(day: "2026-07-01", time: "08:00", zone: "Europe/London"))
        XCTAssertEqual(WallClock.time(at, zone: "UTC"), "07:00")
        XCTAssertEqual(WallClock.time(at, zone: "Europe/London"), "08:00")
        XCTAssertEqual(WallClock.day(at, zone: "Asia/Tokyo"), "2026-07-01")
    }

    func testMalformedDaysGiveNil() {
        XCTAssertNil(WallClock.instant(day: "2026-02-30", zone: "UTC"))
        XCTAssertNil(WallClock.instant(day: "soon", zone: "UTC"))
    }
}

final class TaskRulesTests: XCTestCase {
    func testViews() {
        let tasks = [task("a"), task("b", assignee: "me"), task("c", status: .completed, assignee: "me")]
        XCTAssertEqual(TaskRules.filter(tasks, view: .open, me: "me").map(\.id), ["a", "b"])
        XCTAssertEqual(TaskRules.filter(tasks, view: .mine, me: "me").map(\.id), ["b"])
        XCTAssertEqual(TaskRules.filter(tasks, view: .mine, me: nil).map(\.id), [])
        XCTAssertEqual(TaskRules.filter(tasks, view: .done, me: "me").map(\.id), ["c"])
    }

    func testDueSortPutsUndatedLastAndKeepsTies() {
        let tasks = [task("none"), task("later", due: .date("2026-12-01")), task("soon1", due: .date("2026-11-01")), task("soon2", due: .date("2026-11-01"))]
        XCTAssertEqual(TaskRules.sort(tasks, by: .due, calendar: utc).map(\.id), ["soon1", "soon2", "later", "none"])
    }

    func testNewestSort() {
        XCTAssertEqual(TaskRules.sort([task("old", created: 1), task("new", created: 2)], by: .newest).map(\.id), ["new", "old"])
    }

    func testOverdueFollowsTheWebRule() {
        XCTAssertTrue(TaskRules.isOverdue(task("a", due: .date("2026-10-29")), now: noon, calendar: utc))
        XCTAssertFalse(TaskRules.isOverdue(task("a", due: .date("2026-10-30")), now: noon, calendar: utc))
        XCTAssertTrue(TaskRules.isOverdue(task("a", due: .instant(at: noon.addingTimeInterval(-1), zone: "UTC")), now: noon, calendar: utc))
        XCTAssertFalse(TaskRules.isOverdue(task("a", status: .completed, due: .date("2020-01-01")), now: noon, calendar: utc))
    }

    func testGroups() {
        let tasks = [task("today", due: .date("2026-10-30")), task("late", due: .date("2026-10-01")), task("next", due: .date("2026-11-30")), task("none")]
        let groups = TaskRules.groups(tasks, now: noon, calendar: utc)
        XCTAssertEqual(groups.map(\.title), ["Today, 2 left", "Later"])
        XCTAssertEqual(groups[0].rows.map(\.id), ["today", "late"])
        XCTAssertEqual(groups[1].rows.map(\.id), ["next", "none"])
        XCTAssertEqual(TaskRules.groups([task("none")], now: noon, calendar: utc).map(\.title), [nil])
        XCTAssertTrue(TaskRules.groups([], now: noon, calendar: utc).isEmpty)
    }
}

final class TaskDraftTests: XCTestCase {
    func testNoEditsAreNoChanges() {
        let base = task("t", due: .instant(at: noon, zone: "Asia/Tokyo"), body: "x")
        XCTAssertTrue(TaskDraft(task: base).changes(from: base, defaultZone: "UTC").isEmpty)
    }

    func testClearingWritesNull() {
        let base = task("t", due: .date("2026-11-01"), body: "x")
        var draft = TaskDraft(task: base)
        draft.notes = "  "
        draft.dueDay = nil
        let changes = draft.changes(from: base, defaultZone: "UTC")
        XCTAssertEqual(changes.body, .some(nil))
        XCTAssertEqual(changes.due, .some(nil))
        XCTAssertNil(changes.title)
    }

    func testChangingATimedDueKeepsItsZone() throws {
        let base = task("t", due: .instant(at: noon, zone: "Asia/Tokyo"))
        var draft = TaskDraft(task: base)
        draft.dueTime = "09:00"
        let expected = try XCTUnwrap(WallClock.instant(day: try XCTUnwrap(draft.dueDay), time: "09:00", zone: "Asia/Tokyo"))
        XCTAssertEqual(draft.changes(from: base, defaultZone: "UTC").due, .some(.instant(at: expected, zone: "Asia/Tokyo")))
    }

    func testClearingTheTimeMakesItAllDay() {
        let base = task("t", due: .instant(at: noon, zone: "UTC"))
        var draft = TaskDraft(task: base)
        draft.dueTime = nil
        XCTAssertEqual(draft.changes(from: base, defaultZone: "UTC").due, .some(.date("2026-10-30")))
    }

    func testValidity() {
        XCTAssertFalse(TaskDraft(title: "  ").isValid)
        XCTAssertFalse(TaskDraft(title: String(repeating: "a", count: 201)).isValid)
        XCTAssertTrue(TaskDraft(title: " a ").isValid)
    }
}

final class NoteRulesTests: XCTestCase {
    func testPinnedFirstThenRecentWithoutTrash() {
        let notes = [note("old", updated: 1), note("new", updated: 2), note("pin", pinned: true), note("gone", updated: 9, trashed: 5)]
        let groups = NoteRules.groups(notes)
        XCTAssertEqual(groups.map(\.title), ["Pinned", "Recent"])
        XCTAssertEqual(groups[1].rows.map(\.id), ["new", "old"])
        XCTAssertEqual(NoteRules.trashed(notes).map(\.id), ["gone"])
        XCTAssertEqual(NoteRules.groups([note("a")]).map(\.title), [nil])
    }

    func testPreviewIsOneShortLine() {
        XCTAssertEqual(NoteRules.preview(note("a", body: " one\n\ntwo  three ")), "one two three")
        XCTAssertNil(NoteRules.preview(note("a", body: " \n")))
        XCTAssertEqual(NoteRules.preview(note("a", body: String(repeating: "x", count: 90)))?.count, 81)
    }
}

final class ReminderRulesTests: XCTestCase {
    private func reminder(_ id: String, at: Date?, rule: ReminderRule? = nil, status: Reminder.Status = .active) -> Reminder {
        Reminder(id: id, spaceID: "s", title: id, dueAt: at, dueZone: "UTC", rule: rule, status: status)
    }

    func testGroupsByWhenTheyRing() {
        let day: TimeInterval = 86400
        let reminders = [
            reminder("week", at: noon.addingTimeInterval(day * 2)),
            reminder("today", at: noon.addingTimeInterval(3600)),
            reminder("later", at: noon.addingTimeInterval(day * 30)),
            reminder("past", at: noon.addingTimeInterval(-60)),
            reminder("daily", at: noon.addingTimeInterval(-day), rule: ReminderRule(freq: .daily)),
            reminder("paused", at: noon, status: .paused),
            reminder("gone", at: noon, status: .cancelled)
        ]
        let groups = ReminderRules.groups(reminders, now: noon, calendar: utc)
        XCTAssertEqual(groups.map(\.title), ["Today", "This week", "Later", "Repeating", "Paused", "Earlier"])
        XCTAssertEqual(groups.flatMap(\.rows).map(\.id), ["today", "week", "later", "daily", "paused", "past"])
    }

    func testRepeatChoicesRoundTrip() {
        for choice in ReminderRepeat.allCases {
            XCTAssertEqual(ReminderRepeat(rule: choice.rule(everyHours: 2, from: "08:00", until: "22:00")), choice)
        }
        XCTAssertEqual(ReminderRepeat.hourly.rule(everyHours: 2, from: "08:00", until: "22:00"), ReminderRule(freq: .hourly, interval: 2, window: .init(start: "08:00", end: "22:00")))
    }

    func testDescribe() {
        let en = Locale(identifier: "en_US")
        XCTAssertEqual(ReminderRules.describe(ReminderRule(freq: .daily), locale: en), "Every day")
        XCTAssertEqual(ReminderRules.describe(ReminderRule(freq: .weekly, interval: 2), locale: en), "Every 2 weeks")
        XCTAssertEqual(ReminderRules.describe(ReminderRule(freq: .weekly, byWeekday: [1, 2, 3, 4, 5]), locale: en), "Every weekday")
        XCTAssertEqual(ReminderRules.describe(ReminderRule(freq: .weekly, byWeekday: [0, 6]), locale: en), "Every week on Sun, Sat")
        XCTAssertEqual(ReminderRules.describe(ReminderRule(freq: .hourly, interval: 3, window: .init(start: "08:00", end: "22:00")), locale: en), "Every 3 hours, 08:00 to 22:00")
    }

    func testSnoozeChoicesCountFromNowAndTomorrowIsNineInTheZone() throws {
        let choices = SnoozeChoice.choices(now: noon, zone: "Asia/Tokyo")
        XCTAssertEqual(choices.map(\.label), ["10 minutes", "1 hour", "Tomorrow 9:00 AM"])
        XCTAssertEqual(choices[0].until, noon.addingTimeInterval(600))
        // Noon UTC is 21:00 in Tokyo, so tomorrow there is the 31st.
        XCTAssertEqual(choices[2].until, try XCTUnwrap(WallClock.instant(day: "2026-10-31", time: "09:00", zone: "Asia/Tokyo")))
    }
}

final class ProductivityTextTests: XCTestCase {
    func testADateOnlyDueNeverShiftsDay() {
        XCTAssertEqual(ProductivityText.due(.date("2026-11-02"), locale: Locale(identifier: "en_US")), "Mon, Nov 2")
    }

    func testATimedDueReadsInItsOwnZone() {
        let at = WallClock.instant(day: "2026-11-02", time: "08:00", zone: "Asia/Tokyo")!
        XCTAssertTrue(ProductivityText.due(.instant(at: at, zone: "Asia/Tokyo"), locale: Locale(identifier: "en_US")).contains("8:00"))
    }
}
