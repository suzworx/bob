import SwiftUI

// The one way things move. Short and settled; a 150 ms fade under Reduce Motion. See apps/ios/DESIGN.md §6.
enum BobMotion {
    static func standard(reduceMotion: Bool) -> Animation {
        reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.85)
    }

    // Something arriving: it rises from the edge it belongs to, or only fades under Reduce Motion.
    static func arrival(reduceMotion: Bool, from edge: Edge = .bottom) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: edge).combined(with: .opacity)
    }
}

// The haptics Bob uses, named by what happened rather than by how it feels.
enum BobFeedback {
    // A choice moved: tabs, segments, filters.
    case selection
    // The person did something: a swipe action fired, a message was sent.
    case action
    // Something finished well: saved, done, reply finished.
    case success
    // Something needs a second look before it goes ahead.
    case warning
    // Something failed.
    case error

    var sensory: SensoryFeedback {
        switch self {
        case .selection: .selection
        case .action: .impact(weight: .light)
        case .success: .success
        case .warning: .warning
        case .error: .error
        }
    }
}

extension View {
    // Plays `feedback` whenever `trigger` changes.
    func bobFeedback<T: Equatable>(_ feedback: BobFeedback, trigger: T) -> some View {
        sensoryFeedback(feedback.sensory, trigger: trigger)
    }

    // Animates changes to `value` with Bob's one movement.
    func bobAnimation<V: Equatable>(value: V) -> some View {
        modifier(BobAnimationModifier(value: value))
    }
}

private struct BobAnimationModifier<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let value: V

    func body(content: Content) -> some View {
        content.animation(BobMotion.standard(reduceMotion: reduceMotion), value: value)
    }
}
