import SwiftUI

// Bob's visor and two eyes as a line icon, so the Bob tab matches the other tab icons (owner, 2026-11-05).
// Outlined when unselected, filled when selected, like the SF Symbols beside it.
struct BobVisorIcon: View {
    var filled = false
    var size: CGFloat = 24

    var body: some View {
        let width = size * 1.15
        let height = size * 0.72
        let eye = size * 0.17
        let line = filled ? BobColor.ink : BobColor.muted
        ZStack {
            RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                .fill(filled ? BobColor.ink : .clear)
            RoundedRectangle(cornerRadius: height / 2, style: .continuous)
                .strokeBorder(line, lineWidth: max(1.5, size * 0.08))
            HStack(spacing: size * 0.28) {
                Circle().frame(width: eye, height: eye)
                Circle().frame(width: eye, height: eye)
            }
            .foregroundStyle(filled ? BobColor.page : line)
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
}

#Preview {
    HStack(spacing: 24) {
        BobVisorIcon()
        BobVisorIcon(filled: true)
    }
    .padding()
    .bobPage()
}
