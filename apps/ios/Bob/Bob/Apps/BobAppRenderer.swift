import BobKit
import SwiftUI

struct BobAppRenderer: View {
    let definition: BobAppDefinition
    let state: [String: [BobAppRecord]]
    let metrics: [String: Double]
    var model: BobAppsModel? = nil
    @State private var selected = ""
    private var view: BobAppDefinition.View? { definition.views.first { $0.id == selected } ?? definition.views.first }

    var body: some View {
        if definition.views.count > 1 {
            Picker("App view", selection: Binding(get: { view?.id ?? "" }, set: { selected = $0 })) {
                ForEach(definition.views) { Text($0.title).tag($0.id) }
            }.pickerStyle(.menu).bobListRow()
        }
        if let view {
            BobGroupHeader(title: view.title)
            switch view.kind {
            case .table, .checklist:
                if let table = definition.tables.first(where: { $0.id == view.table }) {
                    BobAppRecordsView(view: view, table: table, actions: definition.allowedActions(in: view), rows: state[table.id] ?? [], model: model).id(view.id)
                }
            case .dashboard: BobAppMetrics(ids: view.metrics ?? [], metrics: metrics)
            case .slides: BobAppSlides(slides: view.slides ?? [], metrics: metrics).id(view.id)
            }
        }
    }
}

private struct BobAppMetrics: View {
    let ids: [String]
    let metrics: [String: Double]
    var body: some View {
        ForEach(ids, id: \.self) { id in
            HStack { Text(BobAppDefinition.label(id)).font(BobFont.rowTitle); Spacer(); Text((metrics[id] ?? 0).formatted()).font(BobFont.heading).monospacedDigit() }.padding(.vertical, 10).bobListRow()
        }
    }
}
private struct BobAppSlides: View {
    let slides: [BobAppDefinition.View.Slide]
    let metrics: [String: Double]
    @State private var index = 0
    var body: some View {
        if !slides.isEmpty {
            let selected = min(index, slides.count - 1)
            let slide = slides[selected]
            VStack(alignment: .leading, spacing: 16) {
                Text(slide.title).font(BobFont.greeting).accessibilityAddTraits(.isHeader)
                Text(slide.body).font(BobFont.body).textSelection(.enabled)
            }.padding(.vertical, 16).bobListRow(divider: false)
            BobAppMetrics(ids: slide.metrics, metrics: metrics)
            HStack {
                Button("Previous") { index = max(0, index - 1) }.disabled(selected == 0).accessibilityLabel("Previous slide")
                Spacer(); Text("\(selected + 1) of \(slides.count)").font(BobFont.caption); Spacer()
                Button("Next") { index = min(slides.count - 1, index + 1) }.disabled(selected == slides.count - 1).accessibilityLabel("Next slide")
            }.frame(minHeight: 44).bobListRow(divider: false)
        }
    }
}
private struct BobAppEditSelection: Identifiable {
    let id = UUID()
    let row: BobAppRecord?
    let action: BobAppDefinition.Action
    let revision: Int
}
private struct BobAppRecordsView: View {
    let view: BobAppDefinition.View
    let table: BobAppDefinition.Table
    let actions: [BobAppDefinition.Action]
    let rows: [BobAppRecord]
    let model: BobAppsModel?
    @State private var editing: BobAppEditSelection?
    @State private var removing: BobAppRecord?
    private var canEdit: Bool { model?.editable == true && model?.lockedTable != table.id }
    private func action(_ operation: BobAppDefinition.Action.Operation) -> BobAppDefinition.Action? { canEdit ? actions.first { $0.operation == operation } : nil }
    private var titleField: String? { table.fields.first { $0.type == .text && (view.fields ?? []).contains($0.id) }?.id ?? view.fields?.first }
    private var booleanField: String? { view.kind == .checklist ? table.fields.first { $0.type == .boolean && (view.fields ?? []).contains($0.id) }?.id : nil }
    private func title(_ row: BobAppRecord) -> String { titleField.flatMap { row.values[$0]?.display }.flatMap { $0.isEmpty ? nil : $0 } ?? "This record" }

    var body: some View {
        if let create = action(.create) {
            Button("Add to \(view.title)") { editing = BobAppEditSelection(row: nil, action: create, revision: model?.app?.revision ?? 0) }.disabled(model?.busy == true).bobListRow()
        }
        if model?.lockedTable == table.id { Text("Automatic updates replace this table. Pause automatic updates before editing its records.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false) }
        if rows.isEmpty { Text("Nothing here yet.").font(BobFont.body).foregroundStyle(.secondary).bobListRow(divider: false) }
        ForEach(rows) { row in
            HStack(alignment: .top, spacing: 12) {
                if let field = booleanField {
                    Toggle("Complete \(title(row))", isOn: Binding(get: { row.values[field] == .boolean(true) }, set: { value in
                        guard let update = action(.update), let model, let revision = model.app?.revision else { return }
                        var values = row.values; values[field] = .boolean(value)
                        Task { _ = await model.act(.write(action: update.id, id: row.id, values: values), revision: revision) }
                    })).labelsHidden().toggleStyle(.switch).fixedSize().disabled(action(.update) == nil || model?.busy == true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(title(row)).font(BobFont.rowTitle)
                    ForEach((view.fields ?? []).filter { $0 != titleField && $0 != booleanField }, id: \.self) { field in
                        Text("\(BobAppDefinition.label(field)): \(row.values[field]?.display ?? "")").font(BobFont.subline).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if action(.update) != nil || action(.delete) != nil {
                    Menu {
                        if let update = action(.update) { Button("Edit") { editing = BobAppEditSelection(row: row, action: update, revision: model?.app?.revision ?? 0) } }
                        if action(.delete) != nil { Button("Remove", role: .destructive) { removing = row } }
                    } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }.accessibilityLabel("Actions for \(title(row))").disabled(model?.busy == true)
                }
            }.padding(.vertical, 8).bobListRow()
        }
        Color.clear.frame(height: 0).bobListRow(divider: false)
            .sheet(item: $editing) { selection in
                if let model { BobAppRecordEditor(table: table, title: view.title, selection: selection, model: model).bobSheet() }
            }
            .confirmationDialog("Remove this record?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                if let row = removing, let remove = action(.delete), let model, let revision = model.app?.revision {
                    Button("Remove", role: .destructive) { Task { if await model.act(.delete(action: remove.id, id: row.id), revision: revision) { removing = nil } } }
                }
            } message: { Text("\(removing.map(title) ?? "This record") will be gone for good.") }
    }
}

private struct BobAppRecordEditor: View {
    let table: BobAppDefinition.Table
    let title: String
    let selection: BobAppEditSelection
    let model: BobAppsModel
    @State private var draft: BobAppRecordDraft
    @State private var expectedRevision: Int
    @State private var problem: String?
    @State private var discard = false
    @Environment(\.dismiss) private var dismiss
    init(table: BobAppDefinition.Table, title: String, selection: BobAppEditSelection, model: BobAppsModel) {
        self.table = table; self.title = title; self.selection = selection; self.model = model
        _draft = State(initialValue: BobAppRecordDraft(table: table, row: selection.row)); _expectedRevision = State(initialValue: selection.revision)
    }
    private var changedElsewhere: Bool { model.app?.revision != expectedRevision }
    var body: some View {
        NavigationStack {
            Form {
                if changedElsewhere {
                    Text("Saved data changed while you were editing. Your edits are still here. Compare the latest values before replacing them.")
                    if let current = model.app?.state[table.id]?.first(where: { $0.id == draft.id }) {
                        ForEach(table.fields) { Text("\($0.label): \(current.values[$0.id]?.display ?? "")") }
                    }
                    Button("Keep my edits against latest data") { if let revision = model.app?.revision { expectedRevision = revision; problem = nil } }
                }
                if let problem { Text(problem).foregroundStyle(BobColor.dangerText) }
                ForEach(table.fields) { field in
                    switch field.type {
                    case .boolean: Toggle(field.label, isOn: Binding(get: { draft.flags[field.id] ?? false }, set: { draft.flags[field.id] = $0 }))
                    case .text: TextField(field.label, text: Binding(get: { draft.text[field.id] ?? "" }, set: { draft.text[field.id] = String($0.prefix(2000)) }), axis: .vertical)
                    case .number: TextField(field.label, text: Binding(get: { draft.text[field.id] ?? "" }, set: { draft.text[field.id] = $0 })).keyboardType(.numbersAndPunctuation)
                    }
                }.disabled(model.busy)
            }
            .bobNavTitle(selection.row == nil ? "Add to \(title)" : "Edit in \(title)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { discard = true }.disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(model.busy || changedElsewhere) }
            }
            .confirmationDialog("Discard your edits?", isPresented: $discard, titleVisibility: .visible) { Button("Discard", role: .destructive) { dismiss() } }
            .interactiveDismissDisabled()
        }
    }
    private func save() {
        do {
            let values = try draft.values(table: table)
            Task {
                if await model.act(.write(action: selection.action.id, id: draft.id, values: values), revision: expectedRevision) { dismiss() }
                else if model.app?.state[table.id]?.contains(where: { $0.id == draft.id && $0.values == values }) == true { dismiss() }
                else { problem = model.message ?? "Couldn't save this. Your edits are still here; try again." }
            }
        } catch { problem = "Check every number and keep text under 2,000 characters. Numbers can be between −1 trillion and 1 trillion." }
    }
}
