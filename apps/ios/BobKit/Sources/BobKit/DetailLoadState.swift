import Foundation
import Observation

// A deep link resolves its exact target independently of a paginated list.
// Absence from the list is never evidence that the target was deleted.
@MainActor @Observable public final class DetailLoadState {
    public enum Phase: Equatable, Sendable {
        case loading
        case loaded
        case failed(ApiError)
    }

    public private(set) var phase: Phase = .loading
    private var generation = 0

    public init() {}

    public func load(_ operation: @MainActor () async throws -> Void) async {
        generation += 1
        let request = generation
        phase = .loading
        do {
            try await operation()
            try Task.checkCancellation()
            guard request == generation else { return }
            phase = .loaded
        } catch {
            guard request == generation, !Task.isCancelled, !(error is CancellationError) else { return }
            let failure: ApiError
            if let error = error as? ApiError { failure = error }
            else if let error = error as? URLError { failure = ApiErrorMapper.mapTransport(error.code) }
            else { failure = .unknown(status: 0) }
            guard failure != .cancelled else { return }
            phase = .failed(failure)
        }
    }
}
