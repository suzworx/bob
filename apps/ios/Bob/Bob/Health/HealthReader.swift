import BobKit
import HealthKit

/// On-demand, read-only queries. No observer, background delivery, persistence, or network calls.
@MainActor final class HealthReader {
    let store = HKHealthStore()
    static let recordLimit = 500
    static let noData = "No readable data in this period. There may be no records, or access may be off."

    func requestAccess() async throws {
        try await store.requestAuthorization(toShare: [], read: HealthTypeCatalog.readTypes)
    }

    func requestClinicalAccess() async throws {
        try await store.requestAuthorization(toShare: [], read: Set(HealthTypeCatalog.clinical))
    }

    func requestRecordAccess(_ type: HKObjectType) async throws {
        try await store.requestPerObjectReadAuthorization(for: type, predicate: nil)
    }

    func read(_ type: HKSampleType, window: HealthReadWindow) async -> HealthSummary {
        do {
            let detail: String?
            if let quantity = type as? HKQuantityType {
                detail = try await quantitySummary(quantity, window: window)
            } else {
                let samples = try await samples(type, window: window)
                detail = samples.isEmpty ? nil : HealthSampleSummary.describe(samples, window: window, limit: Self.recordLimit)
            }
            return HealthSummary(id: type.identifier, title: HealthTypeCatalog.title(type), detail: detail ?? Self.noData, hasData: detail != nil)
        } catch {
            // Never expose raw errors: some HealthKit errors can contain private metadata.
            return HealthSummary(id: type.identifier, title: HealthTypeCatalog.title(type), detail: "Couldn't read this category. Try again after checking Health access and unlocking your iPhone.", hasData: false)
        }
    }

    private func quantitySummary(_ type: HKQuantityType, window: HealthReadWindow) async throws -> String? {
        let units = try await store.preferredUnits(for: [type])
        guard let unit = units[type] else { return nil }
        let cumulative = type.aggregationStyle == .cumulative
        let options: HKStatisticsOptions = cumulative ? .cumulativeSum : .discreteAverage
        let predicate = HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: [.strictStartDate, .strictEndDate])
        let quantity: HKQuantity? = try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: options) { _, statistics, error in
                if let error { continuation.resume(throwing: error); return }
                continuation.resume(returning: cumulative ? statistics?.sumQuantity() : statistics?.averageQuantity())
            }
            store.execute(query)
        }
        guard let quantity else { return nil }
        let value = quantity.doubleValue(for: unit)
        guard value.isFinite else { return nil }
        return "\(cumulative ? "Total" : "Average") \(value.formatted(.number.precision(.fractionLength(0...2)))) \(unit.unitString) · records wholly within this period"
    }

    private func samples(_ type: HKSampleType, window: HealthReadWindow) async throws -> [HKSample] {
        let predicate = HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: [])
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: Self.recordLimit,
                                      sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)]) { _, samples, error in
                if let error { continuation.resume(throwing: error); return }
                continuation.resume(returning: samples ?? [])
            }
            store.execute(query)
        }
    }

    func activity(window: HealthReadWindow) async -> HealthSummary {
        let type = HKObjectType.activitySummaryType()
        do {
            let calendar = Calendar.current
            let start = calendar.dateComponents([.era, .year, .month, .day], from: window.start)
            let end = calendar.dateComponents([.era, .year, .month, .day], from: window.end)
            let predicate = HKQuery.predicate(forActivitySummariesBetweenStart: start, end: end)
            let summaries: [HKActivitySummary] = try await withCheckedThrowingContinuation { continuation in
                let query = HKActivitySummaryQuery(predicate: predicate) { _, summaries, error in
                    if let error { continuation.resume(throwing: error); return }
                    continuation.resume(returning: summaries ?? [])
                }
                store.execute(query)
            }
            let minutes = summaries.reduce(0) { $0 + $1.appleExerciseTime.doubleValue(for: .minute()) }
            let energy = summaries.reduce(0) { $0 + $1.activeEnergyBurned.doubleValue(for: .kilocalorie()) }
            let stand = summaries.reduce(0) { $0 + $1.appleStandHours.doubleValue(for: .count()) }
            let detail = summaries.isEmpty ? Self.noData : "\(summaries.count) days of activity rings · totals: \(energy.formatted(.number.precision(.fractionLength(0)))) active kcal, \(minutes.formatted(.number.precision(.fractionLength(0)))) exercise minutes, \(stand.formatted(.number.precision(.fractionLength(0)))) stand hours"
            return HealthSummary(id: type.identifier, title: "Activity rings", detail: detail, hasData: !summaries.isEmpty)
        } catch {
            return HealthSummary(id: type.identifier, title: "Activity rings", detail: "Couldn't read activity rings. Try again when your iPhone is unlocked.", hasData: false)
        }
    }
}
