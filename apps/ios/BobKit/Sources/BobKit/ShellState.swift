import Foundation

// Stable destinations, in the same order in every appearance.
public enum ShellTab: Int, CaseIterable, Sendable {
    case chats, today, bob, spaces, you

    public var title: String {
        switch self {
        case .chats: "Chats"
        case .today: "Today"
        case .bob: "Bob"
        case .spaces: "Spaces"
        case .you: "You"
        }
    }

    // One-based position for the accessibility tab count.
    public var position: Int { rawValue + 1 }

    public static var count: Int { allCases.count }

    public var accessibilityValue: String { "tab \(position) of \(Self.count)" }
}

// A full-screen moment that hides the tab bar.
public enum ShellMoment: Equatable, Sendable {
    case voice, signIn, confirm, designCatalog
}

// Where the app can be sent from outside it, such as by Siri. Each is a tab, or a place inside one, or the chat.
public enum ShellDestination: String, CaseIterable, Sendable {
    case today, calendar, home, search, tasks, notes, reminders, memory, chat, voice, you, notifications, devices

    // Nil for the chat, which opens over whichever tab is showing.
    public var tab: ShellTab? {
        switch self {
        case .today: .today
        case .calendar: .today
        case .home, .search, .tasks, .notes, .reminders, .memory: .spaces
        case .you, .notifications, .devices: .you
        case .chat, .voice: nil
        }
    }
}

// The shell's navigation state: the selected tab, the chat sheet and the current moment.
public struct ShellState: Equatable, Sendable {
    public private(set) var selectedTab: ShellTab
    public private(set) var isChatOpen: Bool
    public private(set) var moment: ShellMoment?
    public private(set) var isVoiceRequested = false
    private var voiceReturnsToBob = false

    public init() {
        selectedTab = .chats
        isChatOpen = false
        moment = nil
    }

    // The chat sheet keeps the bar; only a moment hides it.
    public var showsTabBar: Bool { moment == nil }

    public mutating func select(_ tab: ShellTab) {
        guard !isChatOpen, moment == nil else { return }
        selectedTab = tab
    }

    public mutating func toggleChat() {
        guard moment == nil else { return }
        isChatOpen.toggle()
        if !isChatOpen { isVoiceRequested = false; voiceReturnsToBob = false }
    }

    public mutating func closeChat() {
        isChatOpen = false
        isVoiceRequested = false
        voiceReturnsToBob = false
        if moment == .voice { moment = nil }
    }

    // Whatever was on top makes way. Voice opens the chat here; the moment itself follows once the chat is up.
    public mutating func go(to destination: ShellDestination) {
        moment = nil
        isVoiceRequested = destination == .voice
        voiceReturnsToBob = false
        if let tab = destination.tab {
            isChatOpen = false
            selectedTab = tab
        } else {
            isChatOpen = true
        }
    }

    // Voice opens over the chat it talks into, and goes back to it; any other moment replaces the chat.
    public mutating func present(_ moment: ShellMoment) {
        isVoiceRequested = false
        voiceReturnsToBob = false
        if moment != .voice {
            isChatOpen = false
        }
        self.moment = moment
    }

    // The companion entry is a destination, not a synthetic person-to-person call.
    public mutating func requestVoiceFromBob() {
        guard moment == nil else { return }
        selectedTab = .bob
        isChatOpen = true
        isVoiceRequested = true
        voiceReturnsToBob = true
    }

    // Called by the visible chat after its full-screen presentation has settled.
    public mutating func beginRequestedVoice() {
        guard isVoiceRequested, isChatOpen, moment == nil else { return }
        isVoiceRequested = false
        moment = .voice
    }

    public mutating func dismissMoment() {
        if moment == .voice, voiceReturnsToBob { isChatOpen = false }
        moment = nil
        isVoiceRequested = false
        voiceReturnsToBob = false
    }
}
