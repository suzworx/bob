import SwiftUI

// A section caption with an optional trailing link such as "View all".
// When the caption and link do not fit on one line, the link moves under the caption.
struct BobSectionHeader: View {
    let caption: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                captionText
                Spacer(minLength: 8)
                actionLink
            }
            VStack(alignment: .leading, spacing: 0) {
                captionText
                actionLink
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }

    private var captionText: some View {
        Text(caption)
            .font(BobFont.caption)
            .foregroundStyle(.primary)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var actionLink: some View {
        if let actionTitle, let action {
            Button(action: action) {
                Text(actionTitle)
                    .font(BobFont.meta)
                    .foregroundStyle(.primary)
                    .underline()
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(actionTitle) \(caption)")
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        BobSectionHeader(caption: "PEOPLE", actionTitle: "View all") {}
        BobSectionHeader(caption: "TODAY")
    }
    .padding()
    .bobPage()
}

#Preview("Accessibility size") {
    BobSectionHeader(caption: "PEOPLE YOU TALK TO MOST", actionTitle: "View all") {}
        .padding()
        .bobPage()
        .environment(\.dynamicTypeSize, .accessibility5)
}
