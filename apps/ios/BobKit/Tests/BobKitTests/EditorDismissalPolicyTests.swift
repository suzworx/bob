import XCTest
@testable import BobKit

final class EditorDismissalPolicyTests: XCTestCase {
    func testUntouchedDraftCanCloseWithoutConfirmation() {
        let policy = EditorDismissalPolicy(hasUnsavedChanges: false, isSaving: false)
        XCTAssertEqual(policy.cancelAction, .dismiss)
        XCTAssertFalse(policy.preventsInteractiveDismissal)
    }

    func testDirtyDraftNeedsExplicitDiscardAndCannotSwipeAway() {
        let policy = EditorDismissalPolicy(hasUnsavedChanges: true, isSaving: false)
        XCTAssertEqual(policy.cancelAction, .confirmDiscard)
        XCTAssertTrue(policy.preventsInteractiveDismissal)
    }

    func testSavingBlocksEveryUserExitEvenWhenDraftMatchesSavedValues() {
        for dirty in [false, true] {
            let policy = EditorDismissalPolicy(hasUnsavedChanges: dirty, isSaving: true)
            XCTAssertEqual(policy.cancelAction, .blocked)
            XCTAssertTrue(policy.preventsInteractiveDismissal)
        }
    }

    func testFailedSaveLeavesDirtyDraftProtectedButAllowsExplicitDiscard() {
        let whileSaving = EditorDismissalPolicy(hasUnsavedChanges: true, isSaving: true)
        XCTAssertEqual(whileSaving.cancelAction, .blocked)
        let afterFailure = EditorDismissalPolicy(hasUnsavedChanges: true, isSaving: false)
        XCTAssertEqual(afterFailure.cancelAction, .confirmDiscard)
        XCTAssertTrue(afterFailure.preventsInteractiveDismissal)
    }
}
