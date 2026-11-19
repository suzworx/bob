import BobKit
import HealthKit

enum HealthCharacteristics {
    static func read(store: HKHealthStore) -> [HealthSummary] {
        [
            summary("BiologicalSex", title: "Biological sex") {
                switch try store.biologicalSex().biologicalSex {
                case .female: "Female"
                case .male: "Male"
                case .other: "Other"
                case .notSet: nil
                @unknown default: nil
                }
            },
            summary("BloodType", title: "Blood type") {
                switch try store.bloodType().bloodType {
                case .aPositive: "A+"
                case .aNegative: "A−"
                case .bPositive: "B+"
                case .bNegative: "B−"
                case .abPositive: "AB+"
                case .abNegative: "AB−"
                case .oPositive: "O+"
                case .oNegative: "O−"
                case .notSet: nil
                @unknown default: nil
                }
            },
            summary("DateOfBirth", title: "Age") {
                let parts = try store.dateOfBirthComponents()
                guard let date = Calendar.current.date(from: parts), let years = Calendar.current.dateComponents([.year], from: date, to: .now).year, years >= 0 else { return nil }
                return "\(years) years · exact birth date is not shared"
            },
            summary("FitzpatrickSkinType", title: "Fitzpatrick skin type") {
                let type = try store.fitzpatrickSkinType().skinType.rawValue
                return type == 0 ? nil : "Recorded type \(type)"
            },
            summary("WheelchairUse", title: "Wheelchair use") {
                switch try store.wheelchairUse().wheelchairUse {
                case .yes: "Yes"
                case .no: "No"
                case .notSet: nil
                @unknown default: nil
                }
            },
            summary("ActivityMoveMode", title: "Activity move mode") {
                switch try store.activityMoveMode().activityMoveMode {
                case .activeEnergy: "Active energy"
                case .appleMoveTime: "Move time"
                @unknown default: nil
                }
            }
        ]
    }

    private static func summary(_ suffix: String, title: String, read: () throws -> String?) -> HealthSummary {
        let detail = try? read()
        return HealthSummary(id: "HKCharacteristicTypeIdentifier\(suffix)", title: title,
                             detail: detail.map { "\($0) · current profile, independent of selected period" } ?? "No readable profile value. It may be unset or access may be off.", hasData: detail != nil)
    }
}

@available(iOS 26.0, *)
@MainActor enum HealthMedicationReader {
    static func read(store: HKHealthStore) async -> HealthSummary {
        do {
            let medications = try await HKUserAnnotatedMedicationQueryDescriptor(limit: 100).result(for: store)
            let active = medications.filter { !$0.isArchived }
            let scheduled = active.filter(\.hasSchedule).count
            let names = active.prefix(8).map { String($0.medication.displayText.prefix(80)) }.joined(separator: "; ")
            let detail = medications.isEmpty ? "No readable medications. There may be no records, or access may be off." : "\(medications.count == 100 ? "Up to " : "")\(medications.count) medication records · \(active.count) active, \(scheduled) with schedules · current list, independent of selected period. Active medication names (up to 8): \(names)"
            return HealthSummary(id: "HKDataTypeIdentifierUserAnnotatedMedicationConcept", title: "Medications", detail: detail, hasData: !medications.isEmpty)
        } catch {
            return HealthSummary(id: "HKDataTypeIdentifierUserAnnotatedMedicationConcept", title: "Medications", detail: "Couldn't read medications. Review access in Health and try again.", hasData: false)
        }
    }
}
