import BobKit
import SwiftUI

struct MarketingCatalogSection: View {
    let spaceID: String?
    var canManage = true
    let onOpen: (String) -> Void
    @State private var installation: MarketingInstallation?
    @State private var package: MarketingPackage?
    @State private var loading = true
    @State private var busy = false
    @State private var error: ApiError?
    @State private var mutationID = UUID().uuidString
    private let service = MarketingServices.make()

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Label("Bob Marketing", systemImage: "sparkles").font(BobFont.rowTitle)
                Text("Turn ideas into campaigns and posts with Bob. Nothing gets posted for you.")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                if loading { ProgressView("Opening Marketing…") }
                if let error {
                    Text(marketingError(error)).font(BobFont.subline).foregroundStyle(.secondary)
                    Button("Retry Marketing") { Task { await load() } }
                }
                if service == nil {
                    Text("Sign in to the live app to install Marketing and work on your saved posts.").font(BobFont.subline).foregroundStyle(.secondary)
                } else if !loading && error == nil {
                    Button(installation == nil ? "Install Marketing" : "Open Marketing") {
                        if let installation { onOpen(installation.appId) }
                        else { Task { await install() } }
                    }.disabled(busy || installation == nil && !canManage)
                }
                if busy { ProgressView("Preparing Marketing…") }
                if let package {
                    DisclosureGroup("Brand & skills") {
                        Text(package.mission).font(BobFont.body)
                        Text(package.voice).font(BobFont.subline)
                        ForEach(package.roles) { role in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(role.label).font(BobFont.caption)
                                Text(role.summary).font(BobFont.subline).foregroundStyle(.secondary)
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }.padding(.vertical, 8)
        }.task(id: spaceID) { await load() }
    }
    private func load() async {
        guard let service else { loading = false; return }
        loading = true; error = nil
        defer { loading = false }
        do {
            let package = try await service.package()
            let rows = try await service.installations(spaceID: spaceID)
            guard !Task.isCancelled else { return }
            self.package = package; installation = rows.first { $0.spaceId == spaceID }
        } catch { if !Task.isCancelled { self.error = (error as? ApiError) ?? .unknown(status: 0) } }
    }
    private func install() async {
        guard let service, !busy, canManage else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let installed = try await service.install(spaceID: spaceID, mutationID: mutationID)
            guard installed.spaceId == spaceID else { throw ApiError.notFound }
            installation = installed
            if installed.state == "draft" {
                // Installation remains visible even if activation needs a retry in its workspace.
                installation = (try? await service.lifecycle(installed, operation: .activate, mutationID: UUID().uuidString)) ?? installed
            }
            onOpen(installed.appId)
        } catch { self.error = (error as? ApiError) ?? .unknown(status: 0) }
    }
}

/// Resolves the specialized app before allowing its generic table editor to mount.
struct MarketingAwareAppDestination<Content: View>: View {
    let appID: String
    let spaceID: String?
    let onAsk: (MarketingChatTarget, String) -> Void
    @ViewBuilder let generic: () -> Content
    @State private var resolved = false
    @State private var marketing = false
    @State private var error: ApiError?
    var body: some View {
        Group {
            if let error {
                BobLoadFailure(title: "Couldn't open this app", error: error) { await load() }
            } else if !resolved { ProgressView("Opening your app…") }
            else if marketing { MarketingAppDestination(appID: appID, spaceID: spaceID, onAsk: onAsk) }
            else { generic() }
        }.task(id: appID) { await load() }
    }
    private func load() async {
        guard let service = MarketingServices.make() else { resolved = true; return }
        error = nil; resolved = false
        do {
            let rows = try await service.installations(spaceID: spaceID)
            guard !Task.isCancelled else { return }
            marketing = rows.contains { $0.appId == appID && $0.spaceId == spaceID }; resolved = true
        } catch { if !Task.isCancelled { self.error = (error as? ApiError) ?? .unknown(status: 0) } }
    }
}

struct MarketingAppDestination: View {
    let appID: String
    let spaceID: String?
    let onAsk: (MarketingChatTarget, String) -> Void
    @State private var model: MarketingWorkspaceModel?
    @State private var error: ApiError?
    var body: some View {
        Group {
            if let model { MarketingWorkspaceView(model: model, onAsk: onAsk) }
            else if let error { BobLoadFailure(title: "Couldn't open Marketing", error: error) { await load() } }
            else { ProgressView("Opening Marketing…") }
        }.task(id: appID) { await load() }
    }
    private func load() async {
        guard let service = MarketingServices.make() else { error = .unauthenticated; return }
        error = nil
        do {
            let rows = try await service.installations(spaceID: spaceID)
            guard let installation = rows.first(where: { $0.appId == appID && $0.spaceId == spaceID }) else { throw ApiError.notFound }
            guard !Task.isCancelled else { return }
            model = MarketingWorkspaceModel(installationID: installation.id, spaceID: spaceID, service: service)
        } catch { if !Task.isCancelled { self.error = (error as? ApiError) ?? .unknown(status: 0) } }
    }
}
