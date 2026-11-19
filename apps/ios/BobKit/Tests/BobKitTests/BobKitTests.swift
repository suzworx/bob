import XCTest
@testable import BobKit

final class BobKitTests: XCTestCase {
    func testModuleNameIsBobKit() {
        XCTAssertEqual(BobKit.moduleName, "BobKit")
    }

    func testModuleNameIsNotEmpty() {
        XCTAssertFalse(BobKit.moduleName.isEmpty)
        XCTAssertEqual(BobKit.moduleName.count, 6)
    }
}
