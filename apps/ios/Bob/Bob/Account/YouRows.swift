import BobKit
import SwiftUI

// A row that drills in: its name, and the current value in quiet text underneath.
struct YouLink: View {
    let title: String
    var detail: String?
    let route: YouRoute

    var body: some View {
        NavigationLink(value: route) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(BobFont.rowTitle)
                if let detail {
                    Text(detail).font(BobFont.subline).foregroundStyle(BobColor.ink2)
                }
            }
            .padding(.vertical, 4)
        }
        .bobListRow()
    }
}

// A choice that opens a menu from anywhere along the row, with VoiceOver reading its name and value.
struct BobMenuRow<Option: Hashable>: View {
    let title: String
    var note: String?
    let options: [Option]
    let label: (Option) -> String
    let selection: Option
    var disabled = false
    let onSelect: (Option) -> Void

    var body: some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button {
                    if option != selection { onSelect(option) }
                } label: {
                    if option == selection {
                        Label(label(option), systemImage: "checkmark")
                    } else {
                        Text(label(option))
                    }
                }
            }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(BobFont.rowTitle).foregroundStyle(.primary)
                    if let note {
                        Text(note).font(BobFont.subline).foregroundStyle(BobColor.ink2).multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 8)
                Text(label(selection)).font(BobFont.subline).foregroundStyle(BobColor.ink2).multilineTextAlignment(.trailing)
                Image(systemName: "chevron.up.chevron.down").font(.footnote).foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(title)
        .accessibilityValue(label(selection))
        .accessibilityHint(note ?? "")
        .bobListRow()
    }
}

// A fact on a screen: its name and value.
struct BobFactRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).font(BobFont.rowTitle)
            Spacer(minLength: 8)
            Text(value).font(BobFont.subline).foregroundStyle(BobColor.ink2).multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
        .bobListRow()
    }
}
