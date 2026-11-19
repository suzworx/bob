import BobKit
import Foundation

// Loads what the Today screen shows for one moment in time.
protocol TodayProviding: Sendable {
    func load(now: Date) async throws -> TodayContent
}

// Today and Calendar share one service, including the same editable demo events.
struct CalendarTodayProvider: TodayProviding {
    let service: CalendarService
    var calendar: Calendar = .current
    var locale: Locale = .current

    func load(now: Date) async throws -> TodayContent {
        let start = calendar.startOfDay(for: now)
        guard let end = calendar.date(byAdding: .day, value: 7, to: start) else {
            throw ApiError.invalidRequest
        }
        let items = try await service.agenda(from: start, to: end).items
        let plan = TodayPlan.make(items: items, now: now, calendar: calendar, locale: locale)
        // The server has no profile route yet, so there is no name to greet.
        return TodayContent(plan: plan, greetingName: nil, loadedAt: now)
    }
}

// A made-up day for previews and the demo build, with no network.
struct StubTodayProvider: TodayProviding {
    enum Mode: Sendable {
        case demo
        case empty
        case failing(ApiError)
    }

    var mode: Mode = .demo
    var delay: Duration = .milliseconds(400)
    var calendar: Calendar = .current
    var locale: Locale = .current

    func load(now: Date) async throws -> TodayContent {
        if delay > .zero {
            try await Task.sleep(for: delay)
        }
        switch mode {
        case .demo:
            return Self.content(now: now, calendar: calendar, locale: locale)
        case .empty:
            return TodayContent(plan: TodayPlan(today: [], thisWeek: []), greetingName: "Alex", loadedAt: now)
        case .failing(let error):
            throw error
        }
    }

    static func content(now: Date, calendar: Calendar = .current, locale: Locale = .current) -> TodayContent {
        let items = sampleItems(now: now, calendar: calendar)
        return TodayContent(plan: TodayPlan.make(items: items, now: now, calendar: calendar, locale: locale), greetingName: "Alex", loadedAt: now)
    }

    static func sampleItems(now: Date, calendar: Calendar) -> [AgendaItem] {
        let today = calendar.startOfDay(for: now)
        func at(_ dayOffset: Int, _ hour: Int, _ minute: Int = 0) -> Date? {
            calendar.date(byAdding: .day, value: dayOffset, to: today)
                .flatMap { calendar.date(bySettingHour: hour, minute: minute, second: 0, of: $0) }
        }
        return [
            AgendaItem(eventID: "demo-dentist", title: "Dentist visit", location: "48 Elm Street", startAt: at(0, 10, 30)),
            AgendaItem(eventID: "demo-call", title: "Call with the school", body: "Ask about the trip form\nBring the permission slip", startAt: at(0, 13)),
            AgendaItem(eventID: "demo-pickup", title: "Grocery pickup", body: "Milk, eggs, bread and apples", startAt: at(0, 17, 15)),
            AgendaItem(eventID: "demo-book", title: "Book club", location: "Library, room 2", startAt: at(0, 19, 30)),
            AgendaItem(eventID: "demo-review", title: "Design review", body: "Home screen ideas", startAt: at(3, 14)),
            AgendaItem(eventID: "demo-market", title: "Farmers market", isAllDay: true, startAt: at(5, 0))
        ]
    }
}
