import BobKit
import SwiftUI

struct SignInEmailField: View {
    @Binding var text: String
    let problem: String?
    let onSubmit: () -> Void

    @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 50

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                TextField("", text: $text, prompt: Text("Email").foregroundStyle(.secondary))
                    .font(BobFont.body)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.continue)
                    .onSubmit(onSubmit)
                    .accessibilityLabel("Email")
            }
            .padding(.horizontal, 16)
            .frame(minHeight: height)
            .background(BobColor.wash, in: RoundedRectangle(cornerRadius: BobLayout.controlRadius))
            if let problem {
                Text(problem).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
            }
        }
    }
}

// Counts down once a second from the flow's cooldown; the flow itself never reads a clock.
struct SignInResendButton: View {
    let flow: SignInFlow
    let onResend: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = flow.resendSecondsRemaining(now: context.date)
            Button(action: onResend) {
                if remaining > 0 {
                    Text("Resend in \(remaining)s").foregroundStyle(.secondary)
                } else {
                    Text("Resend").underline().foregroundStyle(.primary)
                }
            }
            .font(.subheadline)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .disabled(remaining > 0 || flow.isSending)
            .accessibilityLabel(remaining > 0 ? "Resend code, available in \(remaining) seconds" : "Resend code")
        }
    }
}

struct SignInErrorBanner: View {
    let message: String
    let onRetry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text(message).font(BobFont.body).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
            }
            .foregroundStyle(BobColor.dangerText)
            if let onRetry {
                Button("Try again", action: onRetry)
                    .buttonStyle(BobSecondaryButtonStyle())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(BobColor.wash, in: RoundedRectangle(cornerRadius: BobLayout.controlRadius, style: .continuous))
    }
}

// Short help in a system alert. There is no support address to offer yet, so it covers what a person can do themselves.
struct SignInTroubleButton: View {
    @State private var isShowingHelp = false

    var body: some View {
        Button {
            isShowingHelp = true
        } label: {
            Text("Trouble signing in?")
        }
        .font(.subheadline)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .alert("Trouble signing in?", isPresented: $isShowingHelp) {
            Button("Got it", role: .cancel) {}
        } message: {
            Text("Check your spam folder for the email.\n\nCheck that your address is spelled correctly.\n\nStill no code? Tap Resend when the countdown ends.")
        }
    }
}

// The web's invite-only line with its waitlist link.
struct SignInInviteLine: View {
    private static let waitlistURL = URL(string: "https://heybob.xyz")!

    var body: some View {
        HStack(spacing: 4) {
            Text("Invite only.").foregroundStyle(.secondary)
            Link("Join the waitlist", destination: Self.waitlistURL)
        }
        .font(.subheadline)
        .frame(minHeight: 44)
    }
}
