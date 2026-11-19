import BobKit
import Foundation
import Observation

@MainActor @Observable final class RoutinesModel {
    private(set) var routines: [Routine] = []
    private(set) var accounts: [GoogleIntegrationAccount] = []
    private(set) var loading = true
    private(set) var busy = false
    private(set) var error: String?
    private(set) var hasConflict = false
    @ObservationIgnored private var generation = 0
    @ObservationIgnored let client = AppSession.make { RoutinesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
    @ObservationIgnored private let connections = AppSession.make { GoogleIntegrationsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }

    var eligibleAccounts: [GoogleIntegrationAccount] { accounts.filter { $0.access.contains(.mailRead) && !$0.needsReconnect } }

    func refresh() async {
        guard !busy else { return }
        generation += 1
        let request = generation
        loading = routines.isEmpty
        error = nil
        do {
            if let client, let connections {
                async let rows = client.list()
                async let accounts = connections.accounts()
                let result = try await (rows, accounts)
                guard request == generation, !Task.isCancelled else { return }
                routines = result.0
                self.accounts = result.1
            } else {
                #if !DEBUG
                throw ApiError.unauthenticated
                #endif
            }
            loading = false
            hasConflict = false
        } catch {
            guard request == generation, !Task.isCancelled else { return }
            loading = false
            if (error as? ApiError) != .cancelled { self.error = Self.message(error) }
        }
    }

    func save(_ draft: RoutineDraft, editing routine: Routine?) async -> Bool {
        guard let client, !busy else { return false }
        busy = true
        generation += 1
        error = nil
        hasConflict = false
        defer { busy = false }
        do {
            let saved: Routine
            if let routine { saved = try await client.update(routine, draft: draft) }
            else { saved = try await client.create(draft) }
            generation += 1
            if let index = routines.firstIndex(where: { $0.id == saved.id }) { routines[index] = saved }
            else { routines.append(saved) }
            return true
        } catch { record(error); return false }
    }

    func toggle(_ routine: Routine) async {
        guard let client, !busy else { return }
        busy = true
        generation += 1
        error = nil
        hasConflict = false
        defer { busy = false }
        do {
            let saved = try await client.setStatus(id: routine.id, revision: routine.revision, status: routine.status == .active ? .paused : .active)
            generation += 1
            if let index = routines.firstIndex(where: { $0.id == saved.id }) { routines[index] = saved }
        } catch { record(error) }
    }

    func archive(_ routine: Routine) async {
        guard let client, !busy else { return }
        busy = true
        generation += 1
        error = nil
        hasConflict = false
        defer { busy = false }
        do {
            try await client.archive(id: routine.id, revision: routine.revision)
            busy = false
            await refresh()
        } catch { record(error) }
    }

    private func record(_ error: Error) {
        hasConflict = error is RevisionConflict || (error as? ApiError) == .unknown(status: 409)
        self.error = Self.message(error)
    }

    static func message(_ error: Error) -> String {
        if error is RevisionConflict || (error as? ApiError) == .unknown(status: 409) {
            return "This routine changed elsewhere. Load the latest version and review your changes before saving."
        }
        if (error as? ApiError) == .forbidden {
            return "Your Google connection needs attention. Check Gmail access in Integrations, then try again."
        }
        return ApiErrorMapper.userMessage((error as? ApiError) ?? .unknown(status: 0))
    }
}
