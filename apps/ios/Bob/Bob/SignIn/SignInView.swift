import BobKit
import SwiftUI

// Email and a six-digit code; no password. Invite-only: asking for a code never creates an account.
struct SignInView: View {
    let client: SupabaseAuthClient
    let onSignedIn: @MainActor (StoredSession) async throws -> Void

    @State private var flow = SignInFlow()
    @FocusState private var codeFocused: Bool
    @ScaledMetric(relativeTo: .title) private var heroSize: CGFloat = 120

    private var emailBinding: Binding<String> {
        Binding(get: { flow.email }, set: { flow.setEmail($0) })
    }

    private var codeBinding: Binding<String> {
        Binding(get: { flow.code }, set: { flow.setCode($0) })
    }

    var body: some View {
        GeometryReader { screen in
        ScrollView {
            VStack(spacing: 20) {
                header
                SignInEmailField(text: emailBinding, problem: flow.emailProblem, onSubmit: submit)
                    .disabled(flow.isSending)
                if flow.step == .code {
                    codeSection
                }
                if let message = flow.errorMessage {
                    SignInErrorBanner(message: message, onRetry: flow.retryAction.map { action in { run(action) } })
                }
                Button(action: submit) {
                    HStack(spacing: 8) {
                        if flow.isSending {
                            ProgressView().tint(BobColor.onAccent)
                        }
                        Text("Continue")
                    }
                }
                .buttonStyle(BobPrimaryButtonStyle(expands: true))
                .disabled(flow.isSending)
                if let notice = flow.notice {
                    Text(notice).font(BobFont.subline).foregroundStyle(.secondary)
                }
                if flow.step == .code {
                    SignInTroubleButton()
                }
                SignInInviteLine()
            }
            .padding(.horizontal, BobLayout.pageMargin)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, minHeight: screen.size.height)
        }
        }
        .scrollDismissesKeyboard(.interactively)
        .bobPage()
        // Waits a moment because a field just inserted cannot take focus in the same update.
        .task(id: flow.codeFocusRequests) {
            guard flow.codeFocusRequests > 0, (try? await Task.sleep(for: .milliseconds(100))) != nil else { return }
            codeFocused = true
        }
        .onChange(of: flow.code) {
            if flow.shouldAutoVerify { verify() }
        }
        .sensoryFeedback(.error, trigger: flow.errorMessage) { _, message in message != nil }
        .onChange(of: flow.errorMessage) { _, message in
            if let message {
                AccessibilityNotification.Announcement(message).post()
            }
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image("BobHelper")
                .resizable()
                .scaledToFit()
                .frame(height: min(heroSize, 120))
                .accessibilityHidden(true)
            Text("Hello again.")
                .font(BobFont.greeting)
                .accessibilityAddTraits(.isHeader)
        }
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Code").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                SignInResendButton(flow: flow, onResend: send)
            }
            // Not disabled while verifying: that would drop the keyboard. The flow ignores edits until the answer is back.
            SignInCodeField(code: codeBinding, focus: $codeFocused, onSubmit: submit)
            if let problem = flow.codeProblem {
                Text(problem).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
            }
        }
    }

    private func submit() {
        run(flow.step == .email ? .send : .verify)
    }

    private func run(_ action: SignInFlow.Action) {
        switch action {
        case .send: send()
        case .verify: verify()
        }
    }

    private func send() {
        guard let address = flow.startSend(now: Date()) else { return }
        Task {
            do {
                try await client.requestCode(email: address)
                flow.finishSend(error: nil, now: Date())
            } catch {
                flow.finishSend(error: error as? SignInError ?? .failed, now: Date())
            }
        }
    }

    private func verify() {
        guard let request = flow.startVerify() else { return }
        Task {
            do {
                let session = try await client.verifyCode(email: request.email, code: request.code)
                do {
                    try await onSignedIn(session)
                    flow.finishVerify(error: nil)
                } catch {
                    flow.finishVerify(error: .notSaved)
                }
            } catch {
                flow.finishVerify(error: error as? SignInError ?? .failed)
            }
        }
    }
}
