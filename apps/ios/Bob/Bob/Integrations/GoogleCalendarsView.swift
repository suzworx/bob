import BobKit
import SwiftUI

struct GoogleCalendarsView: View {
    let account: GoogleIntegrationAccount
    @State private var model: GoogleCalendarsModel
    @State private var reconnecting = false
    @Environment(\.dismiss) private var dismiss
    init(account: GoogleIntegrationAccount, service: any GoogleIntegrationsService) {
        self.account = account
        _model = State(initialValue: GoogleCalendarsModel(accountID: account.id, service: service))
    }
    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 10) {
                Text(account.displayName).font(BobFont.greeting)
                Text("Choose up to five calendars across your Google accounts. Events appear read-only in your agenda.")
                    .font(BobFont.body).foregroundStyle(.secondary)
                Text("\(model.selected.count) selected").font(BobFont.subline).foregroundStyle(.secondary)
            }.padding(.vertical, 12).bobListRow(divider: false)
            if let error = model.error {
                VStack(alignment: .leading, spacing: 10) {
                    Text(error == .invalidRequest ? "Couldn't save those calendars. You can show up to five across all your Google accounts. Check your choices and try again." : integrationMessage(error))
                        .font(BobFont.body).foregroundStyle(.secondary)
                    if error == .forbidden { Button("Reconnect") { reconnecting = true } }
                    else if !model.loaded { Button("Retry") { Task { await model.load() } } }
                }.bobListRow(divider: false)
            }
            if model.busy { ProgressView("Working on your calendars…").bobListRow(divider: false) }
            if model.loaded {
                ForEach(model.calendars) { calendar in
                    Toggle(isOn: selection(calendar.id)) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(calendar.title.isEmpty ? calendar.id : calendar.title).font(BobFont.rowTitle)
                            if !calendar.selectable { Text("Unavailable for selection").font(BobFont.caption).foregroundStyle(.secondary) }
                        }.padding(.vertical, 4)
                    }
                    .disabled(model.busy || (!calendar.selectable && !model.selected.contains(calendar.id)))
                    .bobListRow()
                }
                ForEach(model.outsidePage, id: \.self) { id in
                    Toggle(isOn: selection(id)) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(id).font(BobFont.rowTitle)
                            Text("Saved calendar · not in the loaded list").font(BobFont.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(model.busy).bobListRow()
                }
                if model.calendars.isEmpty && model.outsidePage.isEmpty {
                    Text("No calendars to show for this account.").font(BobFont.body).foregroundStyle(.secondary).bobListRow(divider: false)
                }
                if model.next != nil {
                    Button("Load more calendars") { Task { await model.load(more: true) } }.disabled(model.busy).bobListRow()
                }
            }
        }
        .bobList().bobNavTitle("Google calendars").privacySensitive()
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { if await model.save() { dismiss() } } }
                    .disabled(!model.loaded || model.busy || model.selected.count > 5)
            }
        }
        .task { await model.load() }
        .onDisappear { model.cancel() }
        .sheet(isPresented: $reconnecting) {
            GoogleConnectionHandoff(account: account, onRefresh: reloadAfterConnection)
        }
    }
    private func reloadAfterConnection() {
        let draft = model.loaded ? model.selected : nil
        Task {
            await model.load()
            if let draft { model.selected = draft }
        }
    }
    private func selection(_ id: String) -> Binding<Bool> {
        Binding(get: { model.selected.contains(id) }, set: { chosen in
            if chosen { model.selected.insert(id) } else { model.selected.remove(id) }
        })
    }
}
