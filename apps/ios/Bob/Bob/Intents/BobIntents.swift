import AppIntents
import BobKit
import Foundation

// Asks Bob without opening the app and waits for all of the reply. It lands in a new chat, as if asked out loud in the app.
struct AskBobIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Bob"
    static let description = IntentDescription("Ask Bob anything and get his answer back.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Bob?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Bob \(\.$question)")
    }

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let text = question
        let reply = try await IntentServices.run { services in
            guard text.contains(where: { !$0.isWhitespace }) else { throw SiriFailure.nothingGiven }
            // The spoken origin asks the server for a reply written to be heard.
            let events = services.chat.send(text: text, messageID: UUID().uuidString, conversationID: nil, turn: .new, origin: .voice, workflowID: nil)
            return try await SiriAsk.answer(question: text, events: events)
        }
        return .result(value: reply.full, dialog: "\(reply.spoken)")
    }
}

// Tasks, notes and reminders go to the person's private space, whichever space Home is looking at.
struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription("Add a task to Bob.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Title", requestValueDialog: "What's the task?")
    var name: String

    @Parameter(title: "Due date", kind: .date)
    var dueDate: Date?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$name) to Bob's tasks") {
            \.$dueDate
        }
    }

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let text = name
        let date = dueDate
        let created = try await IntentServices.run { services in
            let due = SiriDrafts.taskDue(date, zone: TimeZone.current.identifier)
            return try await services.productivity.tasks.create(title: try SiriDrafts.title(text), body: nil, due: due, assignee: nil)
        }
        return .result(value: created.title, dialog: "\(SiriLines.taskAdded(created.title, due: created.due))")
    }
}

struct AddNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Note"
    static let description = IntentDescription("Save a note in Bob.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Text", requestValueDialog: "What should the note say?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Save \(\.$text) as a note in Bob")
    }

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let words = text
        let created = try await IntentServices.run { services in
            let note = try SiriDrafts.note(words)
            return try await services.productivity.notes.create(title: note.title, body: note.body)
        }
        return .result(value: created.title, dialog: "\(SiriLines.noteSaved(created.title))")
    }
}

// The repeats the reminder editor offers, less its every-few-hours, which needs a window nobody wants to say aloud.
nonisolated enum ReminderRepeatOption: String, AppEnum {
    case never, daily, weekdays, weekly, monthly, yearly

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Repeat"
    static let caseDisplayRepresentations: [ReminderRepeatOption: DisplayRepresentation] = [
        .never: "Does not repeat",
        .daily: "Every day",
        .weekdays: "Every weekday",
        .weekly: "Every week",
        .monthly: "Every month",
        .yearly: "Every year"
    ]

    var rule: ReminderRule? {
        // Every-few-hours is the only rule that reads these numbers, and it isn't offered here.
        ReminderRepeat(rawValue: rawValue)?.rule(everyHours: 1, from: "", until: "")
    }
}

struct AddReminderIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Reminder"
    static let description = IntentDescription("Set a reminder in Bob.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Text", requestValueDialog: "What should I remind you about?")
    var text: String

    @Parameter(title: "Date", kind: .dateTime, requestValueDialog: "When should I remind you?")
    var date: Date

    @Parameter(title: "Repeat", default: .never)
    var repeats: ReminderRepeatOption

    static var parameterSummary: some ParameterSummary {
        Summary("Remind me about \(\.$text) at \(\.$date)") {
            \.$repeats
        }
    }

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let words = text
        let when = date
        let rule = repeats.rule
        let zone = TimeZone.current.identifier
        let created = try await IntentServices.run { services in
            let title = try SiriDrafts.reminder(words, at: when, now: Date())
            return try await services.productivity.reminders.createPrivate(title: title, due: ReminderDue(at: when, zone: zone), rule: rule)
        }
        return .result(value: created.title, dialog: "\(SiriLines.reminderSet(created.title, at: when))")
    }
}

struct TodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Today"
    static let description = IntentDescription("Hear today's agenda and open tasks from Bob.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let brief = try await IntentServices.run { services in
            let now = Date()
            let start = Calendar.current.startOfDay(for: now)
            guard let end = Calendar.current.date(byAdding: .day, value: 1, to: start) else { throw ApiError.invalidRequest }
            async let page = services.productivity.calendar.agenda(from: start, to: end)
            async let tasks = services.productivity.tasks.tasks()
            return TodayBrief(page: try await page, tasks: SiriTasks.openTitles(try await tasks), now: now)
        }
        return .result(value: brief.text, dialog: "\(brief.spoken)")
    }
}

struct ListTasksIntent: AppIntent {
    static let title: LocalizedStringResource = "List Tasks"
    static let description = IntentDescription("Get the titles of your open tasks in Bob.")
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<[String]> & ProvidesDialog {
        let titles = try await IntentServices.run { services in
            SiriTasks.openTitles(try await services.productivity.tasks.tasks())
        }
        return .result(value: titles, dialog: "\(SiriLines.openTasks(titles))")
    }
}
