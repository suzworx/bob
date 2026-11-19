import BobKit
import SwiftUI

struct BobAppsView: View {
    var spaceID: String? = nil
    var canManage = true
    var askBob: (String) -> Void = { _ in }
    var openConversation: (BobAppConversation) -> Void = { _ in }
    var onMarketingAsk: (MarketingChatTarget, String) -> Void = { _, _ in }

    var body: some View {
        BobAppsList(spaceID: spaceID, canManage: canManage, askBob: askBob, openConversation: openConversation, onMarketingAsk: onMarketingAsk)
            .id(spaceID ?? "personal")
    }
}

private struct BobAppsList: View {
    let spaceID: String?
    let canManage: Bool
    let askBob: (String) -> Void
    let openConversation: (BobAppConversation) -> Void
    let onMarketingAsk: (MarketingChatTarget, String) -> Void
    @State private var model: BobAppsModel
    @State private var archived = false
    @State private var createdID: String?

    init(spaceID: String?, canManage: Bool, askBob: @escaping (String) -> Void, openConversation: @escaping (BobAppConversation) -> Void, onMarketingAsk: @escaping (MarketingChatTarget, String) -> Void) {
        self.spaceID = spaceID; self.canManage = canManage; self.askBob = askBob; self.openConversation = openConversation; self.onMarketingAsk = onMarketingAsk
        _model = State(initialValue: BobAppsServices.make(spaceID: spaceID))
    }
    var body: some View {
        List {
            Text("Small apps that keep up with you.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            if model.isDemo { Text("Sign in to save apps. Starters let you choose a beginning once you're connected.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false) }
            switch model.phase {
            case .loading: ProgressView("Opening your apps…").bobListRow(divider: false)
            case .failed(let error): BobLoadFailure(title: "Couldn't open your apps", error: error) { await model.load() }.bobListRow(divider: false)
            case .loaded:
                Picker("Which apps to show", selection: $archived) { Text("Current").tag(false); Text("Archived").tag(true) }.bobChoicePicker().bobListRow(divider: false)
                let rows = model.apps.filter { ($0.lifecycle == .archived) == archived }
                if rows.isEmpty { ContentUnavailableView(archived ? "Nothing archived" : "Room for something useful", systemImage: "square.grid.2x2", description: Text(archived ? "Apps you archive wait here until you want them back." : "Start with a checklist, budget or task dashboard.")).bobListRow(divider: false) }
                ForEach(rows) { app in
                    NavigationLink { destination(app.id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(app.title).font(BobFont.rowTitle)
                            Text("\(BobAppDefinition.label(app.lifecycle.rawValue)) · \(app.updatedAt.formatted(date: .abbreviated, time: .omitted))").font(BobFont.subline).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }.bobListRow()
                }
                if model.nextCursor != nil { Button("Load more apps") { Task { await model.more() } }.disabled(model.busy).bobListRow() }
                MarketingCatalogSection(spaceID: spaceID, canManage: canManage) { createdID = $0 }
                BobGroupHeader(title: "Start something useful")
                ForEach(BobAppDefinition.Starter.allCases, id: \.self) { starter in
                    Button { Task { if let app = await model.create(starter) { createdID = app.id } } } label: { Label(starter.title, systemImage: "plus.circle").font(BobFont.rowTitle).frame(minHeight: 44) }
                        .disabled(model.busy || !canManage || model.isDemo).bobListRow()
                }
                Text("A starter opens as a draft. Look it over before activating it.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
                if spaceID == nil { Button("Create with Bob") { askBob("Help me create a saved app. I would like ") }.bobListRow() }
            }
            if let message = model.message { Text(message).font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow(divider: false) }
        }
        .bobList().bobNavTitle("My Apps").privacySensitive()
        .task { await model.load() }.refreshable { await model.load() }.onDisappear { model.cancel() }
        .navigationDestination(item: $createdID) { destination($0) }
    }
    private func destination(_ id: String) -> some View {
        MarketingAwareAppDestination(appID: id, spaceID: spaceID, onAsk: onMarketingAsk) {
            BobAppDetailView(id: id, spaceID: spaceID, askBob: askBob, openConversation: openConversation)
        }
    }
}

@MainActor enum BobAppsServices {
    static func make(spaceID: String?, appID: String? = nil) -> BobAppsModel {
        let client = AppSession.make { BobAppsClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
        return BobAppsModel(client: client, spaceID: spaceID, appID: appID)
    }
}
