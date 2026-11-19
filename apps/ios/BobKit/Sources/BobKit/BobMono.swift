import Foundation

// Bob's standard look: five colours per scheme. See apps/ios/DESIGN.md §1.
// ink for text and actions, grey for secondary text, line for boundaries, fill for fields and bubbles,
// and one red that means now, unread, live or destructive.
public enum BobMono {
    public struct Tokens: Sendable {
        public let page: HexColor
        public let fill: HexColor
        public let raised: HexColor
        public let ink: HexColor
        public let grey: HexColor
        public let line: HexColor
        public let red: HexColor
    }

    public static let light = Tokens(
        page: HexColor(rgb: 0xFFFFFF),
        fill: HexColor(rgb: 0xF4F4F6),
        raised: HexColor(rgb: 0xF4F4F6),
        ink: HexColor(rgb: 0x121214),
        grey: HexColor(rgb: 0x5E5E66),
        line: HexColor(rgb: 0x85858E),
        red: HexColor(rgb: 0xC9281C)
    )

    public static let dark = Tokens(
        page: HexColor(rgb: 0x0E0E10),
        fill: HexColor(rgb: 0x1C1C1F),
        raised: HexColor(rgb: 0x26262B),
        ink: HexColor(rgb: 0xF5F5F7),
        grey: HexColor(rgb: 0xA1A1AA),
        line: HexColor(rgb: 0x7A7A83),
        red: HexColor(rgb: 0xFF6B5E)
    )

    public static func tokens(in scheme: BobAppearance.Scheme) -> Tokens {
        scheme == .light ? light : dark
    }

    // The app-wide colour roles, filled from the five tokens. Status colours collapse onto ink and grey:
    // state is said in words, and red is kept for now, unread, live and destructive.
    public static func colors(in scheme: BobAppearance.Scheme) -> BobAppearance.Colors {
        let t = tokens(in: scheme)
        return BobAppearance.Colors(
            page: t.page, skyBottom: t.page, surface: t.page,
            wash: t.fill, tint: t.raised,
            ink: t.ink, ink2: t.grey, muted: t.grey,
            accent: t.ink, onAccent: t.page,
            bobBubble: t.fill, userBubble: t.fill,
            dangerText: t.red, warnText: t.grey,
            okText: t.ink, okFill: t.ink,
            controlLine: t.line
        )
    }
}
