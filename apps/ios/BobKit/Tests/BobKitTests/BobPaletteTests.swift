import Foundation
import XCTest
@testable import BobKit

final class BobPaletteTests: XCTestCase {
    private let black = HexColor(rgb: 0x000000)
    private let white = HexColor(rgb: 0xFFFFFF)

    func testBlackOnWhiteIsTwentyOne() {
        XCTAssertEqual(ContrastRatio.between(black, white), 21.0, accuracy: 0.001)
    }

    func testWhiteOnBlackIsTwentyOne() {
        XCTAssertEqual(ContrastRatio.between(white, black), 21.0, accuracy: 0.001)
    }

    func testAColourOnItselfIsOne() {
        XCTAssertEqual(ContrastRatio.between(BobPalette.ink, BobPalette.ink), 1.0, accuracy: 0.001)
        XCTAssertEqual(ContrastRatio.between(BobPalette.accent, BobPalette.accent), 1.0, accuracy: 0.001)
    }

    func testRatioIsOrderIndependent() {
        XCTAssertEqual(
            ContrastRatio.between(BobPalette.muted, BobPalette.tint),
            ContrastRatio.between(BobPalette.tint, BobPalette.muted)
        )
        XCTAssertEqual(
            ContrastRatio.between(BobPalette.ink, BobPalette.accent),
            ContrastRatio.between(BobPalette.accent, BobPalette.ink)
        )
    }

    func testKnownPaletteRatios() {
        XCTAssertEqual(ContrastRatio.between(BobPalette.ink, BobPalette.page), 11.07, accuracy: 0.01)
        XCTAssertEqual(ContrastRatio.between(BobPalette.ink, BobPalette.bobYellow), 7.00, accuracy: 0.01)
        XCTAssertEqual(ContrastRatio.between(BobPalette.ink, BobPalette.bobBubble), 7.90, accuracy: 0.01)
        XCTAssertEqual(ContrastRatio.between(BobPalette.muted, BobPalette.page), 5.23, accuracy: 0.01)
    }

    func testParsingAcceptsHashAndAnyCase() {
        for input in ["#173E57", "173e57", "#173e57"] {
            let color = HexColor(hex: input)
            XCTAssertEqual(color?.rgb, 0x173E57, input)
            XCTAssertEqual(color?.hex, "#173E57", input)
        }
    }

    func testParsingRejectsInvalidStrings() {
        for input in ["", "#12345", "#1234567", "#GGGGGG", " 173E57", "#17 3E57", "#FFF", "#FF173E57", "+173E5"] {
            XCTAssertNil(HexColor(hex: input), "\"\(input)\" should not parse")
        }
    }

    func testInitMasksToTwentyFourBits() {
        XCTAssertEqual(HexColor(rgb: 0xFF173E57).rgb, 0x173E57)
        XCTAssertEqual(HexColor(rgb: 0xFF173E57), BobPalette.ink)
    }

    func testHexIsUppercaseAndPadded() {
        XCTAssertEqual(HexColor(rgb: 0x0000AB).hex, "#0000AB")
        XCTAssertEqual(BobPalette.page.hex, "#FFFDF6")
    }

    func testInkChannels() {
        XCTAssertEqual(BobPalette.ink.red, 23)
        XCTAssertEqual(BobPalette.ink.green, 62)
        XCTAssertEqual(BobPalette.ink.blue, 87)
    }

    func testRelativeLuminanceOfWhiteAndBlack() {
        XCTAssertEqual(white.relativeLuminance, 1.0, accuracy: 0.0001)
        XCTAssertEqual(black.relativeLuminance, 0.0, accuracy: 0.0001)
    }

    func testEveryRequirementPasses() {
        for requirement in BobPalette.requirements {
            XCTAssertTrue(
                requirement.passes,
                "\(requirement.name) is \(String(format: "%.3f", requirement.ratio)), needs \(requirement.minimum)"
            )
        }
    }

    func testRequirementNamesAndOrder() {
        let expected = [
            "ink on page", "ink on surface", "ink on wash", "ink on tint", "ink on bob bubble",
            "ink on user bubble", "ink2 on page", "ink2 on surface", "ink2 on wash", "muted on page",
            "muted on surface", "muted on wash", "muted on tint", "on accent", "ink on bob yellow", "danger text on page",
            "danger text on surface", "danger text on wash", "ok text on page", "ok text on surface",
            "warn text on page", "warn text on surface", "ok fill on surface", "control line on page",
            "control line on surface", "ink on avatar fill 1", "ink on avatar fill 2",
            "ink on avatar fill 3", "ink on avatar fill 4"
        ]
        XCTAssertEqual(BobPalette.requirements.count, 29)
        XCTAssertEqual(BobPalette.requirements.map(\.name), expected)
    }

    func testRequirementMinimums() {
        let boundaries: Set<String> = ["ok fill on surface", "control line on page", "control line on surface"]
        for requirement in BobPalette.requirements {
            XCTAssertEqual(requirement.minimum, boundaries.contains(requirement.name) ? 3.0 : 4.5, requirement.name)
        }
    }

    func testEveryAvatarFillHasStrongInkContrast() {
        XCTAssertEqual(BobPalette.avatarFills.count, 4)
        for fill in BobPalette.avatarFills {
            XCTAssertGreaterThanOrEqual(ContrastRatio.between(BobPalette.ink, fill), 7.0, fill.hex)
        }
    }

    func testPaletteValues() {
        let table: [(String, HexColor, UInt32)] = [
            ("page", BobPalette.page, 0xFFFDF6), ("surface", BobPalette.surface, 0xFFFFFF),
            ("wash", BobPalette.wash, 0xF5F7F8), ("tint", BobPalette.tint, 0xE8F1F7),
            ("ink", BobPalette.ink, 0x173E57), ("ink2", BobPalette.ink2, 0x3D5F77),
            ("muted", BobPalette.muted, 0x4F6F85), ("accent", BobPalette.accent, 0x173E57),
            ("onAccent", BobPalette.onAccent, 0xFFFFFF), ("bobBubble", BobPalette.bobBubble, 0xBBDDF0),
            ("userBubble", BobPalette.userBubble, 0xE8F1F7), ("dangerText", BobPalette.dangerText, 0xB3412F),
            ("okText", BobPalette.okText, 0x46663A), ("okFill", BobPalette.okFill, 0x5E8247),
            ("warnText", BobPalette.warnText, 0x7A5C0E), ("coral", BobPalette.coral, 0xF07A6A)
        ]
        for (name, color, rgb) in table {
            XCTAssertEqual(color.rgb, rgb, name)
        }
        XCTAssertEqual(BobPalette.avatarFills.map(\.rgb), [0xBBDDF0, 0xF6DFA0, 0xDCE8D2, 0xF9D9D3])
    }

    // Coral is decoration only: it is too light to carry text, so no requirement may use it.
    func testCoralIsDecorationOnly() {
        for requirement in BobPalette.requirements {
            XCTAssertNotEqual(requirement.foreground, BobPalette.coral, requirement.name)
            XCTAssertNotEqual(requirement.background, BobPalette.coral, requirement.name)
        }
        XCTAssertLessThan(ContrastRatio.between(BobPalette.coral, BobPalette.ink), 4.5)
    }

    func testRequirementBelowMinimumDoesNotPass() {
        let requirement = ContrastRequirement(
            name: "coral on page", foreground: BobPalette.coral, background: BobPalette.page, minimum: 4.5
        )
        XCTAssertLessThan(requirement.ratio, 4.5)
        XCTAssertFalse(requirement.passes)
    }
}
