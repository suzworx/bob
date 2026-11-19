import Foundation
import Observation

@MainActor public protocol GoogleAuthorizationBrowser: AnyObject {
    func open(_ url: URL) async throws -> URL
    func cancel()
}

public struct GoogleAuthorizationContext: Sendable {
    public let service: any GoogleAuthorizationService
    public let isCurrent: @Sendable () async -> Bool
    public init(service: any GoogleAuthorizationService, isCurrent: @escaping @Sendable () async -> Bool) {
        self.service = service; self.isCurrent = isCurrent
    }
}

@MainActor @Observable public final class GoogleAuthorizationModel {
    public enum State: Equatable, Sendable {
        case choosing, authorizing, connecting, cancelling, retryable, completed, cancelled, failed, expired
    }
    public private(set) var state: State = .choosing
    public private(set) var connectedAccount: GoogleIntegrationAccount?
    public private(set) var error: ApiError?
    public var busy: Bool { [.authorizing, .connecting, .cancelling].contains(state) }
    @ObservationIgnored private let browser: any GoogleAuthorizationBrowser
    @ObservationIgnored private let context: @MainActor () async throws -> GoogleAuthorizationContext
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let sleep: @Sendable (Int) async throws -> Void
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pending: Pending?
    @ObservationIgnored private var retryCancellationState: State?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?

    private struct Pending {
        let attempt: GoogleAuthorizationAttempt
        let proof: GoogleAuthorizationProof
        let context: GoogleAuthorizationContext
    }

    public init(browser: any GoogleAuthorizationBrowser,
                now: @escaping @Sendable () -> Date = { Date() },
                sleep: @escaping @Sendable (Int) async throws -> Void = { try await Task.sleep(for: .milliseconds($0)) },
                context: @escaping @MainActor () async throws -> GoogleAuthorizationContext) {
        self.browser = browser; self.context = context; self.now = now; self.sleep = sleep
    }

    public func connect(capabilities: [GoogleCapability], reconnectAccountID: String?) async {
        guard !busy, pending == nil, !capabilities.isEmpty else { return }
        generation += 1
        let request = generation
        state = .authorizing; error = nil; connectedAccount = nil; retryCancellationState = nil
        do {
            let context = try await context()
            guard await current(request, context) else { return }
            let proof = GoogleAuthorizationProof.random()
            let attempt = try await context.service.authorize(capabilities: capabilities, reconnectAccountID: reconnectAccountID, challenge: proof.challenge)
            let value = Pending(attempt: attempt, proof: proof, context: context)
            guard await current(request, context) else { await discard(value); return }
            try attempt.validate()
            pending = value
            guard attempt.expiresAt > now() else { await expire(request); return }
            startExpiry(attempt.expiresAt, request: request)
            let callback = try await browser.open(attempt.url)
            guard await current(request, context) else { return }
            let outcome = try GoogleAuthorizationCallback.parse(callback, expectedState: attempt.state)
            if outcome == .returned { await finish(value, request: request) }
            else { await terminate(value, request: request, desired: outcome == .cancelled ? .cancelled : .failed) }
        } catch {
            guard request == generation else { return }
            let cancelled = error is CancellationError || (error as? ApiError) == .cancelled
            if let pending { await terminate(pending, request: request, desired: cancelled ? .cancelled : .failed) }
            else { state = cancelled ? .cancelled : .failed }
            if !cancelled && state != .completed { self.error = (error as? ApiError) ?? .unknown(status: 0) }
        }
    }

    public func retryCompletion() async {
        guard state == .retryable, let pending else { return }
        error = nil
        if let desired = retryCancellationState { await terminate(pending, request: generation, desired: desired) }
        else { await finish(pending, request: generation) }
    }

    public func cancel() async {
        generation += 1
        let request = generation
        expiryTask?.cancel(); expiryTask = nil
        browser.cancel()
        guard let pending else { state = .cancelled; return }
        state = .cancelling
        await terminate(pending, request: request, desired: .cancelled)
    }

    /// Dismissal/logout suppresses late results; cleanup still uses the captured session.
    public func invalidate() {
        generation += 1
        expiryTask?.cancel(); expiryTask = nil
        browser.cancel()
        let abandoned = pending
        pending = nil; retryCancellationState = nil
        state = .cancelled; connectedAccount = nil
        if let abandoned { Task { await discard(abandoned) } }
    }

    private func current(_ request: Int, _ context: GoogleAuthorizationContext) async -> Bool {
        guard request == generation, !Task.isCancelled else { return false }
        let matches = await context.isCurrent()
        guard request == generation, !Task.isCancelled else { return false }
        if !matches { invalidate(); return false }
        return true
    }

    private func finish(_ value: Pending, request: Int) async {
        guard await current(request, value.context) else { return }
        state = .connecting
        // A bounded check loop; the server also limits an in-progress claim to 45 seconds.
        let deadline = min(value.attempt.expiresAt, now().addingTimeInterval(50))
        do {
            for _ in 0..<60 {
                guard await current(request, value.context) else { return }
                guard now() < value.attempt.expiresAt else { await expire(request); return }
                let result = try await value.context.service.complete(attempt: value.attempt, proof: value.proof)
                guard await current(request, value.context) else { return }
                if case .processing(let milliseconds) = result {
                    if now() >= deadline { state = .retryable; return }
                    try await sleep(milliseconds)
                } else { apply(result); return }
            }
            state = .retryable
        } catch {
            guard await current(request, value.context) else { return }
            self.error = (error as? ApiError) ?? .unknown(status: 0)
            if self.error == .unauthenticated || self.error == .notFound {
                clear(); state = .failed
            } else { state = .retryable }
        }
    }

    private func terminate(_ value: Pending, request: Int, desired: State) async {
        guard await current(request, value.context) else { return }
        retryCancellationState = desired
        do {
            let result = try await value.context.service.cancel(attempt: value.attempt, proof: value.proof)
            guard await current(request, value.context) else { return }
            switch result {
            case .completed: apply(result)
            case .processing: state = .retryable
            default: clear(); state = desired
            }
        } catch {
            guard await current(request, value.context) else { return }
            self.error = (error as? ApiError) ?? .unknown(status: 0)
            if self.error == .unauthenticated || self.error == .notFound { clear(); state = .failed }
            else { state = .retryable }
        }
    }

    private func apply(_ result: GoogleAuthorizationResult) {
        switch result {
        case .completed(let account): clear(); connectedAccount = account; state = .completed
        case .failed: clear(); state = .failed
        case .cancelled: clear(); state = .cancelled
        case .expired: clear(); state = .expired
        case .processing: break
        }
    }
    private func clear() { pending = nil; retryCancellationState = nil; expiryTask?.cancel(); expiryTask = nil }
    private func discard(_ value: Pending) async {
        guard await value.context.isCurrent() else { return }
        _ = try? await value.context.service.cancel(attempt: value.attempt, proof: value.proof)
    }
    private func startExpiry(_ date: Date, request: Int) {
        expiryTask?.cancel()
        let delay = max(0, date.timeIntervalSince(now()))
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            await self?.expire(request)
        }
    }
    private func expire(_ request: Int) async {
        guard generation == request else { return }
        generation += 1
        expiryTask = nil
        browser.cancel()
        guard let pending else { state = .expired; return }
        state = .cancelling
        await terminate(pending, request: generation, desired: .expired)
    }
}
