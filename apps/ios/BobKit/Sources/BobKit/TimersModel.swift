import Foundation
import Observation

public struct RunningTimer: Identifiable, Equatable, Sendable {
    public let timer: TimerSummary
    public let deadline: TimeInterval
    public var id: String { timer.id }
    public func remaining(at instant: TimeInterval) -> Double { max(0, (deadline - instant) * 1_000) }
    public func countdown(at instant: TimeInterval) -> String { Self.format(milliseconds: remaining(at: instant)) }
    public static func format(milliseconds: Double) -> String {
        let total = Int(min(Double(Int.max / 2), max(0, ceil(milliseconds / 1_000))))
        let seconds = String(format: "%02d", total % 60)
        return total >= 3_600 ? "\(total / 3_600):\(String(format: "%02d", (total % 3_600) / 60)):\(seconds)" : "\(total / 60):\(seconds)"
    }
}

@MainActor @Observable public final class TimersModel {
    public enum Phase: Equatable { case loading, loaded, failed(ApiError) }
    public private(set) var timers: [RunningTimer] = []
    public private(set) var phase: Phase = .loading
    public private(set) var now: TimeInterval
    public private(set) var refreshing = false
    public private(set) var cancellingID: String?
    public private(set) var actionError: ApiError?
    @ObservationIgnored private let read: @Sendable () async throws -> [TimerSummary]
    @ObservationIgnored private let cancelTimer: @Sendable (String) async throws -> Void
    @ObservationIgnored private let clock: @MainActor () -> TimeInterval
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var expiryChecks: [String: Int] = [:]
    @ObservationIgnored private var nextExpiryRead: TimeInterval = 0

    public init(read: @escaping @Sendable () async throws -> [TimerSummary], cancel: @escaping @Sendable (String) async throws -> Void, now: @escaping @MainActor () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.read = read; cancelTimer = cancel; clock = now; self.now = now()
    }
    public func refresh() async {
        guard cancellingID == nil else { return }
        generation += 1
        let request = generation
        refreshing = true
        if timers.isEmpty { phase = .loading }
        defer { if request == generation { refreshing = false } }
        do {
            let rows = try await read()
            guard current(request) else { return }
            let received = clock()
            timers = rows.map { RunningTimer(timer: $0, deadline: received + Double($0.remainingMilliseconds) / 1_000) }
            let present = Set(rows.map(\.id))
            expiryChecks = expiryChecks.filter { present.contains($0.key) }
            now = received; phase = .loaded; actionError = nil
        } catch {
            guard current(request), !cancelled(error) else { return }
            phase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }
    /// Called only while the Calendar is visible and the app is active. No background scheduler.
    public func tick() async {
        now = clock()
        guard !refreshing, cancellingID == nil, now >= nextExpiryRead else { return }
        let due = timers.filter { $0.deadline <= now && expiryChecks[$0.id, default: 0] < 3 }
        guard !due.isEmpty else { return }
        for timer in due { expiryChecks[timer.id, default: 0] += 1 }
        nextExpiryRead = now + 2
        await refresh()
    }
    public func cancel(_ id: String) async {
        guard cancellingID == nil, timers.contains(where: { $0.id == id }) else { return }
        // Invalidate any older list read so it cannot resurrect the cancelled row.
        generation += 1
        let request = generation
        refreshing = false; cancellingID = id; actionError = nil
        defer { if request == generation { cancellingID = nil } }
        do {
            try await cancelTimer(id)
            guard current(request) else { return }
            timers.removeAll { $0.id == id }; expiryChecks[id] = nil
            phase = .loaded
        } catch {
            guard current(request), !cancelled(error) else { return }
            actionError = (error as? ApiError) ?? .unknown(status: 0)
        }
    }
    public func stop() { generation += 1; refreshing = false; cancellingID = nil }
    private func current(_ request: Int) -> Bool { request == generation && !Task.isCancelled }
    private func cancelled(_ error: Error) -> Bool { error is CancellationError || (error as? ApiError) == .cancelled }
}
