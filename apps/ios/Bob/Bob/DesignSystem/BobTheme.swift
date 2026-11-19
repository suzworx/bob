import SwiftUI
import UIKit
import BobKit

// The only place a colour is built from numbers: every other view uses a BobColor token.
extension Color {
    init(_ hex: HexColor) {
        self.init(
            .sRGB,
            red: Double(hex.red) / 255,
            green: Double(hex.green) / 255,
            blue: Double(hex.blue) / 255,
            opacity: 1
        )
    }
}

// Palette choices are observable; each dynamic colour resolves against the drawing view's traits.
// This also works inside system sheets and while the system changes appearance.
enum BobColor {
    private static func adaptive(_ keyPath: KeyPath<BobAppearance.Colors, HexColor>) -> Color {
        let palette = BobAppearanceStore.shared.value.palette
        let light = palette.colors(in: .light)[keyPath: keyPath]
        let dark = palette.colors(in: .dark)[keyPath: keyPath]
        return Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat(hex.red) / 255, green: CGFloat(hex.green) / 255, blue: CGFloat(hex.blue) / 255, alpha: 1)
        })
    }

    static var page: Color { adaptive(\.page) }
    static var skyBottom: Color { adaptive(\.skyBottom) }
    static var surface: Color { adaptive(\.surface) }
    static var wash: Color { adaptive(\.wash) }
    static var tint: Color { adaptive(\.tint) }
    static var ink: Color { adaptive(\.ink) }
    static var ink2: Color { adaptive(\.ink2) }
    static var muted: Color { adaptive(\.muted) }
    static var accent: Color { adaptive(\.accent) }
    static var onAccent: Color { adaptive(\.onAccent) }
    static var bobBubble: Color { adaptive(\.bobBubble) }
    static var userBubble: Color { adaptive(\.userBubble) }
    static var dangerText: Color { adaptive(\.dangerText) }
    static var okText: Color { adaptive(\.okText) }
    static var okFill: Color { adaptive(\.okFill) }
    static var warnText: Color { adaptive(\.warnText) }
    static var controlLine: Color { adaptive(\.controlLine) }
    static let bobYellow = Color(BobPalette.bobYellow)
    static let coral = Color(BobPalette.coral)

    // Avatar initials always use the same dark ink, so their decorative fills stay light in both modes.
    private static let avatarFills = BobPalette.avatarFills.map { Color($0) }

    static func avatarFill(_ index: Int) -> Color {
        guard !avatarFills.isEmpty else { return wash }
        let count = avatarFills.count
        return avatarFills[((index % count) + count) % count]
    }
}

// The person's chosen typeface. Display faces are for headlines; body text stays easy to read.
enum BobFont {
    private static var face: BobAppearance.Typeface { BobAppearanceStore.shared.value.typeface }

    private static func display(_ size: CGFloat, _ style: Font.TextStyle) -> Font {
        switch face {
        case .mono: .system(style, design: .monospaced, weight: .bold)
        case .sfPro: .system(style, weight: .bold)
        case .avenir: .custom("AvenirNext-DemiBold", size: size, relativeTo: style)
        case .rounded: .system(style, design: .rounded, weight: .bold)
        case .newYork: .system(style, design: .serif)
        case .didot: .custom("Didot", size: size + 2, relativeTo: style)
        }
    }

    private static func text(_ size: CGFloat, _ style: Font.TextStyle) -> Font {
        switch face {
        case .mono: .system(style, design: .monospaced)
        case .avenir: .custom("AvenirNext-Regular", size: size, relativeTo: style)
        case .rounded: .system(style, design: .rounded)
        case .sfPro, .newYork, .didot: .system(style)
        }
    }

    // Mono is wide, so it sits one text style smaller than the proportional faces at the same reading size.
    private static var isMono: Bool { face == .mono }

    // The six roles. Every screen picks from these; see apps/ios/DESIGN.md §2.
    static var title: Font { display(28, .title) }
    static var lead: Font { display(20, .title3) }
    static var body: Font { isMono ? text(15, .subheadline) : text(17, .body) }
    static var bodyStrong: Font { body.weight(.bold) }
    static var secondary: Font { isMono ? text(13, .footnote) : text(15, .subheadline) }
    static var label: Font { isMono ? text(12, .caption) : text(13, .footnote) }
    static var control: Font { text(11, .caption2) }

    // Earlier names, kept so every screen adopts the scale. Prefer the roles above in new code.
    static var navigationTitle: Font { bodyStrong }
    static var greeting: Font { title }
    static var heading: Font { lead }
    static var rowTitle: Font { bodyStrong }
    static var subline: Font { secondary }
    static var meta: Font { secondary }
    static var tabLabel: Font { control }
    static var caption: Font { label }
    static var code: Font { .system(.callout, design: .monospaced) }
    static var inlineCode: Font { .system(.body, design: .monospaced) }

    // A heading inside a reply stays close to the words around it.
    static func replyHeading(level: Int) -> Font {
        switch level {
        case 1: text(22, .title2).weight(.semibold)
        case 2: text(20, .title3).weight(.semibold)
        default: text(17, .body).weight(.semibold)
        }
    }
}

// The sky behind every screen follows the chosen palette and the resolved appearance.
struct BobSky: View {
    var body: some View {
        LinearGradient(colors: [BobColor.page, BobColor.skyBottom], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
    }
}

// Bob's face on his yellow disc.
struct BobFaceBadge: View {
    var size: CGFloat = 36

    var body: some View {
        Image("BobHead")
            .resizable()
            .scaledToFill()
            .frame(width: size * 0.86, height: size * 0.86, alignment: .top)
            .clipShape(Circle())
            .frame(width: size, height: size)
            .background(BobColor.bobYellow, in: Circle())
            .accessibilityHidden(true)
    }
}

extension View {
    @ViewBuilder func bobGlass() -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: Capsule())
        } else {
            background(.ultraThinMaterial, in: Capsule())
        }
    }
}

// Measures shared by every screen.
enum BobLayout {
    static let pageMargin: CGFloat = 20
    // The only two radii: controls and cards, then sheets.
    static let controlRadius: CGFloat = 12
    static let sheetRadius: CGFloat = 20
    // The 4-point spacing steps every stack uses.
    static let gap: CGFloat = 8
    static let groupGap: CGFloat = 24
}

// The one hairline between rows and above bars.
struct BobDivider: View {
    var body: some View {
        Rectangle()
            .fill(BobColor.controlLine.opacity(0.3))
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

// The press every tappable thing shares: a small settle, or only a fade under Reduce Motion.
struct BobPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

private struct BobPageModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .foregroundStyle(BobColor.ink)
            .tint(BobColor.accent)
            .font(BobFont.body)
            .background(BobSky())
    }
}

extension View {
    // Ink text on the page background, the background running under the safe areas.
    func bobPage() -> some View {
        modifier(BobPageModifier())
    }
}
