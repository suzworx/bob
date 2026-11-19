import BobKit
import SwiftUI

struct GoogleConnectionHandoff: View {
    let account: GoogleIntegrationAccount?
    var onRefresh: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @State private var finished = false
    @State private var selected: Set<GoogleCapability>
    @State private var model: GoogleAuthorizationModel
    @State private var browser: GoogleAuthenticationSession
    private let available: Bool
    private let capabilities: [GoogleCapability] = [.calendarRead, .calendarWrite, .mailRead, .mailDraft, .mailSend, .mailModify]

    init(account: GoogleIntegrationAccount?, onRefresh: @escaping () -> Void = {}) {
        self.account = account; self.onRefresh = onRefresh
        let browser = GoogleAuthenticationSession()
        _browser = State(initialValue: browser)
        _model = State(initialValue: GoogleAuthorizationModel(browser: browser, context: { try await AppSession.googleAuthorizationContext() }))
        _selected = State(initialValue: Set(account?.access ?? [.calendarRead]))
        available = AppSession.nativeGoogleAvailable
    }

    var body: some View {
        NavigationStack {
            List {
                VStack(alignment: .leading, spacing: 10) {
                    if let account { Text(account.email).font(BobFont.body).foregroundStyle(BobColor.ink2) }
                    Text("Choose how Bob can help. Google will ask you to confirm, then bring you back here.")
                        .font(BobFont.subline).foregroundStyle(BobColor.ink2)
                    if !available {
                        Label("Preview only · no Google account will be connected", systemImage: "eye")
                            .font(BobFont.caption).foregroundStyle(BobColor.ink2)
                    }
                }.padding(.vertical, 12).bobListRow(divider: false)
                BobGroupHeader(title: "Access you choose")
                ForEach(capabilities, id: \.rawValue) { capability in
                    Toggle(capability.title, isOn: selection(capability))
                        .disabled(model.busy || model.state == .retryable)
                        .bobListRow()
                }
                Text("Sending mail and moving messages to Trash are separate choices. You can change access or remove this account later.")
                    .font(BobFont.caption).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
                status.bobListRow(divider: false)
                if model.state == .retryable {
                    Button("Check connection") { Task { await model.retryCompletion() } }
                        .buttonStyle(BobPrimaryButtonStyle()).bobListRow(divider: false)
                    Button("Close for now") { model.invalidate(); finish() }
                        .buttonStyle(BobSecondaryButtonStyle()).bobListRow(divider: false)
                } else if !model.busy && model.state != .completed {
                    Button(account == nil ? "Continue with Google" : "Confirm with Google") {
                        Task { await model.connect(capabilities: capabilities.filter { selected.contains($0) }, reconnectAccountID: account?.id) }
                    }
                    .buttonStyle(BobPrimaryButtonStyle()).disabled(!available || selected.isEmpty)
                    .bobListRow(divider: false)
                }
            }
            .bobList().bobNavTitle(account == nil ? "Connect Google" : "Change access")
            .background(GoogleAuthorizationAnchor(browser: browser).frame(width: 0, height: 0))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.busy || model.state == .retryable ? "Cancel" : "Close") {
                        Task {
                            if model.busy || model.state == .retryable { await model.cancel() }
                            if model.state != .retryable && model.state != .completed { finish() }
                            else if model.state == .completed { finish() }
                        }
                    }.disabled(model.state == .cancelling)
                }
            }
        }
        .bobSheet().privacySensitive()
        .interactiveDismissDisabled(model.busy || model.state == .retryable)
        .onChange(of: model.state) { _, state in if state == .completed { finish() } }
        .onDisappear { model.invalidate() }
    }

    @ViewBuilder private var status: some View {
        switch model.state {
        case .authorizing: ProgressView("Opening Google…")
        case .connecting: ProgressView("Checking your connection…")
        case .cancelling: ProgressView("Finishing up…")
        case .retryable: Text("The connection check was interrupted. Check again, or close and review your connected accounts later. Bob hasn’t confirmed the outcome.").font(BobFont.subline).foregroundStyle(BobColor.ink2)
        case .failed: Text(model.error.map(ApiErrorMapper.userMessage) ?? "That connection didn't finish. Please try again.").font(BobFont.subline).foregroundStyle(BobColor.ink2)
        case .expired: Text("That sign-in expired. Your choices are still here—try again when you're ready.").font(BobFont.subline).foregroundStyle(BobColor.ink2)
        case .cancelled: Text("No problem. You can connect when you're ready.").font(BobFont.subline).foregroundStyle(BobColor.ink2)
        case .completed: Label("Connected", systemImage: "checkmark.circle").font(BobFont.subline)
        case .choosing: EmptyView()
        }
    }
    private func selection(_ capability: GoogleCapability) -> Binding<Bool> {
        Binding(get: { selected.contains(capability) }, set: { if $0 { selected.insert(capability) } else { selected.remove(capability) } })
    }
    private func finish() {
        guard !finished else { return }
        finished = true; onRefresh(); dismiss()
    }
}
