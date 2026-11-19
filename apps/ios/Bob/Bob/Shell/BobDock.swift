import BobKit
import SwiftUI

// A quiet, opaque navigation rail. The shell reserves its full height, including large text.
struct BobDock: View {
    let selectedTab: ShellTab
    var unread = 0
    let onSelect: (ShellTab) -> Void

    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .caption2) private var iconSize: CGFloat = 21
    @ScaledMetric(relativeTo: .caption2) private var iconWell: CGFloat = 40


    var body: some View {
        HStack(alignment: .top, spacing: 2) {
            tab(.chats)
            tab(.today)
            bobButton
            tab(.spaces)
            tab(.you)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 5)
        .background {
            BobColor.page.ignoresSafeArea(.container, edges: .bottom)
        }
        .overlay(alignment: .top) {
            Rectangle().fill(BobColor.controlLine.opacity(0.35))
                .frame(height: 1 / displayScale)
                .accessibilityHidden(true)
        }
        .sensoryFeedback(.selection, trigger: selectedTab)
    }

    private func symbol(for tab: ShellTab, selected: Bool) -> String {
        switch tab {
        case .chats: selected ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right"
        case .today: selected ? "sun.max.fill" : "sun.max"
        case .bob: "waveform"
        case .spaces: selected ? "person.2.fill" : "person.2"
        case .you: selected ? "person.fill" : "person"
        }
    }

    private func tab(_ tab: ShellTab) -> some View {
        let selected = tab == selectedTab
        return Button { onSelect(tab) } label: {
            VStack(spacing: 3) {
                Image(systemName: symbol(for: tab, selected: selected))
                    .font(.system(size: min(iconSize, 28), weight: selected ? .semibold : .regular))
                    .overlay(alignment: .topTrailing) {
                        if tab == .you, unread > 0 {
                            Circle().fill(BobColor.bobYellow)
                                .frame(width: 7, height: 7)
                                .overlay { Circle().stroke(BobColor.page, lineWidth: 1.5) }
                                .offset(x: 4, y: -3)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(height: min(iconWell, 44))
                Text(tab.title)
                    .font(BobFont.tabLabel.weight(selected ? .semibold : .regular))
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(selected ? BobColor.ink : BobColor.muted)
            .frame(minWidth: 44, maxWidth: .infinity, minHeight: 56, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel(tab.title)
        .accessibilityValue(tab == .you && unread > 0 ? "\(tab.accessibilityValue), \(unread) unread notifications" : tab.accessibilityValue)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var bobButton: some View {
        Button { onSelect(.bob) } label: {
            VStack(spacing: 3) {
                BobVisorIcon(filled: selectedTab == .bob, size: min(iconSize, 28))
                .frame(height: min(iconWell, 44))
                .accessibilityHidden(true)
                Text("Bob")
                    .font(BobFont.tabLabel.weight(selectedTab == .bob ? .semibold : .regular))
                    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundStyle(selectedTab == .bob ? BobColor.ink : BobColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minWidth: 44, maxWidth: .infinity, minHeight: 56, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel("Bob")
        .accessibilityValue(ShellTab.bob.accessibilityValue)
        .accessibilityHint("Opens your private companion space")
        .accessibilityAddTraits(selectedTab == .bob ? .isSelected : [])
    }
}
