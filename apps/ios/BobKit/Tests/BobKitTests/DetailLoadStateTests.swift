import XCTest
@testable import BobKit

@MainActor final class DetailLoadStateTests: XCTestCase {
    func testOfflineIsRetryableFailureRatherThanMissingTarget() async {
        let state = DetailLoadState()
        XCTAssertEqual(state.phase, .loading)
        await state.load { throw ApiError.offline }
        XCTAssertEqual(state.phase, .failed(.offline))
        await state.load {}
        XCTAssertEqual(state.phase, .loaded)
    }

    func testOnlyExplicitNotFoundProducesMissingTarget() async {
        let state = DetailLoadState()
        await state.load { throw ApiError.forbidden }
        XCTAssertEqual(state.phase, .failed(.forbidden))
        await state.load { throw ApiError.notFound }
        XCTAssertEqual(state.phase, .failed(.notFound))
    }

    func testLateFailureCannotReplaceNewerSuccessfulRequest() async {
        let state = DetailLoadState()
        await state.load {
            await state.load {}
            throw ApiError.offline
        }
        XCTAssertEqual(state.phase, .loaded)
    }

    func testCancellationNeverClaimsTargetIsGone() async {
        let state = DetailLoadState()
        await state.load { throw CancellationError() }
        XCTAssertEqual(state.phase, .loading)
    }
}
