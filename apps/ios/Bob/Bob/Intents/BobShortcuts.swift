import AppIntents

// Works in Siri and Spotlight with no setup. Apple allows ten of these.
nonisolated struct BobShortcuts: AppShortcutsProvider {
    static let shortcutTileColor: ShortcutTileColor = .navy

    @AppShortcutsBuilder static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskBobIntent(), phrases: [
            "Ask \(.applicationName)",
            "Ask \(.applicationName) a question",
            "Ask \(.applicationName) something"
        ], shortTitle: "Ask Bob", systemImageName: "bubble.left.fill")
        AppShortcut(intent: TalkToBobIntent(), phrases: [
            "Talk to \(.applicationName)",
            "Start talking to \(.applicationName)",
            "Have a chat with \(.applicationName)"
        ], shortTitle: "Talk to Bob", systemImageName: "waveform")
        AppShortcut(intent: TodayIntent(), phrases: [
            "What's on today in \(.applicationName)",
            "What's my day in \(.applicationName)",
            "Today in \(.applicationName)"
        ], shortTitle: "Today", systemImageName: "sun.max")
        AppShortcut(intent: AddTaskIntent(), phrases: [
            "Add a task in \(.applicationName)",
            "Add a task to \(.applicationName)",
            "New \(.applicationName) task"
        ], shortTitle: "Add Task", systemImageName: "checkmark.circle")
        AppShortcut(intent: AddNoteIntent(), phrases: [
            "Add a note in \(.applicationName)",
            "Take a note in \(.applicationName)",
            "New \(.applicationName) note"
        ], shortTitle: "Add Note", systemImageName: "note.text")
        AppShortcut(intent: AddReminderIntent(), phrases: [
            "Add a reminder in \(.applicationName)",
            "Set a reminder in \(.applicationName)",
            "New \(.applicationName) reminder"
        ], shortTitle: "Add Reminder", systemImageName: "bell")
        AppShortcut(intent: ListTasksIntent(), phrases: [
            "What are my tasks in \(.applicationName)",
            "List my \(.applicationName) tasks",
            "Show my tasks in \(.applicationName)"
        ], shortTitle: "List Tasks", systemImageName: "list.bullet")
        AppShortcut(intent: OpenBobIntent(), phrases: [
            "Open \(\.$area) in \(.applicationName)",
            "Go to \(\.$area) in \(.applicationName)",
            "Show \(\.$area) in \(.applicationName)"
        ], shortTitle: "Open Bob", systemImageName: "arrow.up.forward.app", parameterPresentation: ParameterPresentation(for: \.$area, summary: Summary("Open \(\.$area) in Bob"), optionsCollections: {
            OptionsCollection(BobAreaOptions(), title: "Area", systemImageName: "square.grid.2x2")
        }))
    }
}
