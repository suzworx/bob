import Foundation

// How a person has chosen the app to look. Kept on this device; an unknown saved value falls back to the default.
public struct BobAppearance: Equatable, Codable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Identifiable, Sendable {
        case system, light, dark

        public var id: String { rawValue }
        public var title: String { rawValue.capitalized }
    }

    // The resolved display scheme; System is resolved by the view's traits, never by saved state.
    public enum Scheme: CaseIterable, Sendable { case light, dark }

    public struct Colors: Sendable {
        public let page: HexColor
        public let skyBottom: HexColor
        public let surface: HexColor
        public let wash: HexColor
        public let tint: HexColor
        public let ink: HexColor
        public let ink2: HexColor
        public let muted: HexColor
        public let accent: HexColor
        public let onAccent: HexColor
        public let bobBubble: HexColor
        public let userBubble: HexColor
        public let dangerText: HexColor
        public let warnText: HexColor
        public let okText: HexColor
        public let okFill: HexColor
        public let controlLine: HexColor
    }

    public enum Palette: String, Codable, CaseIterable, Identifiable, Sendable {
        case mono, midnight, plum, pine, ember, black

        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .mono: "Bob"
            case .midnight: "Midnight"
            default: rawValue.capitalized
            }
        }

        public var skyTop: HexColor {
            switch self {
            case .mono: BobMono.dark.page
            case .midnight: HexColor(rgb: 0x0B1020)
            case .plum: HexColor(rgb: 0x170E22)
            case .pine: HexColor(rgb: 0x08140F)
            case .ember: HexColor(rgb: 0x14100D)
            case .black: HexColor(rgb: 0x000000)
            }
        }

        public var skyBottom: HexColor {
            switch self {
            case .mono, .midnight: skyTop
            case .plum: HexColor(rgb: 0x3C2342)
            case .pine: HexColor(rgb: 0x173229)
            case .ember: HexColor(rgb: 0x33241A)
            case .black: HexColor(rgb: 0x111114)
            }
        }

        public var action: HexColor {
            switch self {
            case .mono: BobMono.dark.ink
            case .midnight, .black: HexColor(rgb: 0xFFFFFF)
            case .plum: HexColor(rgb: 0xF4B6A6)
            case .pine: HexColor(rgb: 0xCDEBD8)
            case .ember: HexColor(rgb: 0xF2D8BC)
            }
        }

        public var onAction: HexColor { skyTop }

        private var daylight: (top: HexColor, bottom: HexColor, accent: HexColor) {
            switch self {
            case .mono: (BobMono.light.page, BobMono.light.page, BobMono.light.ink)
            case .midnight: (BobPalette.page, BobPalette.page, BobPalette.ink)
            case .plum: (HexColor(rgb: 0xFFFAFC), HexColor(rgb: 0xF8EFF7), HexColor(rgb: 0x653653))
            case .pine: (HexColor(rgb: 0xFAFDF8), HexColor(rgb: 0xEDF5EC), HexColor(rgb: 0x28563E))
            case .ember: (HexColor(rgb: 0xFFFCF7), HexColor(rgb: 0xFAF0E6), HexColor(rgb: 0x75432B))
            case .black: (HexColor(rgb: 0xFFFFFF), HexColor(rgb: 0xF4F4F6), HexColor(rgb: 0x29292D))
            }
        }

        public func colors(in scheme: Scheme) -> Colors {
            if self == .mono { return BobMono.colors(in: scheme) }
            if scheme == .light {
                let day = daylight
                return Colors(
                    page: day.top, skyBottom: day.bottom, surface: BobPalette.surface,
                    wash: HexColor(rgb: 0xF2F5F7), tint: HexColor(rgb: 0xEAF0F4),
                    ink: BobPalette.ink, ink2: BobPalette.ink2, muted: HexColor(rgb: 0x496477),
                    accent: day.accent, onAccent: BobPalette.onAccent,
                    bobBubble: HexColor(rgb: 0xEAF0F4), userBubble: HexColor(rgb: 0xF2F5F7),
                    dangerText: BobPalette.dangerText, warnText: BobPalette.warnText,
                    okText: BobPalette.okText, okFill: BobPalette.okFill,
                    controlLine: HexColor(rgb: 0x708496)
                )
            }
            return Colors(
                page: skyTop, skyBottom: skyBottom, surface: HexColor(rgb: 0x202633),
                wash: HexColor(rgb: 0x242C3A), tint: HexColor(rgb: 0x303847),
                ink: HexColor(rgb: 0xF8FAFC), ink2: HexColor(rgb: 0xD5DAE3), muted: BobAppearance.mutedOnSky,
                accent: action, onAccent: onAction,
                bobBubble: HexColor(rgb: 0x293747), userBubble: HexColor(rgb: 0x242C3A),
                dangerText: BobAppearance.dangerOnSky, warnText: BobAppearance.warnOnSky,
                okText: BobAppearance.okOnSky, okFill: BobAppearance.okOnSky,
                controlLine: HexColor(rgb: 0x96A4B5)
            )
        }
    }

    public enum Typeface: String, Codable, CaseIterable, Identifiable, Sendable {
        case mono, sfPro, avenir, rounded, newYork, didot

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .mono: "SF Mono"
            case .sfPro: "SF Pro"
            case .avenir: "Avenir Next"
            case .rounded: "SF Rounded"
            case .newYork: "New York"
            case .didot: "Didot"
            }
        }
    }

    public enum BobPlace: String, Codable, CaseIterable, Identifiable, Sendable {
        case tabBar, dock, speaker, resting, date, hidden

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .tabBar: "In the tab bar"
            case .dock: "Standing in the dock"
            case .speaker: "Beside his words"
            case .resting: "Resting on the page"
            case .date: "Next to the date"
            case .hidden: "Hidden"
            }
        }
    }

    // Status text for the evening sky, readable on every palette.
    public static let dangerOnSky = HexColor(rgb: 0xFF9C8F)
    public static let warnOnSky = HexColor(rgb: 0xF2CD85)
    public static let okOnSky = HexColor(rgb: 0xA9DDB0)
    public static let mutedOnSky = HexColor(rgb: 0xB9BDC9)

    public var mode: Mode
    public var palette: Palette
    public var typeface: Typeface
    public var bobPlace: BobPlace

    public static let standard = BobAppearance(palette: .mono, typeface: .mono, bobPlace: .speaker)

    public init(palette: Palette, typeface: Typeface, bobPlace: BobPlace, mode: Mode = .system) {
        self.mode = mode
        self.palette = palette
        self.typeface = typeface
        self.bobPlace = bobPlace
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = (try? container.decode(Mode.self, forKey: .mode)) ?? .system
        palette = (try? container.decode(Palette.self, forKey: .palette)) ?? Self.standard.palette
        typeface = (try? container.decode(Typeface.self, forKey: .typeface)) ?? Self.standard.typeface
        bobPlace = (try? container.decode(BobPlace.self, forKey: .bobPlace)) ?? Self.standard.bobPlace
    }

    public static func decoded(from data: Data?) -> BobAppearance {
        guard let data, let value = try? JSONDecoder().decode(BobAppearance.self, from: data) else { return standard }
        return value
    }

    public var encoded: Data? { try? JSONEncoder().encode(self) }
}
