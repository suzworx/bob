import BobKit
import Foundation
import Observation

// Holds the Today screen's state and refreshes it from the provider.
@MainActor @Observable final class TodayViewModel {
    private(set) var state: TodayState = .loading

    private let provider: TodayProviding
    private let clock: () -> Date
    private var isRefreshing = false

    init(provider: TodayProviding, clock: @escaping () -> Date, state: TodayState = .loading) {
        self.provider = provider
        self.clock = clock
        self.state = state
    }

    // The moment the screen is drawn for, used for the greeting and the date line.
    var now: Date { state.content?.loadedAt ?? clock() }

    // A refresh started while another runs does nothing.
    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        let result: Result<TodayContent, ApiError>
        do {
            result = .success(try await provider.load(now: clock()))
        } catch ApiError.cancelled {
            // A cancelled load, such as a pull to refresh let go early, keeps what is on screen.
            return
        } catch let error as ApiError {
            result = .failure(error)
        } catch is CancellationError {
            return
        } catch {
            result = .failure(.unknown(status: 0))
        }
        state = state.afterRefresh(result)
    }
}
