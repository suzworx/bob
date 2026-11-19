import BobKit
import Observation

// The observable home of the shell's navigation state; views read and change it through here.
@MainActor
@Observable
final class ShellStore {
    private var state = ShellState()
    // A shared conversation needs the bottom of the screen for its composer.
    private(set) var dockHidden = false
    var showsCalendar = false

    func setDockHidden(_ hidden: Bool) {
        dockHidden = hidden
    }

    var selectedTab: ShellTab { state.selectedTab }
    var isChatOpen: Bool { state.isChatOpen }
    var moment: ShellMoment? { state.moment }
    var isVoiceRequested: Bool { state.isVoiceRequested }
    var showsTabBar: Bool { state.showsTabBar }

    func select(_ tab: ShellTab) {
        state.select(tab)
    }

    func toggleChat() {
        state.toggleChat()
    }

    func openChat() {
        if !state.isChatOpen { state.toggleChat() }
    }

    func closeChat() {
        state.closeChat()
    }

    func present(_ moment: ShellMoment) {
        state.present(moment)
    }

    func dismissMoment() {
        state.dismissMoment()
    }

    func requestVoiceFromBob() { state.requestVoiceFromBob() }

    func beginRequestedVoice() { state.beginRequestedVoice() }

    func openCalendar() {
        state.go(to: .calendar)
        showsCalendar = true
    }

    func go(to destination: ShellDestination) {
        state.go(to: destination)
        if destination == .calendar { showsCalendar = true }
        if destination == .today { showsCalendar = false }
    }
}

// Where Siri asked to go. Held outside the shell, which doesn't exist yet on a cold launch or before sign-in, and taken once it does.
@MainActor
@Observable
final class ShellDestinations {
    static let shared = ShellDestinations()

    private(set) var pending: ShellDestination?

    func send(_ destination: ShellDestination) {
        pending = destination
    }

    func take() -> ShellDestination? {
        defer { pending = nil }
        return pending
    }
}

// Lets a moment drive .fullScreenCover(item:).
extension ShellMoment: @retroactive Identifiable {
    public var id: String {
        switch self {
        case .voice: "voice"
        case .signIn: "signIn"
        case .confirm: "confirm"
        case .designCatalog: "designCatalog"
        }
    }
}
