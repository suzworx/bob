import SwiftUI

// One list row: optional icon, a title with an optional subline, trailing meta and an optional chevron.
// The row is read as one accessibility element. At accessibility sizes the icon moves above the title
// and the meta under it, so the words get the full row width.
struct BobRow: View {
    let title: String
    var subline: String? = nil
    var meta: String? = nil
    var showsChevron: Bool = false
    var systemImage: String? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var scaledIconSize: CGFloat = 36
    @ScaledMetric(relativeTo: .subheadline) private var minHeight: CGFloat = 60
    @ScaledMetric(relativeTo: .subheadline) private var verticalPadding: CGFloat = 10

    // Horizontal measures stay fixed so large text keeps the width for the words.
    private let horizontalPadding: CGFloat = 16
    private let spacing: CGFloat = 12
    private let maxIconSize: CGFloat = 48

    private var isAccessibilitySize: Bool { dynamicTypeSize.isAccessibilitySize }
    private var iconSize: CGFloat { min(scaledIconSize, maxIconSize) }

    var body: some View {
        HStack(spacing: spacing) {
            leading
            Spacer(minLength: 0)
            if !isAccessibilitySize, let meta {
                metaText(meta)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(BobFont.meta)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, verticalPadding)
        .frame(minHeight: minHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // Icon beside the text, or above it at accessibility sizes.
    @ViewBuilder private var leading: some View {
        if isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                icon
                textColumn
            }
        } else {
            HStack(spacing: spacing) {
                icon
                textColumn
            }
        }
    }

    @ViewBuilder private var icon: some View {
        if let systemImage {
            Image(systemName: systemImage)
                .font(BobFont.subline)
                .foregroundStyle(.primary)
                .frame(width: iconSize, height: iconSize)
                .background(BobColor.tint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    private var textColumn: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(BobFont.rowTitle)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            if let subline {
                Text(subline)
                    .font(BobFont.subline)
                    .monospacedDigit()
                    .foregroundStyle(BobColor.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isAccessibilitySize, let meta {
                metaText(meta)
            }
        }
    }

    private func metaText(_ meta: String) -> some View {
        Text(meta)
            .font(BobFont.meta)
            .monospacedDigit()
            .foregroundStyle(BobColor.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

#Preview {
    VStack(spacing: 0) {
        BobRow(title: "Maya Chen", subline: "Dinner on Friday?", meta: "2m", showsChevron: true)
        BobRow(title: "Reminders", subline: "3 due today", showsChevron: true, systemImage: "bell")
        BobRow(title: "Settings", systemImage: "gearshape")
    }
    .bobPage()
}

#Preview("Accessibility size") {
    VStack(spacing: 0) {
        BobRow(title: "Maya Chen", subline: "Dinner on Friday?", meta: "2m", showsChevron: true)
        BobRow(title: "Reminders", subline: "3 due today", meta: "9:00", showsChevron: true, systemImage: "bell")
    }
    .bobPage()
    .environment(\.dynamicTypeSize, .accessibility3)
}
