import SwiftUI

// A small tinted capsule button, such as a suggestion chip. The capsule is 34 pt tall;
// the tap area around it is padded to at least 44 by 44.
struct BobPill: View {
    let title: String
    var systemImage: String? = nil
    let action: () -> Void

    @ScaledMetric(relativeTo: .caption2) private var visibleHeight: CGFloat = 34
    @ScaledMetric(relativeTo: .caption2) private var verticalPadding: CGFloat = 6
    // Horizontal measures stay fixed so large text keeps the width for the words.
    private let horizontalPadding: CGFloat = 14
    private let iconSpacing: CGFloat = 6

    var body: some View {
        Button(action: action) {
            HStack(spacing: iconSpacing) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .accessibilityHidden(true)
                }
                // Wraps onto more lines at large text sizes instead of running past the screen edge.
                Text(title)
                    .lineLimit(nil)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(BobFont.subline)
            .foregroundStyle(.primary)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(minHeight: visibleHeight)
            .background(
                BobColor.tint,
                in: RoundedRectangle(cornerRadius: visibleHeight / 2, style: .continuous)
            )
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
    }
}

#Preview {
    HStack(spacing: 8) {
        BobPill(title: "Plan dinner", systemImage: "fork.knife") {}
        BobPill(title: "Remind me") {}
    }
    .padding()
    .bobPage()
}
