import Foundation

// A 24-bit sRGB colour as plain data, so contrast can be checked without SwiftUI or UIKit.
public struct HexColor: Equatable, Sendable {
    public let rgb: UInt32

    public init(rgb: UInt32) {
        self.rgb = rgb & 0xFFFFFF
    }

    // Exactly six hex digits after an optional "#"; anything else, whitespace included, is nil.
    public init?(hex: String) {
        let digits = hex.hasPrefix("#") ? hex.dropFirst() : Substring(hex)
        guard digits.count == 6, digits.allSatisfy({ $0.isASCII && $0.isHexDigit }),
              let value = UInt32(digits, radix: 16) else {
            return nil
        }
        self.init(rgb: value)
    }

    public var hex: String {
        String(format: "#%06X", rgb)
    }

    public var red: Int { Int((rgb >> 16) & 0xFF) }
    public var green: Int { Int((rgb >> 8) & 0xFF) }
    public var blue: Int { Int(rgb & 0xFF) }

    // WCAG 2.x relative luminance.
    public var relativeLuminance: Double {
        0.2126 * Self.linear(red) + 0.7152 * Self.linear(green) + 0.0722 * Self.linear(blue)
    }

    private static func linear(_ channel: Int) -> Double {
        let c = Double(channel) / 255
        return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
    }
}

public enum ContrastRatio {
    public static func between(_ first: HexColor, _ second: HexColor) -> Double {
        let a = first.relativeLuminance
        let b = second.relativeLuminance
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}

// One foreground and background pair the app draws, and the WCAG minimum it must meet.
public struct ContrastRequirement: Equatable, Sendable {
    public let name: String
    public let foreground: HexColor
    public let background: HexColor
    public let minimum: Double

    public var ratio: Double {
        ContrastRatio.between(foreground, background)
    }

    public var passes: Bool {
        ratio >= minimum
    }
}

// The Bob palette, light mode only. Every text and control pair is listed in `requirements`.
public enum BobPalette {
    public static let page = HexColor(rgb: 0xFFFDF6)
    public static let surface = HexColor(rgb: 0xFFFFFF)
    public static let wash = HexColor(rgb: 0xF5F7F8)
    public static let tint = HexColor(rgb: 0xE8F1F7)
    public static let ink = HexColor(rgb: 0x173E57)
    public static let ink2 = HexColor(rgb: 0x3D5F77)
    public static let muted = HexColor(rgb: 0x4F6F85)
    public static let accent = HexColor(rgb: 0x173E57)
    // Bob himself and nothing else: the Bob button.
    public static let bobYellow = HexColor(rgb: 0xF0C75E)
    public static let onAccent = HexColor(rgb: 0xFFFFFF)
    public static let bobBubble = HexColor(rgb: 0xBBDDF0)
    public static let userBubble = HexColor(rgb: 0xE8F1F7)
    public static let dangerText = HexColor(rgb: 0xB3412F)
    public static let okText = HexColor(rgb: 0x46663A)
    public static let okFill = HexColor(rgb: 0x5E8247)
    public static let warnText = HexColor(rgb: 0x7A5C0E)
    // Decoration only: never text, never the only signal.
    public static let coral = HexColor(rgb: 0xF07A6A)
    // Toggle off track and input borders.
    public static let controlLine = HexColor(rgb: 0x7A92A4)
    public static let avatarFills: [HexColor] = [
        HexColor(rgb: 0xBBDDF0), HexColor(rgb: 0xF6DFA0), HexColor(rgb: 0xDCE8D2), HexColor(rgb: 0xF9D9D3)
    ]

    private static let text = 4.5
    private static let boundary = 3.0

    public static let requirements: [ContrastRequirement] = {
        let pairs: [(String, HexColor, HexColor, Double)] = [
            ("ink on page", ink, page, text),
            ("ink on surface", ink, surface, text),
            ("ink on wash", ink, wash, text),
            ("ink on tint", ink, tint, text),
            ("ink on bob bubble", ink, bobBubble, text),
            ("ink on user bubble", ink, userBubble, text),
            ("ink2 on page", ink2, page, text),
            ("ink2 on surface", ink2, surface, text),
            ("ink2 on wash", ink2, wash, text),
            ("muted on page", muted, page, text),
            ("muted on surface", muted, surface, text),
            ("muted on wash", muted, wash, text),
            ("muted on tint", muted, tint, text),
            ("on accent", onAccent, accent, text),
            ("ink on bob yellow", ink, bobYellow, text),
            ("danger text on page", dangerText, page, text),
            ("danger text on surface", dangerText, surface, text),
            ("danger text on wash", dangerText, wash, text),
            ("ok text on page", okText, page, text),
            ("ok text on surface", okText, surface, text),
            ("warn text on page", warnText, page, text),
            ("warn text on surface", warnText, surface, text),
            ("ok fill on surface", okFill, surface, boundary),
            ("control line on page", controlLine, page, boundary),
            ("control line on surface", controlLine, surface, boundary)
        ]
        let avatars = avatarFills.enumerated().map { index, fill in
            ("ink on avatar fill \(index + 1)", ink, fill, text)
        }
        return (pairs + avatars).map {
            ContrastRequirement(name: $0.0, foreground: $0.1, background: $0.2, minimum: $0.3)
        }
    }()
}
