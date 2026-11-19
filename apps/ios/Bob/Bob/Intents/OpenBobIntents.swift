import AppIntents
import BobKit

// Opens the app straight into the voice moment.
struct TalkToBobIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Bob"
    static let description = IntentDescription("Open Bob and start talking.")
    static let openAppWhenRun = true

    @MainActor func perform() async throws -> some IntentResult {
        ShellDestinations.shared.send(.voice)
        return .result()
    }
}

nonisolated enum BobArea: String, AppEnum {
    case today, calendar, home, search, tasks, notes, reminders, memory, chat, you, notifications, devices

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Area of Bob"
    static let caseDisplayRepresentations: [BobArea: DisplayRepresentation] = [
        .today: "Today",
        .calendar: "Calendar",
        .home: "Home",
        .search: "Search",
        .tasks: "Tasks",
        .notes: "Notes",
        .reminders: "Reminders",
        .memory: "Memory",
        .chat: "Chat",
        .you: "You",
        .notifications: "Notifications",
        .devices: "Devices"
    ]
}

// The places a person can pick when the shortcut asks.
nonisolated struct BobAreaOptions: DynamicOptionsProvider {
    func results() async throws -> [BobArea] { BobArea.allCases }
}

struct OpenBobIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Bob"
    static let description = IntentDescription("Open Bob at the place you choose.")
    static let openAppWhenRun = true

    @Parameter(title: "Area", requestValueDialog: "Where in Bob?")
    var area: BobArea

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$area) in Bob")
    }

    @MainActor func perform() async throws -> some IntentResult {
        if let destination = ShellDestination(rawValue: area.rawValue) {
            ShellDestinations.shared.send(destination)
        }
        return .result()
    }
}
