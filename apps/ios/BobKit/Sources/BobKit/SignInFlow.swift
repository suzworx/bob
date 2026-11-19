import Foundation

// The sign-in screen's state, with no UI. The screen asks to start an action, runs the request, and reports how it went.
public struct SignInFlow: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        case email
        case code
    }

    public enum Action: Equatable, Sendable {
        case send
        case verify
    }

    public static let codeLength = 6
    // Supabase's default wait between emails to one address; a longer answer from the server replaces it.
    public static let defaultCooldown: TimeInterval = 60

    public private(set) var email = ""
    public private(set) var code = ""
    public private(set) var step = Step.email
    public private(set) var isSending = false
    public private(set) var emailProblem: String?
    public private(set) var codeProblem: String?
    public private(set) var notice: String?
    public private(set) var error: SignInError?
    // Moves each time the code field should take focus; the screen watches it.
    public private(set) var codeFocusRequests = 0
    private var lastAction = Action.send
    private var cooldownEnds: Date?

    public init() {}

    private var trimmedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Worded here so every outcome has one tested message. The provider's own text never reaches the screen.
    public var errorMessage: String? {
        switch error {
        case nil:
            return nil
        case .badCode:
            return "That code is wrong or has expired. Request a new code."
        case .cooldown(let seconds):
            return "Wait \(seconds) \(seconds == 1 ? "second" : "seconds"), then request a new code."
        case .emailCap:
            return "Too many sign-in emails were sent recently. Use a code you already received, or try again later."
        case .tooManyAttempts:
            return "Too many attempts. Wait a few minutes, then try again."
        case .unreachable:
            return "Couldn't reach the sign-in service. Check your connection and try again."
        case .notSaved:
            return "Couldn't finish signing in on this phone. Request a new code."
        case .failed, .unknownAddress:
            return "Sign-in failed. Check your details and try again."
        }
    }

    // What "Try again" repeats. Nil when repeating the same request cannot help.
    public var retryAction: Action? {
        error == .unreachable || error == .failed ? lastAction : nil
    }

    public mutating func setEmail(_ value: String) {
        guard value != email else { return }
        email = value
        emailProblem = nil
        error = nil
        // A code and a cooldown both belong to one address.
        if step == .code {
            step = .email
            code = ""
            codeProblem = nil
            notice = nil
            cooldownEnds = nil
        }
    }

    // Only what a code can hold, so nothing else stays in the text field behind the cells.
    public static func cleanCode(_ value: String) -> String {
        String(value.filter { $0.isASCII && $0.isNumber }.prefix(codeLength))
    }

    public mutating func setCode(_ value: String) {
        guard !isSending else { return }
        let cleaned = Self.cleanCode(value)
        // The field can echo the value it was just given; only a real change dismisses the error.
        guard cleaned != code else { return }
        code = cleaned
        codeProblem = nil
        error = nil
    }

    // A full code goes straight in; a code that was just refused has been cleared, so it cannot repeat.
    public var shouldAutoVerify: Bool {
        step == .code && code.count == Self.codeLength && !isSending
    }

    public func resendSecondsRemaining(now: Date) -> Int {
        guard let cooldownEnds else { return 0 }
        return max(0, Int(cooldownEnds.timeIntervalSince(now).rounded(.up)))
    }

    // The address to send to, or nil when nothing should be sent yet.
    public mutating func startSend(now: Date) -> String? {
        guard !isSending, resendSecondsRemaining(now: now) == 0 else { return nil }
        let address = trimmedEmail
        if address.isEmpty {
            emailProblem = "Enter your email address first."
            return nil
        }
        guard address.wholeMatch(of: /[^\s@]+@[^\s@]+\.[^\s@]+/) != nil else {
            emailProblem = "Enter a valid email address, like you@example.com."
            return nil
        }
        begin(.send)
        return address
    }

    // An unknown address answers exactly like a sent code, as the web does: the screen never says whether an account exists.
    public mutating func finishSend(error failure: SignInError?, now: Date) {
        isSending = false
        switch failure {
        case nil, .unknownAddress:
            step = .code
            code = ""
            notice = "We emailed you a six-digit code."
            cooldownEnds = now.addingTimeInterval(Self.defaultCooldown)
        case .cooldown(let seconds):
            // Nothing was sent, but an earlier email still carries a valid code.
            step = .code
            error = failure
            cooldownEnds = now.addingTimeInterval(TimeInterval(seconds))
        case .emailCap, .tooManyAttempts:
            step = .code
            error = failure
        default:
            error = failure
        }
        if step == .code {
            codeFocusRequests += 1
        }
    }

    public mutating func startVerify() -> (email: String, code: String)? {
        guard !isSending else { return nil }
        guard code.count == Self.codeLength else {
            codeProblem = "Enter the 6-digit code from your email."
            return nil
        }
        begin(.verify)
        return (trimmedEmail, code)
    }

    public mutating func finishVerify(error failure: SignInError?) {
        isSending = false
        error = failure
        if failure == .badCode {
            code = ""
            codeFocusRequests += 1
        }
    }

    private mutating func begin(_ action: Action) {
        lastAction = action
        isSending = true
        emailProblem = nil
        codeProblem = nil
        notice = nil
        error = nil
    }
}
