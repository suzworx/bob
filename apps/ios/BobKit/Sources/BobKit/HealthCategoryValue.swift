import Foundation

/// HealthKit SDK category values, not inferred diagnoses or severity thresholds.
/// Pure value mapping keeps each category's distinct raw-value semantics testable.
public enum HealthCategoryValue {
    private static let severity: Set<String> = [
        "AbdominalCramps", "Acne", "BladderIncontinence", "Bloating", "BreastPain", "ChestTightnessOrPain",
        "Chills", "Constipation", "Coughing", "Diarrhea", "Dizziness", "DrySkin", "Fainting", "Fatigue",
        "Fever", "GeneralizedBodyAche", "HairLoss", "Headache", "Heartburn", "HotFlashes", "LossOfSmell",
        "LossOfTaste", "LowerBackPain", "MemoryLapse", "Nausea", "NightSweats", "PelvicPain",
        "RapidPoundingOrFlutteringHeartbeat", "RunnyNose", "ShortnessOfBreath", "SinusCongestion",
        "SkippedHeartbeat", "SoreThroat", "VaginalDryness", "Vomiting", "Wheezing"
    ]
    private static let occurrence: Set<String> = [
        "HighHeartRateEvent", "HypertensionEvent", "IrregularHeartRhythmEvent", "LowHeartRateEvent",
        "MindfulSession", "HandwashingEvent", "ToothbrushingEvent", "InfrequentMenstrualCycles",
        "IntermenstrualBleeding", "IrregularMenstrualCycles", "Lactation", "PersistentIntermenstrualBleeding",
        "Pregnancy", "ProlongedMenstrualPeriods", "SexualActivity", "SleepApneaEvent"
    ]

    public static func label(identifier: String, value: Int) -> String {
        let name = identifier.replacingOccurrences(of: "HKCategoryTypeIdentifier", with: "")
        let labels = labels(for: name)
        return labels[value] ?? "Unrecognized value \(value)"
    }

    /// Values are newest first; labels retain exactly what Health recorded.
    public static func describe(identifier: String, values: [Int]) -> String {
        guard let latest = values.first else { return "No recorded values" }
        let counts = Dictionary(grouping: values, by: { $0 }).mapValues(\.count)
        let distribution = counts.keys.sorted().map { value in
            "\(label(identifier: identifier, value: value)) (\(counts[value, default: 0]))"
        }.joined(separator: "; ")
        return "Latest recorded value: \(label(identifier: identifier, value: latest)) · recorded values: \(distribution)"
    }

    private static func labels(for name: String) -> [Int: String] {
        if severity.contains(name) { return [0: "Unspecified", 1: "Not present", 2: "Mild", 3: "Moderate", 4: "Severe"] }
        if occurrence.contains(name) { return [0: "Event recorded"] }
        switch name {
        case "MoodChanges", "SleepChanges": return [0: "Present", 1: "Not present"]
        case "AppleStandHour": return [0: "Stood", 1: "Idle"]
        case "AppetiteChanges": return [0: "Unspecified", 1: "No change", 2: "Decreased", 3: "Increased"]
        case "AppleWalkingSteadinessEvent":
            return [1: "Initial low", 2: "Initial very low", 3: "Repeated low", 4: "Repeated very low"]
        case "CervicalMucusQuality": return [1: "Dry", 2: "Sticky", 3: "Creamy", 4: "Watery", 5: "Egg white"]
        case "Contraceptive":
            return [1: "Unspecified", 2: "Implant", 3: "Injection", 4: "Intrauterine device", 5: "Intravaginal ring", 6: "Oral", 7: "Patch"]
        case "EnvironmentalAudioExposureEvent": return [1: "Momentary audio exposure limit"]
        case "HeadphoneAudioExposureEvent": return [1: "Seven-day audio exposure limit"]
        case "LowCardioFitnessEvent": return [1: "Recorded low fitness classification"]
        case "MenstrualFlow", "BleedingDuringPregnancy", "BleedingAfterPregnancy":
            return [1: "Unspecified", 2: "Light", 3: "Medium", 4: "Heavy", 5: "None"]
        case "OvulationTestResult": return [1: "Negative", 2: "Luteinizing hormone surge", 3: "Indeterminate", 4: "Estrogen surge"]
        case "PregnancyTestResult", "ProgesteroneTestResult": return [1: "Negative", 2: "Positive", 3: "Indeterminate"]
        case "SleepAnalysis": return [0: "In bed", 1: "Asleep, unspecified stage", 2: "Awake", 3: "Asleep, core", 4: "Asleep, deep", 5: "Asleep, REM"]
        default: return [:]
        }
    }
}
