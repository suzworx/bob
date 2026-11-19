import BobKit
import SwiftUI
import UIKit

// Holds the parsed reply between redraws: streaming reparses only the end of it, and history parses once.
@MainActor private final class MarkdownCache {
    private var document = MarkdownDocument()

    func blocks(_ text: String, isStreaming: Bool) -> [MarkdownBlock] {
        document.update(text, isStreaming: isStreaming)
        return document.blocks
    }
}

// Bob's words, as markdown, on the page.
struct ChatMarkdownView: View {
    let text: String
    var isStreaming = false
    var font: Font = BobFont.body

    @State private var cache = MarkdownCache()

    var body: some View {
        MarkdownBlocksView(blocks: cache.blocks(text, isStreaming: isStreaming), font: font)
            // A reply's text is untrusted: the parser only makes safe links, and this holds the line at the moment of opening.
            .environment(\.openURL, OpenURLAction { url in
                MarkdownLink.safeURL(url.absoluteString) == nil ? .discarded : .systemAction
            })
            .tint(BobColor.ink)
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]
    let font: Font

    @ScaledMetric(relativeTo: .body) private var spacing: CGFloat = 10

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            // Blocks only ever get added at the end, so their place is their identity.
            ForEach(blocks.indices, id: \.self) { index in
                MarkdownBlockView(block: blocks[index], font: font)
                    .equatable()
            }
        }
    }
}

// Equal to its last self for every finished block, so a long reply only redraws its end.
private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlock
    let font: Font

    @ScaledMetric(relativeTo: .body) private var itemSpacing: CGFloat = 4
    @ScaledMetric(relativeTo: .body) private var markerSpacing: CGFloat = 8

    nonisolated static func == (left: Self, right: Self) -> Bool {
        left.block == right.block && left.font == right.font
    }

    var body: some View {
        switch block {
        case .heading(let level, let runs):
            let headingFont = BobFont.replyHeading(level: level)
            Text(MarkdownText.attributed(runs, font: headingFont))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let runs):
            Text(MarkdownText.attributed(runs, font: font))
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            MarkdownCodeBlock(language: language, text: text)
        case .list(let ordered, let start, let items):
            list(ordered: ordered, start: start, items: items)
        case .quote(let inner):
            MarkdownBlocksView(blocks: inner, font: font)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    Rectangle().fill(BobColor.tint).frame(width: 2)
                }
        case .table(let alignments, let header, let rows):
            MarkdownTable(alignments: alignments, header: header, rows: rows, font: font)
        case .rule:
            BobDivider()
                .accessibilityHidden(true)
        }
    }

    private func list(ordered: Bool, start: Int, items: [MarkdownListItem]) -> some View {
        VStack(alignment: .leading, spacing: itemSpacing) {
            ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                HStack(alignment: .firstTextBaseline, spacing: markerSpacing) {
                    Text(marker(item, ordered: ordered, number: start + index))
                        .font(font)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    MarkdownBlocksView(blocks: item.blocks, font: font)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func marker(_ item: MarkdownListItem, ordered: Bool, number: Int) -> String {
        if let checked = item.checked {
            return checked ? "☑" : "☐"
        }
        return ordered ? "\(number)." : "•"
    }
}

enum MarkdownText {
    nonisolated static func plain(_ runs: [MarkdownRun]) -> String {
        runs.map(\.text).joined()
    }

    static func attributed(_ runs: [MarkdownRun], font: Font) -> AttributedString {
        var result = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            var runFont = run.style.contains(.code) ? BobFont.inlineCode : font
            if run.style.contains(.bold) { runFont = runFont.bold() }
            if run.style.contains(.italic) { runFont = runFont.italic() }
            piece.font = runFont
            if run.style.contains(.code) { piece.backgroundColor = BobColor.wash }
            if run.style.contains(.strikethrough) { piece.strikethroughStyle = .single }
            if let link = run.link {
                piece.link = link
                piece.underlineStyle = .single
            }
            result += piece
        }
        return result
    }
}

// Code keeps its lines and scrolls sideways, inside its own width.
private struct MarkdownCodeBlock: View {
    let language: String?
    let text: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text(language ?? "Code")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, 12)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            ScrollView(.horizontal) {
                Text(text)
                    .font(BobFont.code)
                    .fixedSize()
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                    .accessibilityLabel("Code: \(text)")
            }
            .scrollIndicators(.hidden)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(BobColor.wash, in: RoundedRectangle(cornerRadius: 12))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

// A table never squeezes the page: it scrolls sideways, with long cells wrapped at a readable width.
private struct MarkdownTable: View {
    let alignments: [MarkdownAlignment]
    let header: [[MarkdownRun]]
    let rows: [[[MarkdownRun]]]
    let font: Font

    @ScaledMetric(relativeTo: .body) private var maxCellWidth: CGFloat = 220
    @ScaledMetric(relativeTo: .body) private var rowPadding: CGFloat = 6

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: rowPadding) {
                row(header, font: font.weight(.semibold))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(header.map(MarkdownText.plain).joined(separator: ", "))
                    .accessibilityAddTraits(.isHeader)
                ForEach(rows.indices, id: \.self) { index in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    row(rows[index], font: font)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(spoken(rows[index]))
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func row(_ cells: [[MarkdownRun]], font: Font) -> some View {
        GridRow {
            ForEach(cells.indices, id: \.self) { index in
                Text(MarkdownText.attributed(cells[index], font: font))
                    .multilineTextAlignment(alignment(index).text)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: maxCellWidth, alignment: alignment(index).frame)
                    .gridColumnAlignment(alignment(index).column)
            }
        }
    }

    private func alignment(_ column: Int) -> (text: TextAlignment, frame: Alignment, column: HorizontalAlignment) {
        switch column < alignments.count ? alignments[column] : .leading {
        case .leading: (.leading, .leading, .leading)
        case .center: (.center, .center, .center)
        case .trailing: (.trailing, .trailing, .trailing)
        }
    }

    // Read as "Day: Mon, Plan: Walk", since a list of values alone means little.
    private func spoken(_ cells: [[MarkdownRun]]) -> String {
        cells.indices.map { index in
            let name = index < header.count ? MarkdownText.plain(header[index]) : ""
            return "\(name): \(MarkdownText.plain(cells[index]))"
        }.joined(separator: ", ")
    }
}
