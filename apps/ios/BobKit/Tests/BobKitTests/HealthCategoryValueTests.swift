import XCTest
@testable import BobKit

final class HealthCategoryValueTests: XCTestCase {
    func testSameRawValueHasDifferentMeaningForSeverityPresenceAndStandHour() {
        XCTAssertEqual(label("Headache", 0), "Unspecified")
        XCTAssertEqual(label("MoodChanges", 0), "Present")
        XCTAssertEqual(label("AppleStandHour", 0), "Stood")
        XCTAssertEqual(label("Headache", 4), "Severe")
        XCTAssertEqual(label("SleepChanges", 1), "Not present")
    }

    func testReproductiveTestResultsAreNotInferredFromGenericSymptomValues() {
        XCTAssertEqual(label("PregnancyTestResult", 2), "Positive")
        XCTAssertEqual(label("OvulationTestResult", 2), "Luteinizing hormone surge")
        XCTAssertEqual(label("OvulationTestResult", 4), "Estrogen surge")
        XCTAssertEqual(label("MenstrualFlow", 4), "Heavy")
        XCTAssertEqual(label("BleedingDuringPregnancy", 5), "None")
        XCTAssertEqual(label("Contraceptive", 4), "Intrauterine device")
    }

    func testDistributionKeepsActualLatestValueAndUnknownValuesExplicit() {
        let summary = HealthCategoryValue.describe(identifier: "HKCategoryTypeIdentifierHeadache", values: [2, 4, 2, 99])
        XCTAssertTrue(summary.contains("Latest recorded value: Mild"))
        XCTAssertTrue(summary.contains("Mild (2)"))
        XCTAssertTrue(summary.contains("Severe (1)"))
        XCTAssertTrue(summary.contains("Unrecognized value 99 (1)"))
        XCTAssertEqual(label("FutureCategory", 0), "Unrecognized value 0")
    }

    private func label(_ name: String, _ value: Int) -> String {
        HealthCategoryValue.label(identifier: "HKCategoryTypeIdentifier" + name, value: value)
    }
}
