import SwiftUI

// A rounded container for a group of rows: wash by default, or a raised surface with a soft shadow.
struct BobInsetGroup<Content: View>: View {
    var elevated: Bool = false
    @ViewBuilder let content: Content

    init(elevated: Bool = false, @ViewBuilder content: () -> Content) {
        self.elevated = elevated
        self.content = content()
    }

    private let cornerRadius: CGFloat = 16

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        VStack(spacing: 0) {
            content
        }
        .background(elevated ? BobColor.surface : BobColor.wash)
        .clipShape(shape)
        .shadow(color: elevated ? BobColor.ink.opacity(0.08) : BobColor.ink.opacity(0), radius: 8, x: 0, y: 3)
    }
}

#Preview {
    VStack(spacing: 24) {
        BobInsetGroup {
            BobRow(title: "Maya Chen", subline: "Dinner on Friday?", meta: "2m", showsChevron: true)
            BobRow(title: "Sam Okafor", subline: "Sent a photo", meta: "1h", showsChevron: true)
        }
        BobInsetGroup(elevated: true) {
            BobRow(title: "Reminders", subline: "3 due today", showsChevron: true, systemImage: "bell")
        }
    }
    .padding()
    .bobPage()
}
