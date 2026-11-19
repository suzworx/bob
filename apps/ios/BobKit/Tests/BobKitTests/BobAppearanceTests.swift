import XCTest
@testable import BobKit

final class BobAppearanceTests: XCTestCase {
    private let white = HexColor(rgb: 0xFFFFFF)

    func testLegacyPreferencesKeepTheirChoicesAndFollowSystemAppearance() {
        let data = Data(#"{"palette":"pine","typeface":"didot","bobPlace":"hidden"}"#.utf8)
        let appearance = BobAppearance.decoded(from: data)
        XCTAssertEqual(appearance.palette, .pine)
        XCTAssertEqual(appearance.typeface, .didot)
        XCTAssertEqual(appearance.bobPlace, .hidden)
        XCTAssertEqual(appearance.mode, .system)
        XCTAssertEqual(BobAppearance.standard.mode, .system)
    }

    func testEveryModePersistsIndependentlyOfOtherChoices() {
        for mode in BobAppearance.Mode.allCases {
            for typeface in BobAppearance.Typeface.allCases {
                let appearance = BobAppearance(palette: .plum, typeface: typeface, bobPlace: .dock, mode: mode)
                XCTAssertEqual(BobAppearance.decoded(from: appearance.encoded), appearance)
            }
        }
        let unknown = Data(#"{"mode":"future","palette":"ember","typeface":"rounded","bobPlace":"dock"}"#.utf8)
        XCTAssertEqual(BobAppearance.decoded(from: unknown), BobAppearance(palette: .ember, typeface: .rounded, bobPlace: .dock, mode: .system))
    }

    func testTextAndControlsStayReadableInEveryPaletteAndScheme() {
        for palette in BobAppearance.Palette.allCases {
            for scheme in BobAppearance.Scheme.allCases {
                let colors = palette.colors(in: scheme)
                let backgrounds = [colors.page, colors.skyBottom, colors.surface, colors.wash, colors.tint, colors.bobBubble, colors.userBubble]
                let foregrounds = [colors.ink, colors.ink2, colors.muted, colors.dangerText, colors.warnText, colors.okText]
                for background in backgrounds {
                    for foreground in foregrounds {
                        XCTAssertGreaterThanOrEqual(ContrastRatio.between(foreground, background), 4.5, "\(palette)/\(scheme): \(foreground.hex) on \(background.hex)")
                    }
                    XCTAssertGreaterThanOrEqual(ContrastRatio.between(colors.controlLine, background), 3, "\(palette)/\(scheme) boundary")
                }
                XCTAssertGreaterThanOrEqual(ContrastRatio.between(colors.onAccent, colors.accent), 4.5, "\(palette)/\(scheme) action")
                XCTAssertEqual(scheme == .light, colors.page.relativeLuminance > 0.5)
            }
        }
    }

    func testTheStandardLookIsMonochromeAndMono() {
        XCTAssertEqual(BobAppearance.standard.palette, .mono)
        XCTAssertEqual(BobAppearance.standard.typeface, .mono)
        for scheme in BobAppearance.Scheme.allCases {
            let t = BobMono.tokens(in: scheme)
            // Five colours on one page colour: every text pair 4.5:1 on page and fill, boundaries 3:1.
            for background in [t.page, t.fill, t.raised] {
                for text in [t.ink, t.grey, t.red] {
                    XCTAssertGreaterThanOrEqual(ContrastRatio.between(text, background), 4.5, "\(scheme) \(text.hex) on \(background.hex)")
                }
                XCTAssertGreaterThanOrEqual(ContrastRatio.between(t.line, background), 3, "\(scheme) line on \(background.hex)")
            }
            XCTAssertGreaterThanOrEqual(ContrastRatio.between(t.page, t.ink), 4.5, "\(scheme) primary button")
        }
    }

    func testChoicesRoundTrip() {
        let chosen = BobAppearance(palette: .pine, typeface: .didot, bobPlace: .hidden)
        XCTAssertEqual(BobAppearance.decoded(from: chosen.encoded), chosen)
    }

    func testNothingSavedGivesTheStandardLook() {
        XCTAssertEqual(BobAppearance.decoded(from: nil), .standard)
        XCTAssertEqual(BobAppearance.decoded(from: Data("not json".utf8)), .standard)
    }

    func testAnUnknownSavedChoiceKeepsTheOthers() {
        let data = Data(#"{"palette":"neon","typeface":"rounded","bobPlace":"dock"}"#.utf8)
        XCTAssertEqual(BobAppearance.decoded(from: data), BobAppearance(palette: BobAppearance.standard.palette, typeface: .rounded, bobPlace: .dock))
    }

    func testEveryPaletteIsReadable() {
        for palette in BobAppearance.Palette.allCases {
            XCTAssertGreaterThanOrEqual(ContrastRatio.between(white, palette.skyTop), 4.5, palette.title)
            XCTAssertGreaterThanOrEqual(ContrastRatio.between(white, palette.skyBottom), 4.5, palette.title)
            XCTAssertGreaterThanOrEqual(ContrastRatio.between(palette.onAction, palette.action), 4.5, palette.title)
        }
    }

    func testStatusColoursAreReadableOnEverySky() {
        let colours = [BobAppearance.dangerOnSky, BobAppearance.warnOnSky, BobAppearance.okOnSky, BobAppearance.mutedOnSky]
        for palette in BobAppearance.Palette.allCases {
            for colour in colours {
                XCTAssertGreaterThanOrEqual(ContrastRatio.between(colour, palette.skyTop), 4.5, palette.title)
                XCTAssertGreaterThanOrEqual(ContrastRatio.between(colour, palette.skyBottom), 4.5, palette.title)
            }
        }
    }

    func testHeadlineNamesTheNextEvent() {
        let calendar = Calendar(identifier: .gregorian)
        let locale = Locale(identifier: "en_US_POSIX")
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: 1_800_000_000))
        func at(_ hour: Int) -> Date { calendar.date(bySettingHour: hour, minute: 0, second: 0, of: today)! }
        let plan = TodayPlan.make(items: [
            AgendaItem(eventID: "a", title: "Dentist", startAt: at(9)),
            AgendaItem(eventID: "b", title: "Book club", startAt: at(19))
        ], now: at(12), calendar: calendar, locale: locale)
        XCTAssertTrue(plan.headline(now: at(12)).hasPrefix("Book club is next, at"))
        XCTAssertEqual(plan.headline(now: at(20)), "That's everything for today.")
        XCTAssertEqual(TodayPlan(today: [], thisWeek: []).headline(now: at(12)), "Nothing planned today.")
    }
}
