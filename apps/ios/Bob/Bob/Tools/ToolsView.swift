import BobKit
import SwiftUI

// Each context gets its own request lifetime and confirmed settings.
struct ToolsView: View {
    var context: ToolContext = .account
    var title = "Tools"

    var body: some View {
        ToolControlsView(context: context)
            .id(context)
            .bobNavTitle(title)
    }
}

struct ToolsSheet: View {
    var context: ToolContext
    var title = "Tools"
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ToolsView(context: context, title: title)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                }
        }
        .bobSheet()
    }
}

private struct ToolControlsView: View {
    @State private var model: ToolsModel

    init(context: ToolContext) { _model = State(initialValue: ToolsServices.make(context: context)) }

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView("Opening your tools…")
                    .frame(maxWidth: .infinity, minHeight: 100)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load these tool settings", error: error) { await model.refresh() }
                    .bobListRow(divider: false)
            case .loaded:
                if let catalog = model.catalog { controls(catalog) }
            }
        }
        .bobList()
        .privacySensitive()
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a tool")
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .onDisappear { model.cancel() }
    }

    @ViewBuilder private func controls(_ catalog: ToolCatalog) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Changes apply to \(catalog.scope.scope.label). Turning a tool on still requires access to its data.")
                .font(BobFont.subline).foregroundStyle(.secondary)
            if !catalog.canEdit && !catalog.tools.isEmpty {
                Text("Only the owner or a space admin can change these settings.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 12)
        .bobListRow(divider: false)
        if model.saveError != nil {
            VStack(alignment: .leading, spacing: 6) {
                Text("Couldn't confirm that change.").font(BobFont.rowTitle)
                Text("Your last confirmed settings are shown. Try the change again, or refresh to check.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                Button("Refresh settings") { Task { await model.refresh() } }
                    .frame(minHeight: 44)
            }
            .bobListRow(divider: false)
        }
        if catalog.tools.isEmpty {
            ContentUnavailableView("No tools to show yet", systemImage: "slider.horizontal.3", description: Text("Your available tools appear here after you sign in and your account is ready."))
                .bobListRow(divider: false)
        } else if model.groups.isEmpty {
            ContentUnavailableView.search(text: model.query).bobListRow(divider: false)
        }
        ForEach(model.groups) { group in
            BobGroupHeader(title: group.id)
            ForEach(group.tools) { tool in
                ToolSettingRow(tool: tool, catalog: catalog, busyID: model.busyID) { value in
                    Task { await model.save(toolID: tool.id, enabled: value) }
                }
                .bobListRow()
            }
        }
    }
}

private struct ToolSettingRow: View {
    let tool: ToolEntry
    let catalog: ToolCatalog
    let busyID: String?
    let save: (Bool?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { tool.enabled }, set: { save($0) })) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(tool.name).font(BobFont.rowTitle)
                    Text(tool.description).font(BobFont.subline).foregroundStyle(.secondary)
                }
            }
            .tint(BobColor.accent)
            .disabled(busyID != nil || tool.disabledReason(in: catalog) != nil)
            .accessibilityHint(tool.disabledReason(in: catalog) ?? "Changes this tool for \(catalog.scope.scope.label)")
            if let reason = tool.disabledReason(in: catalog) {
                Text(reason).font(BobFont.subline).foregroundStyle(.secondary)
            }
            if busyID == tool.id { ProgressView("Saving…").font(BobFont.subline) }
            if tool.preference != nil {
                Button("Use inherited setting") { save(nil) }
                    .font(BobFont.subline)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Use inherited setting for \(tool.name)")
                    .disabled(busyID != nil || !catalog.canEdit)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 8)
    }
}

@MainActor private enum ToolsServices {
    static func make(context: ToolContext) -> ToolsModel {
        if let client = AppSession.make({ ToolsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) {
            return ToolsModel(context: context, read: { try await client.catalog(context: $0) }, write: { try await client.set(scope: $0, toolID: $1, enabled: $2) })
        }
        #if DEBUG
        return ToolsModel(context: context, read: { _ in ToolCatalog(scope: ToolScopeRef(scope: .account, scopeID: "demo"), canEdit: false, tools: []) }, write: { _, _, _ in throw ApiError.unauthenticated })
        #else
        return ToolsModel(context: context, read: { _ in throw ApiError.unauthenticated }, write: { _, _, _ in throw ApiError.unauthenticated })
        #endif
    }
}
