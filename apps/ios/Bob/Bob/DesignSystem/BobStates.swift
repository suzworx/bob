import SwiftUI
import BobKit

// Every list and detail names its state with these. See apps/ios/DESIGN.md §5.

// Loading, in words as well as a spinner.
struct BobLoading: View {
    let label: String

    init(_ label: String) {
        self.label = label
    }

    var body: some View {
        VStack(spacing: BobLayout.gap) {
            ProgressView()
            Text(label).font(BobFont.secondary).foregroundStyle(BobColor.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .accessibilityElement(children: .combine)
    }
}

// Nothing here yet, and the one next step.
struct BobEmpty: View {
    let title: String
    let message: String
    let systemImage: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage).font(BobFont.lead)
        } description: {
            Text(message).font(BobFont.secondary)
        } actions: {
            if let actionTitle, let action {
                Button(actionTitle, action: action).buttonStyle(BobSecondaryButtonStyle())
            }
        }
    }
}

// A refresh failed after the screen had data: say so quietly above it, keep the data.
struct BobStaleNote: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(spacing: BobLayout.gap) {
            Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
            Text(message).frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Try again", action: retry).font(BobFont.bodyStrong).frame(minHeight: 44)
            }
        }
        .font(BobFont.secondary)
        .foregroundStyle(BobColor.muted)
        .padding(.horizontal, BobLayout.pageMargin)
    }
}

extension ApiError {
    // The symbol that matches the cause, so a server or permission problem never looks like no signal.
    var stateSymbol: String {
        switch self {
        case .offline: "wifi.slash"
        case .unauthenticated, .forbidden: "lock"
        case .notFound: "questionmark.folder"
        case .rateLimited: "hourglass"
        default: "exclamationmark.triangle"
        }
    }
}
