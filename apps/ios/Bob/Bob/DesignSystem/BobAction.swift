import SwiftUI

// One thing a person can do to an item. Declare an item's actions once; `bobActions` and `BobActionList`
// draw them as swipe actions, the press-and-hold menu, VoiceOver actions and detail-page buttons.
// See apps/ios/DESIGN.md §4.
struct BobAction: Identifiable {
    // How a destructive action is kept safe. Never improvised per screen.
    enum Safety {
        // Harmless or instantly reversible on screen.
        case none
        // The caller shows the undo bar after performing it.
        case undo
        // Can't be undone, or affects other people: ask once.
        case confirm(title: String, message: String, button: String)
    }

    let id: String
    let title: String
    let systemImage: String
    var isDestructive = false
    var safety: Safety = .none
    // Offered on swipe left (up to three; the rest stay in the menu).
    var inSwipe = false
    let perform: () -> Void

    init(
        _ title: String,
        systemImage: String,
        isDestructive: Bool = false,
        safety: Safety = .none,
        inSwipe: Bool = false,
        perform: @escaping () -> Void
    ) {
        self.id = title
        self.title = title
        self.systemImage = systemImage
        self.isDestructive = isDestructive
        self.safety = safety
        self.inSwipe = inSwipe
        self.perform = perform
    }

    var confirmation: (title: String, message: String, button: String)? {
        if case let .confirm(title, message, button) = safety { return (title, message, button) }
        return nil
    }
}

extension Array where Element == BobAction {
    // Menu and page order: everything harmless first, destructive last.
    var menuOrder: [BobAction] { filter { !$0.isDestructive } + filter(\.isDestructive) }

    // Swipe order: the first is drawn at the trailing edge, so destructive goes first.
    var swipeOrder: [BobAction] {
        let chosen = filter(\.inSwipe)
        return Array((chosen.filter(\.isDestructive) + chosen.filter { !$0.isDestructive }).prefix(3))
    }
}

extension View {
    // Swipe left, press and hold, and VoiceOver actions from one list.
    func bobActions(_ actions: [BobAction]) -> some View {
        modifier(BobActionsModifier(actions: actions))
    }
}

private struct BobActionsModifier: ViewModifier {
    let actions: [BobAction]
    @State private var pending: BobAction?
    @State private var fired = 0

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                ForEach(actions.swipeOrder) { action in
                    Button(role: action.isDestructive ? .destructive : nil) { run(action) } label: {
                        Label(action.title, systemImage: action.systemImage)
                    }
                    .tint(action.isDestructive ? BobColor.dangerText : BobColor.muted)
                }
            }
            .contextMenu {
                ForEach(actions.menuOrder) { action in
                    Button(role: action.isDestructive ? .destructive : nil) { run(action) } label: {
                        Label(action.title, systemImage: action.systemImage)
                    }
                }
            }
            .accessibilityActions {
                ForEach(actions.menuOrder) { action in
                    Button(action.title) { run(action) }
                }
            }
            .bobConfirmation(for: $pending)
            .bobFeedback(.action, trigger: fired)
    }

    private func run(_ action: BobAction) {
        if action.confirmation != nil {
            pending = action
        } else {
            fired += 1
            action.perform()
        }
    }
}

// The same actions as buttons on a detail page: harmless ones as outlined buttons, destructive last as red text.
struct BobActionList: View {
    let actions: [BobAction]
    @State private var pending: BobAction?
    @State private var fired = 0

    var body: some View {
        VStack(spacing: BobLayout.gap) {
            ForEach(actions.menuOrder) { action in
                if action.isDestructive {
                    Button(role: .destructive) { run(action) } label: {
                        Label(action.title, systemImage: action.systemImage)
                            .font(BobFont.body)
                            .foregroundStyle(BobColor.dangerText)
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(BobPressStyle())
                } else {
                    Button { run(action) } label: { Label(action.title, systemImage: action.systemImage) }
                        .buttonStyle(BobSecondaryButtonStyle(expands: true))
                }
            }
        }
        .bobConfirmation(for: $pending)
        .bobFeedback(.action, trigger: fired)
    }

    private func run(_ action: BobAction) {
        if action.confirmation != nil {
            pending = action
        } else {
            fired += 1
            action.perform()
        }
    }
}

extension View {
    // The one confirmation dialog for an action marked `.confirm`.
    fileprivate func bobConfirmation(for pending: Binding<BobAction?>) -> some View {
        confirmationDialog(
            pending.wrappedValue?.confirmation?.title ?? "",
            isPresented: Binding(get: { pending.wrappedValue != nil }, set: { if !$0 { pending.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: pending.wrappedValue
        ) { action in
            Button(action.confirmation?.button ?? action.title, role: .destructive) { action.perform() }
            Button("Cancel", role: .cancel) {}
        } message: { action in
            Text(action.confirmation?.message ?? "")
        }
    }
}
