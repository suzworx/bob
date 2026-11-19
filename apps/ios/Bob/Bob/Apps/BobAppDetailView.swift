import BobKit
import SwiftUI
import UniformTypeIdentifiers

struct BobAppDetailView: View {
    let askBob: (String) -> Void
    let openConversation: (BobAppConversation) -> Void
    @State private var model: BobAppsModel
    @State private var deleting = false
    @State private var preview = false
    @State private var improvementApp: SavedBobApp?
    @State private var improvement = BobAppImprovementSession()
    @State private var exportDocument: BobAppDocument?
    @State private var exporting = false
    @State private var exportFailed = false
    @State private var duplicateID: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    init(id: String, spaceID: String?, askBob: @escaping (String) -> Void, openConversation: @escaping (BobAppConversation) -> Void) {
        self.askBob = askBob; self.openConversation = openConversation
        _model = State(initialValue: BobAppsServices.make(spaceID: spaceID, appID: id))
    }
    var body: some View {
        List {
            switch model.phase {
            case .loading: ProgressView("Opening your app…").bobListRow(divider: false)
            case .failed(let error): BobLoadFailure(title: "Couldn't open this app", error: error) { await model.load() }.bobListRow(divider: false)
            case .loaded: if let app = model.app { content(app) }
            }
            if let message = model.message { Text(message).font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow(divider: false) }
            if exportFailed { Text("Couldn’t save the export. Please try again.").font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow(divider: false) }
        }
        .bobList().bobNavTitle(model.app?.definition.title ?? "App").privacySensitive()
        .task { await model.load() }.refreshable { await model.load() }.onDisappear { model.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.load() } } }
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Reload latest app data").disabled(model.busy) } }
        .confirmationDialog("Delete this app permanently?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete app", role: .destructive) { Task { if await model.delete() { dismiss() } } }
        } message: { Text("This deletes its saved records and update history. Export a copy first if you'd like to keep it.") }
        .sheet(isPresented: $preview) {
            if let app = model.app, let definition = app.pendingDefinition {
                NavigationStack {
                    List {
                        BobAppDefinitionSummary(definition: definition)
                        Text("Your saved records stay intact. Incompatible changes cannot be applied. You can undo this definition change.").font(BobFont.body).bobListRow(divider: false)
                        BobAppRenderer(definition: definition, state: app.state, metrics: definition.previewMetrics(app.state))
                        if app.canManage { Button("Apply changes") { Task { if await model.change(.applyRevision) != nil { preview = false } } }.disabled(model.busy).bobListRow() }
                        if let message = model.message { Text(message).foregroundStyle(BobColor.dangerText).bobListRow(divider: false) }
                    }.bobList().bobNavTitle("Review proposed changes").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { preview = false } } }
                }.bobSheet()
            }
        }
        .onChange(of: improvement.model?.isIdle) { oldValue, newValue in
            if oldValue == false, newValue == true { Task { await model.load() } }
        }
        .onChange(of: improvement.model?.bobThinking) { oldValue, newValue in
            if oldValue == true, newValue == false { Task { await model.load() } }
        }
        .fullScreenCover(item: $improvementApp, onDismiss: { Task { await model.load() } }) { app in
            BobAppImprovementView(app: app, session: improvement)
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "bob-app") { result in if case .failure = result { exportFailed = true } }
        .navigationDestination(item: $duplicateID) { id in BobAppDetailView(id: id, spaceID: model.spaceID, askBob: askBob, openConversation: openConversation) }
    }
    @ViewBuilder private func content(_ app: SavedBobApp) -> some View {
        Text("\(BobAppDefinition.label(app.lifecycle.rawValue)) · Updated \(app.updatedAt.formatted(date: .abbreviated, time: .shortened))").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
        if app.lifecycle == .draft {
            Text("Your app is ready for a look. Check its data and actions, then activate it when you're happy.").font(BobFont.body).bobListRow(divider: false)
            BobAppDefinitionSummary(definition: app.definition)
            if app.canManage { action("Activate app", .activate) }
        }
        if app.pendingDefinition != nil { Button("Review proposed changes") { preview = true }.bobListRow() }
        if app.lifecycle != .active { Text("Activate or resume this app to edit its records.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false) }
        BobAppRenderer(definition: app.definition, state: app.state, metrics: app.metrics, model: model)
        BobGroupHeader(title: "Your app")
        Button("Change with Bob") { improvementApp = app }
            .disabled(model.busy || (app.lifecycle != .active && app.lifecycle != .draft)).bobListRow()
        if app.spaceId == nil {
            Button("Duplicate app") { Task { duplicateID = await model.change(.duplicate)?.id } }.disabled(model.busy).bobListRow()
        }
        Button("Export JSON") { exportFailed = false; Task { if let data = await model.export() { exportDocument = BobAppDocument(data: data); exporting = true } } }.disabled(model.busy).bobListRow()
        if app.canManage {
            if app.canUndo { action("Undo last change", .undo) }
            if app.lifecycle == .active { action("Pause app", .pause) }
            if app.lifecycle == .paused { action("Resume app", .resume) }
            action(app.lifecycle == .archived ? "Restore app" : "Archive app", app.lifecycle == .archived ? .restore : .archive)
            Button("Delete app", role: .destructive) { deleting = true }.disabled(model.busy).bobListRow()
        }
        if app.spaceId == nil { BobAppRefreshSection(model: model, app: app) }
    }
    private func action(_ label: String, _ operation: BobAppOperation) -> some View {
        Button(label) { Task { _ = await model.change(operation) } }.disabled(model.busy).bobListRow()
    }
}

struct BobAppDefinitionSummary: View {
    let definition: BobAppDefinition
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(definition.title).font(BobFont.heading)
            Text("Views: \(definition.views.map(\.title).joined(separator: ", "))")
            ForEach(definition.tables) { table in Text("\(BobAppDefinition.label(table.id)): \(table.fields.map { "\($0.label) (\($0.type.rawValue))" }.joined(separator: ", "))") }
            Text("Allowed actions: \(definition.actions.map { "\($0.operation.rawValue) \(BobAppDefinition.label($0.table))" }.joined(separator: ", "))")
        }.font(BobFont.subline).padding(.vertical, 8).bobListRow(divider: false)
    }
}
private struct BobAppDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
