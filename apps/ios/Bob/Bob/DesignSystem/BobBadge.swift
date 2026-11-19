import SwiftUI

// An unread count in an accent capsule.
struct BobBadge: View {
    let count: Int

    @ScaledMetric(relativeTo: .caption2) private var minSide: CGFloat = 21
    // Fixed so large text keeps the width for the number.
    private let horizontalPadding: CGFloat = 6

    var body: some View {
        Text("\(count)")
            .font(BobFont.caption)
            .monospacedDigit()
            .foregroundStyle(BobColor.onAccent)
            // Grows taller and wraps at large text sizes rather than running past the screen edge.
            .lineLimit(nil)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, horizontalPadding)
            .frame(minWidth: minSide, minHeight: minSide)
            .background(
                BobColor.accent,
                in: RoundedRectangle(cornerRadius: minSide / 2, style: .continuous)
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(count) unread")
    }
}

#Preview {
    HStack(spacing: 12) {
        BobBadge(count: 1)
        BobBadge(count: 12)
        BobBadge(count: 128)
    }
    .padding()
    .bobPage()
}
