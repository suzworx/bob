import BobKit
import SwiftUI

// A full-screen moment with no tab bar, a placeholder until each moment is built.
struct MomentPlaceholderView: View {
    let moment: ShellMoment

    @Environment(ShellStore.self) private var store
    @ScaledMetric(relativeTo: .body) private var spacing: CGFloat = 12
    @ScaledMetric(relativeTo: .body) private var closeIconSize: CGFloat = 16
    // Fixed so large text keeps the screen width for the words.
    private let pageMargin: CGFloat = 20
    private let closeInset: CGFloat = 8

    private var title: String {
        switch moment {
        case .voice: "Voice"
        case .signIn: "Sign in"
        case .confirm: "Confirm"
        case .designCatalog: "Design catalog"
        }
    }

    var body: some View {
        if moment == .designCatalog {
            DesignCatalogView()
                .overlay(alignment: .topTrailing) {
                    closeButton
                        .padding(.trailing, closeInset)
                }
        } else {
            VStack(alignment: .leading, spacing: spacing) {
                HStack {
                    Spacer(minLength: 0)
                    closeButton
                }
                Text(title)
                    .font(BobFont.greeting)
                    .foregroundStyle(.primary)
                    .accessibilityAddTraits(.isHeader)
                Text("This screen is coming soon.")
                    .font(BobFont.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, pageMargin)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .bobPage()
        }
    }

    private var closeButton: some View {
        Button {
            store.dismissMoment()
        } label: {
            Image(systemName: "xmark")
                .resizable()
                .scaledToFit()
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
                .frame(width: closeIconSize, height: closeIconSize)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
    }
}

#Preview("Design catalog") {
    MomentPlaceholderView(moment: .designCatalog)
        .environment(ShellStore())
}
