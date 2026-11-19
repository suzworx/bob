import Foundation
import Observation

public struct ToolGroup: Identifiable, Sendable {
    public let id: String
    public let tools: [ToolEntry]
}

@MainActor @Observable public final class ToolsModel {
    public enum Phase: Equatable, Sendable { case loading, loaded, failed(ApiError) }
    public let context: ToolContext
    public var query = ""
    public private(set) var catalog: ToolCatalog?
    public private(set) var phase: Phase = .loading
    public private(set) var busyID: String?
    public private(set) var saveError: ApiError?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let read: @Sendable (ToolContext) async throws -> ToolCatalog
    @ObservationIgnored private let write: @Sendable (ToolScopeRef, String, Bool?) async throws -> ToolCatalog

    public init(context: ToolContext, read: @escaping @Sendable (ToolContext) async throws -> ToolCatalog, write: @escaping @Sendable (ToolScopeRef, String, Bool?) async throws -> ToolCatalog) {
        self.context = context; self.read = read; self.write = write
    }

    public var groups: [ToolGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matching = (catalog?.tools ?? []).filter {
            needle.isEmpty || "\($0.name) \($0.group) \($0.toolName)".localizedCaseInsensitiveContains(needle)
        }
        var names: [String] = []
        for tool in matching where !names.contains(tool.group) { names.append(tool.group) }
        return names.map { name in ToolGroup(id: name, tools: matching.filter { $0.group == name }) }
    }

    public func refresh() async {
        guard busyID == nil else { return }
        generation += 1
        let request = generation
        phase = .loading
        catalog = nil
        saveError = nil
        do {
            let result = try await read(context)
            guard isCurrent(request) else { return }
            catalog = result
            phase = .loaded
        } catch {
            guard isCurrent(request), !isCancellation(error) else { return }
            phase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }

    public func save(toolID: String, enabled: Bool?) async {
        guard phase == .loaded, let catalog, catalog.canEdit, busyID == nil,
              let tool = catalog.tools.first(where: { $0.id == toolID }) else { return }
        if enabled == nil {
            guard tool.preference != nil else { return }
        } else {
            guard tool.disabledReason(in: catalog) == nil else { return }
        }
        let request = generation
        busyID = toolID
        saveError = nil
        defer { if request == generation { busyID = nil } }
        do {
            let result = try await write(catalog.scope, toolID, enabled)
            guard isCurrent(request) else { return }
            guard result.scope == catalog.scope else { throw ApiError.unknown(status: 200) }
            self.catalog = result
        } catch {
            guard isCurrent(request), !isCancellation(error) else { return }
            saveError = (error as? ApiError) ?? .unknown(status: 0)
        }
    }

    public func cancel() { generation += 1; busyID = nil }
    private func isCurrent(_ request: Int) -> Bool { request == generation && !Task.isCancelled }
    private func isCancellation(_ error: Error) -> Bool { error is CancellationError || (error as? ApiError) == .cancelled }
}
