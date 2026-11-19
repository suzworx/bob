import Foundation
import Observation

@MainActor @Observable public final class BobAppsModel {
    public enum Phase: Equatable { case loading, loaded, failed(ApiError) }
    public let spaceID: String?
    public let appID: String?
    public private(set) var apps: [BobAppSummary] = []
    public private(set) var app: SavedBobApp?
    public private(set) var nextCursor: String?
    public private(set) var phase: Phase = .loading
    public private(set) var busy = false
    public private(set) var message: String?
    public private(set) var refreshState: BobAppRefresh?
    public private(set) var runs: [BobAppRun] = []
    public private(set) var refreshError: ApiError?
    @ObservationIgnored private let client: BobAppsClient?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var mutationKey = ""
    @ObservationIgnored private var mutationID = UUID()

    public init(client: BobAppsClient?, spaceID: String? = nil, appID: String? = nil) { self.client = client; self.spaceID = spaceID; self.appID = appID }
    public var editable: Bool { phase == .loaded && app?.lifecycle == .active && (app?.spaceId != nil || refreshState != nil) }
    public var lockedTable: String? { refreshState?.enabled == true ? refreshState?.config?.targetTable : nil }
    public var isDemo: Bool { client == nil }

    public func load() async {
        guard !busy else { return }
        generation += 1; let request = generation
        phase = .loading; message = nil
        guard let client else { phase = .loaded; return }
        do {
            if let appID {
                let result = try await client.get(appID)
                guard result.spaceId == spaceID else { throw ApiError.notFound }
                guard current(request) else { return }
                app = result
                await loadRefresh(client: client, app: result, request: request)
            } else {
                let result = try await client.list(spaceID: spaceID)
                guard current(request) else { return }
                apps = result.apps; nextCursor = result.nextCursor
            }
            guard current(request) else { return }; phase = .loaded
        } catch {
            guard current(request), !cancelled(error) else { return }
            app = nil; apps = []; nextCursor = nil; refreshState = nil
            phase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }
    public func more() async {
        guard let client, let cursor = nextCursor, !busy else { return }
        busy = true; let request = generation
        defer { if request == generation { busy = false } }
        do {
            let page = try await client.list(spaceID: spaceID, cursor: cursor)
            guard current(request) else { return }
            let known = Set(apps.map(\.id)); apps += page.apps.filter { !known.contains($0.id) }
            nextCursor = page.nextCursor == cursor ? nil : page.nextCursor; message = nil
        } catch { if current(request), !cancelled(error) { message = "Couldn't load more apps. Your list is still here; try again." } }
    }
    public func create(_ starter: BobAppDefinition.Starter) async -> SavedBobApp? {
        guard let client else { message = "Sign in to save your first app."; return nil }
        return await perform(key: "create:\(starter.rawValue)") { id in try await client.create(.starter(starter), spaceID: self.spaceID, mutationID: id) }
    }
    public func change(_ operation: BobAppOperation) async -> SavedBobApp? {
        guard phase == .loaded, let client, let app, app.canManage || operation == .duplicate else { return nil }
        return await perform(key: "\(app.id):\(app.revision):\(operation.rawValue)") { id in try await client.change(app, operation: operation, mutationID: id) }
    }
    public func act(_ command: BobAppCommand, revision: Int) async -> Bool {
        guard let client, let app, editable, let action = app.definition.actions.first(where: { $0.id == command.action }), action.table != lockedTable else { return false }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let key = "\(app.id):\(revision):\(String(data: (try? encoder.encode(command)) ?? Data(), encoding: .utf8) ?? command.id)"
        return await perform(key: key) { id in try await client.act(app, command: command, expectedRevision: revision, mutationID: id) } != nil
    }
    public func delete() async -> Bool {
        guard phase == .loaded, let client, let app, app.canManage, !busy else { return false }
        busy = true; let request = generation
        defer { if request == generation { busy = false } }
        do { try await client.delete(app, mutationID: mutation(for: "delete:\(app.revision)")); guard current(request) else { return false }; self.app = nil; mutationKey = ""; return true }
        catch { if current(request), !cancelled(error) { message = Self.problem(error) }; return false }
    }
    public func export() async -> Data? {
        guard let client, let app, !busy else { return nil }
        busy = true; let request = generation; defer { if request == generation { busy = false } }
        do { let data = try await client.export(app.id); return current(request) ? data : nil }
        catch { if current(request), !cancelled(error) { message = "Couldn't export this app. Try again." }; return nil }
    }
    public func conversation() async -> BobAppConversation? {
        guard let client, let app, let spaceID = app.spaceId, !busy else { return nil }
        busy = true; let request = generation; defer { if request == generation { busy = false } }
        do {
            let result = try await client.openConversation(app.id)
            guard current(request) else { return nil }
            guard result.spaceId == spaceID else { throw ApiError.forbidden }; return result
        } catch { if current(request), !cancelled(error) { message = "Couldn't open this app's conversation. Try again." }; return nil }
    }
    public func configure(enabled: Bool, config: BobAppRefreshConfig?) async -> Bool {
        guard phase == .loaded, let client, let app, app.canManage, app.spaceId == nil, app.lifecycle == .active, !busy else { return false }
        busy = true; let request = generation; defer { if request == generation { busy = false } }
        do {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let encoded = String(data: (try? encoder.encode(config)) ?? Data(), encoding: .utf8) ?? "null"
            let key = "refresh:\(app.id):\(app.revision):\(enabled):\(encoded)"
            let state = try await client.configure(app, enabled: enabled, config: config, mutationID: mutation(for: key))
            guard current(request) else { return false }; refreshState = state
            let updated = try await client.get(app.id); guard current(request) else { return false }; self.app = updated; message = nil; mutationKey = ""; return true
        } catch { if current(request), !cancelled(error) { message = Self.problem(error) }; return false }
    }
    public func cancel() { generation += 1; busy = false }
    private func perform(key: String, action: (UUID) async throws -> SavedBobApp) async -> SavedBobApp? {
        guard !busy else { return nil }; generation += 1; busy = true; message = nil
        let request = generation; defer { if request == generation { busy = false } }
        do {
            let result = try await action(mutation(for: key))
            guard current(request) else { return nil }
            guard result.spaceId == spaceID else { throw ApiError.forbidden }
            if appID == result.id { app = result }; mutationKey = ""; return result
        } catch {
            guard current(request), !cancelled(error) else { return nil }
            // A lost success must keep its original revision and receipt for a safe retry.
            // Only a definite conflict or access refusal warrants an automatic read-back.
            if Self.needsReadback(error), let client, let appID {
                do {
                    let latest = try await client.get(appID)
                    guard current(request) else { return nil }
                    guard latest.spaceId == spaceID else { throw ApiError.forbidden }; app = latest
                } catch {
                    guard current(request) else { return nil }
                    if (error as? ApiError) == .forbidden || (error as? ApiError) == .notFound { app = nil; phase = .failed((error as? ApiError) ?? .notFound) }
                }
            }
            message = Self.problem(error); return nil
        }
    }
    private func loadRefresh(client: BobAppsClient, app: SavedBobApp, request: Int) async {
        guard app.spaceId == nil else { refreshState = nil; return }
        do {
            async let state = client.refresh(app.id); async let history = client.runs(app.id)
            let result = try await (state, history); guard current(request) else { return }
            refreshState = result.0; runs = result.1; refreshError = nil
        } catch { if current(request), !cancelled(error) { refreshState = nil; refreshError = (error as? ApiError) ?? .unknown(status: 0) } }
    }
    private func mutation(for key: String) -> UUID { if mutationKey != key { mutationKey = key; mutationID = UUID() }; return mutationID }
    private func current(_ request: Int) -> Bool { request == generation && !Task.isCancelled }
    private func cancelled(_ error: Error) -> Bool { error is CancellationError || (error as? ApiError) == .cancelled }
    private static func needsReadback(_ error: Error) -> Bool {
        error is RevisionConflict || (error as? ApiError) == .unknown(status: 409)
            || (error as? ApiError) == .forbidden || (error as? ApiError) == .notFound
    }
    private static func problem(_ error: Error) -> String {
        if (error as? ApiError) == .unknown(status: 409) || error is RevisionConflict { return "This app changed elsewhere. Your edits are still here. Review the latest saved data before saving again." }
        return "Couldn't confirm that change. Your edits are still here. Try again to confirm it, or refresh to review the latest saved data."
    }
}
