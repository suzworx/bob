import AppIntents
import SwiftUI

// What Bob answers to in Siri and Spotlight, and how to run him on a schedule.
struct SiriShortcutsView: View {
    private struct Saying: Identifiable {
        let phrase: String
        let does: String
        var id: String { phrase }
    }

    private let sayings = [
        Saying(phrase: "Ask Bob", does: "Get an answer without opening the app."),
        Saying(phrase: "Talk to Bob", does: "Go straight into a voice chat."),
        Saying(phrase: "What's on today in Bob", does: "Hear your day and your open tasks."),
        Saying(phrase: "Add a task in Bob", does: "With a due date if you like."),
        Saying(phrase: "Add a note in Bob", does: "Save a thought for later."),
        Saying(phrase: "Set a reminder in Bob", does: "Once or on repeat."),
        Saying(phrase: "What are my tasks in Bob", does: "List what's still open."),
        Saying(phrase: "Open Calendar in Bob", does: "Or Tasks, Notes, Memory and more.")
    ]

    var body: some View {
        List {
            BobSectionHeader(caption: "What you can say")
                .bobListRow(divider: false)
            ForEach(sayings) { saying in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\u{201C}\(saying.phrase)\u{201D}").font(BobFont.rowTitle)
                    Text(saying.does).font(BobFont.subline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
                .bobListRow()
            }
            BobSectionHeader(caption: "On a schedule")
                .bobListRow(divider: false)
            Text("In Shortcuts, go to Automation, pick a time and run \u{201C}Ask Bob\u{201D} or \u{201C}Today\u{201D}. If your iPhone is locked then, it asks you to unlock first.")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .bobListRow(divider: false)
            ShortcutsLink()
                .shortcutsLinkStyle(.automaticOutline)
                .frame(maxWidth: .infinity)
                .bobListRow(divider: false)
        }
        // The Shortcuts button is the last row; it has to scroll clear of the dock.
        .contentMargins(.bottom, 96, for: .scrollContent)
        .bobList()
        .bobNavTitle("Siri and Shortcuts")
    }
}

#Preview {
    NavigationStack { SiriShortcutsView() }
}
