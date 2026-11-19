import SwiftUI

// One event: what on the left, when on the right; the time moves under the title at accessibility sizes.
struct TodayEventRow: View {
    let title: String
    let subline: String?
    let time: String

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subline, !subline.isEmpty {
                    Text(subline)
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                }
                if dynamicTypeSize.isAccessibilitySize {
                    timeText
                }
            }
            Spacer(minLength: 0)
            if !dynamicTypeSize.isAccessibilitySize {
                timeText
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var timeText: some View {
        Text(time)
            .font(BobFont.subline)
            .monospacedDigit()
            .foregroundStyle(.secondary)
    }
}
