import XCTest
@testable import BobKit

final class ShellStateTests: XCTestCase {
    func testInitialStateIsChatsWithChatClosedAndNoMoment() {
        let state = ShellState()
        XCTAssertEqual(state.selectedTab.title, "Chats")
        XCTAssertFalse(state.isChatOpen)
        XCTAssertNil(state.moment)
        XCTAssertTrue(state.showsTabBar)
    }

    func testTabTitlesPositionsAndAccessibility() {
        let titles = ["Chats", "Today", "Bob", "Spaces", "You"]
        XCTAssertEqual(ShellTab.count, 5)
        for (index, tab) in ShellTab.allCases.enumerated() {
            XCTAssertEqual(tab.title, titles[index])
            XCTAssertEqual(tab.position, index + 1)
            XCTAssertEqual(tab.accessibilityValue, "tab \(index + 1) of 5")
        }
    }

    func testAllCasesInBarOrder() {
        XCTAssertEqual(ShellTab.allCases.map(\.title), ["Chats", "Today", "Bob", "Spaces", "You"])
    }

    func testSelectChangesTab() {
        var state = ShellState()
        state.select(.spaces)
        XCTAssertEqual(state.selectedTab, .spaces)
        state.select(.you)
        XCTAssertEqual(state.selectedTab, .you)
    }

    func testSelectIgnoredWhileChatOpen() {
        var state = ShellState()
        state.toggleChat()
        state.select(.bob)
        XCTAssertEqual(state.selectedTab, .chats)
        XCTAssertTrue(state.isChatOpen)
    }

    func testSelectIgnoredWhileMomentShowing() {
        var state = ShellState()
        state.present(.voice)
        state.select(.bob)
        XCTAssertEqual(state.selectedTab, .chats)
        XCTAssertEqual(state.moment, .voice)
    }

    func testVoiceOpensOverTheChatAndOtherMomentsReplaceIt() {
        var state = ShellState()
        state.toggleChat()
        state.present(.voice)
        XCTAssertTrue(state.isChatOpen)
        XCTAssertEqual(state.moment, .voice)
        state.dismissMoment()
        XCTAssertTrue(state.isChatOpen)
        state.present(.signIn)
        XCTAssertFalse(state.isChatOpen)
    }

    func testToggleChatOpensThenCloses() {
        var state = ShellState()
        state.toggleChat()
        XCTAssertTrue(state.isChatOpen)
        state.toggleChat()
        XCTAssertFalse(state.isChatOpen)
    }

    func testToggleChatIgnoredWhileMomentShowing() {
        var state = ShellState()
        state.present(.signIn)
        state.toggleChat()
        XCTAssertFalse(state.isChatOpen)
        XCTAssertEqual(state.moment, .signIn)
    }

    func testCloseChatWhenAlreadyClosedIsHarmless() {
        var state = ShellState()
        state.closeChat()
        XCTAssertEqual(state, ShellState())
    }

    func testCloseChatClosesOpenChat() {
        var state = ShellState()
        state.toggleChat()
        state.closeChat()
        XCTAssertFalse(state.isChatOpen)
    }

    func testPresentClosesOpenChatAndSetsMoment() {
        var state = ShellState()
        state.toggleChat()
        state.present(.confirm)
        XCTAssertFalse(state.isChatOpen)
        XCTAssertEqual(state.moment, .confirm)
    }

    func testPresentReplacesExistingMoment() {
        var state = ShellState()
        state.present(.voice)
        state.present(.designCatalog)
        XCTAssertEqual(state.moment, .designCatalog)
    }

    func testDismissMomentKeepsSelectedTab() {
        var state = ShellState()
        state.select(.you)
        state.present(.designCatalog)
        state.dismissMoment()
        XCTAssertNil(state.moment)
        XCTAssertEqual(state.selectedTab, .you)
        XCTAssertFalse(state.isChatOpen)
    }

    func testShowsTabBarFalseOnlyWhileMomentShows() {
        var state = ShellState()
        state.toggleChat()
        XCTAssertTrue(state.showsTabBar)
        state.present(.voice)
        XCTAssertFalse(state.showsTabBar)
        state.dismissMoment()
        XCTAssertTrue(state.showsTabBar)
    }

    func testSelectedTabSurvivesChatAndMoment() {
        var state = ShellState()
        state.select(.bob)
        state.toggleChat()
        state.closeChat()
        XCTAssertEqual(state.selectedTab, .bob)
        state.present(.signIn)
        state.dismissMoment()
        XCTAssertEqual(state.selectedTab, .bob)
    }
    func testLegacyCalendarAndHomeDestinationsReachTheirNewRoots() {
        XCTAssertEqual(ShellDestination.calendar.tab, .today)
        XCTAssertEqual(ShellDestination.home.tab, .spaces)
        XCTAssertEqual(ShellDestination.search.tab, .spaces)
    }

    func testBobVoiceEndsAtBobWithoutLeavingAChatCover() {
        var state = ShellState()
        state.requestVoiceFromBob()
        XCTAssertEqual(state.selectedTab, .bob)
        XCTAssertTrue(state.isChatOpen)
        XCTAssertTrue(state.isVoiceRequested)
        XCTAssertNil(state.moment)
        state.beginRequestedVoice()
        XCTAssertEqual(state.moment, .voice)
        state.dismissMoment()
        XCTAssertEqual(state.selectedTab, .bob)
        XCTAssertFalse(state.isChatOpen)
        XCTAssertFalse(state.isVoiceRequested)
    }

    func testRequestedVoiceFromAChatReturnsToThatChat() {
        var state = ShellState()
        state.go(to: .voice)
        XCTAssertTrue(state.isVoiceRequested)
        state.beginRequestedVoice()
        state.dismissMoment()
        XCTAssertTrue(state.isChatOpen)
        XCTAssertEqual(state.selectedTab, .chats)
    }

    func testClosingTheChatCancelsPendingVoice() {
        var state = ShellState()
        state.requestVoiceFromBob()
        state.closeChat()
        state.beginRequestedVoice()
        XCTAssertNil(state.moment)
        XCTAssertFalse(state.isChatOpen)
        XCTAssertFalse(state.isVoiceRequested)
    }

    func testDestinationChangeCancelsPendingBobVoice() {
        var state = ShellState()
        state.requestVoiceFromBob()
        state.go(to: .tasks)
        state.beginRequestedVoice()
        XCTAssertNil(state.moment)
        XCTAssertFalse(state.isChatOpen)
        XCTAssertEqual(state.selectedTab, .spaces)
    }

}
