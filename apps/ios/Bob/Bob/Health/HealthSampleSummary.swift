import BobKit
import HealthKit

enum HealthSampleSummary {
    static func describe(_ samples: [HKSample], window: HealthReadWindow, limit: Int) -> String {
        let prefix = samples.count == limit ? "Latest \(limit) records (limited)" : "\(samples.count) records"
        guard let latest = samples.first else { return HealthReader.noData }
        let date = latest.startDate.formatted(date: .abbreviated, time: .omitted)
        if latest.sampleType == HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            let asleepValues = Set([HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue,
                                    HKCategoryValueSleepAnalysis.asleepCore.rawValue,
                                    HKCategoryValueSleepAnalysis.asleepDeep.rawValue,
                                    HKCategoryValueSleepAnalysis.asleepREM.rawValue])
            let intervals = samples.compactMap { sample -> DateInterval? in
                guard let sleep = sample as? HKCategorySample, asleepValues.contains(sleep.value) else { return nil }
                return DateInterval(start: sleep.startDate, end: sleep.endDate)
            }
            let hours = window.mergedDuration(intervals) / 3600
            let stages = HealthCategoryValue.describe(identifier: latest.sampleType.identifier, values: samples.compactMap { ($0 as? HKCategorySample)?.value })
            return "\(prefix) · \(hours.formatted(.number.precision(.fractionLength(0...1)))) recorded asleep hours within this period; overlapping sources counted once; awake and in-bed time excluded. \(stages)"
        }
        if latest.sampleType == HKObjectType.categoryType(forIdentifier: .mindfulSession) {
            let intervals = samples.map { DateInterval(start: $0.startDate, end: $0.endDate) }
            let minutes = window.mergedDuration(intervals) / 60
            return "\(prefix) · \(minutes.formatted(.number.precision(.fractionLength(0...1)))) recorded mindful minutes within this period; overlapping records counted once"
        }
        if let categories = samples as? [HKCategorySample] {
            let values = HealthCategoryValue.describe(identifier: latest.sampleType.identifier, values: categories.map(\.value))
            return "\(prefix) · latest \(date) · \(values). Counts describe records, not separate diagnoses."
        }
        if let workouts = samples as? [HKWorkout] {
            let minutes = workouts.reduce(0) { $0 + window.clippedDuration(start: $1.startDate, end: $1.endDate) } / 60
            return "\(prefix) · \(minutes.formatted(.number.precision(.fractionLength(0)))) elapsed session minutes within this period (includes pauses; records may overlap)"
        }
        if let ecg = latest as? HKElectrocardiogram {
            let rate = ecg.averageHeartRate.map { " · latest average heart rate \($0.doubleValue(for: HKUnit.count().unitDivided(by: .minute())).formatted(.number.precision(.fractionLength(0)))) bpm" } ?? ""
            return "\(prefix) · latest ECG \(date)\(rate) · waveform stays in Health"
        }
        if let audiogram = latest as? HKAudiogramSample {
            return "\(prefix) · latest audiogram \(date), \(audiogram.sensitivityPoints.count) frequency measurements"
        }
        if let prescription = latest as? HKVisionPrescription {
            return "\(prefix) · latest prescription issued \(prescription.dateIssued.formatted(date: .abbreviated, time: .omitted))"
        }
        if latest is HKWorkoutRoute { return "\(prefix) · latest route \(date) · precise locations stay in Health" }
        if let series = latest as? HKHeartbeatSeriesSample {
            return "\(prefix) · latest heartbeat series \(date), \(series.count) beats"
        }
        if #available(iOS 18.0, *) {
            if let assessment = latest as? HKScoredAssessment {
                return "\(prefix) · latest recorded score \(assessment.score), \(date)"
            }
            if let mood = latest as? HKStateOfMind {
                return "\(prefix) · latest recorded valence \(mood.valence.formatted(.number.precision(.fractionLength(2)))) on Apple's −1 to 1 scale, \(date)"
            }
        }
        if #available(iOS 26.0, *), latest is HKMedicationDoseEvent {
            return "\(prefix) · latest medication log \(date) · logs include taken, skipped and other statuses; count is not doses taken"
        }
        if let record = latest as? HKClinicalRecord {
            return "\(prefix) · latest \(date): \(record.displayName.prefix(120)) · full clinical document stays in Health"
        }
        if latest is HKDocumentSample {
            return "\(prefix) · latest health document \(date) · document contents stay in Health"
        }
        return "\(prefix) · latest \(date) · record count is not a clinical interpretation or duration"
    }
}
