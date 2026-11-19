import Foundation

public enum MarkdownAlignment: Equatable, Sendable {
    case leading, center, trailing
}

public struct MarkdownListItem: Equatable, Sendable {
    // Nil for an ordinary item; true or false for a "- [x]" task.
    public let checked: Bool?
    public let blocks: [MarkdownBlock]

    public init(checked: Bool? = nil, blocks: [MarkdownBlock]) {
        self.checked = checked
        self.blocks = blocks
    }
}

// One block of one of Bob's replies.
public indirect enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, [MarkdownRun])
    case paragraph([MarkdownRun])
    case code(language: String?, text: String)
    case list(ordered: Bool, start: Int, items: [MarkdownListItem])
    case quote([MarkdownBlock])
    case table(alignments: [MarkdownAlignment], header: [[MarkdownRun]], rows: [[[MarkdownRun]]])
    case rule
}

// The unstyled shape of a block, with its first line, so the text still arriving can be parsed on its own.
indirect enum MarkdownRawBlock {
    case heading(Int, String)
    case paragraph(String)
    case code(String?, String)
    case list(ordered: Bool, start: Int, items: [(checked: Bool?, blocks: [MarkdownRawBlock])])
    case quote([MarkdownRawBlock])
    case table([MarkdownAlignment], [String], [[String]])
    case rule
}

// A line-based parser for the markdown a chat model writes. It never fails: anything it doesn't recognise is a paragraph.
enum MarkdownBlockParser {
    private static let maxDepth = 8

    struct Located {
        let block: MarkdownRawBlock
        let firstLine: Int
    }

    private struct ListMarker {
        let indent: Int
        let contentOffset: Int
        let ordered: Bool
        let number: Int
    }

    // `isOpenEnded`: the last line is still arriving.
    static func split(_ lines: [Substring], depth: Int = 0, isOpenEnded: Bool = false) -> [Located] {
        var located: [Located] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if isBlank(line) {
                index += 1
                continue
            }
            let first = index
            let block: MarkdownRawBlock
            if let fence = fenceOpening(line) {
                (block, index) = readFence(lines, from: index, fence: fence)
            } else if let heading = heading(line) {
                block = .heading(heading.level, heading.text)
                index += 1
            } else if isRule(line) {
                block = .rule
                index += 1
            } else if depth < maxDepth, isQuote(line) {
                (block, index) = readQuote(lines, from: index, depth: depth)
            } else if depth < maxDepth, let marker = listMarker(line) {
                (block, index) = readList(lines, from: index, first: marker, depth: depth)
            } else if isTableStart(lines, at: index, isOpenEnded: isOpenEnded) {
                (block, index) = readTable(lines, from: index)
            } else {
                (block, index) = readParagraph(lines, from: index, isOpenEnded: isOpenEnded)
            }
            located.append(Located(block: block, firstLine: first))
        }
        return located
    }

    static func splitLines(_ text: String) -> [Substring] {
        text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
    }

    private static func isBlank(_ line: Substring) -> Bool {
        line.allSatisfy(\.isWhitespace)
    }

    private static func indent(_ line: Substring) -> Int {
        var count = 0
        for char in line {
            if char == " " {
                count += 1
            } else if char == "\t" {
                count += 4
            } else {
                break
            }
        }
        return count
    }

    private static func dropIndent(_ line: Substring, _ amount: Int) -> Substring {
        var rest = line
        var remaining = amount
        while remaining > 0, let first = rest.first, first == " " || first == "\t" {
            remaining -= first == "\t" ? 4 : 1
            rest = rest.dropFirst()
        }
        return rest
    }

    // MARK: Fences

    private static func fenceOpening(_ line: Substring) -> (marker: Character, length: Int, info: String?, indent: Int)? {
        let lead = indent(line)
        guard lead <= 3 else {
            return nil
        }
        let body = line.drop(while: { $0 == " " })
        guard let marker = body.first, marker == "`" || marker == "~" else {
            return nil
        }
        let length = body.prefix(while: { $0 == marker }).count
        guard length >= 3 else {
            return nil
        }
        let info = body.dropFirst(length).trimmingCharacters(in: .whitespaces)
        if marker == "`", info.contains("`") {
            return nil
        }
        return (marker, length, info.split(separator: " ").first.map(String.init), lead)
    }

    private static func readFence(_ lines: [Substring], from start: Int, fence: (marker: Character, length: Int, info: String?, indent: Int)) -> (MarkdownRawBlock, Int) {
        var index = start + 1
        var content: [Substring] = []
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if indent(line) <= 3, trimmed.count >= fence.length, trimmed.allSatisfy({ $0 == fence.marker }) {
                index += 1
                break
            }
            content.append(dropIndent(line, fence.indent))
            index += 1
        }
        return (.code(fence.info, content.joined(separator: "\n")), index)
    }

    // MARK: Single lines

    private static func heading(_ line: Substring) -> (level: Int, text: String)? {
        guard indent(line) <= 3 else {
            return nil
        }
        let body = line.drop(while: { $0 == " " })
        let level = body.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(level) else {
            return nil
        }
        let rest = body.dropFirst(level)
        guard rest.isEmpty || rest.first == " " || rest.first == "\t" else {
            return nil
        }
        var text = rest.trimmingCharacters(in: .whitespaces)
        let withoutClosing = text.replacingOccurrences(of: #"\s+#+$"#, with: "", options: .regularExpression)
        text = text.allSatisfy({ $0 == "#" }) ? "" : withoutClosing
        return (level, text)
    }

    private static func isRule(_ line: Substring) -> Bool {
        guard indent(line) <= 3 else {
            return false
        }
        let marks = line.filter { !$0.isWhitespace }
        guard marks.count >= 3, let first = marks.first, first == "-" || first == "*" || first == "_" else {
            return false
        }
        return marks.allSatisfy { $0 == first }
    }

    private static func isQuote(_ line: Substring) -> Bool {
        indent(line) <= 3 && line.drop(while: { $0 == " " }).first == ">"
    }

    private static func listMarker(_ line: Substring) -> ListMarker? {
        guard !isRule(line) else {
            return nil
        }
        let lead = indent(line)
        let body = dropIndent(line, lead)
        guard let first = body.first else {
            return nil
        }
        var markerWidth = 0
        var ordered = false
        var number = 1
        if first == "-" || first == "*" || first == "+" {
            markerWidth = 1
        } else {
            let digits = body.prefix(while: { $0.isASCII && $0.isNumber })
            guard (1...9).contains(digits.count), let value = Int(digits) else {
                return nil
            }
            let after = body.dropFirst(digits.count).first
            guard after == "." || after == ")" else {
                return nil
            }
            markerWidth = digits.count + 1
            ordered = true
            number = value
        }
        let rest = body.dropFirst(markerWidth)
        if rest.isEmpty {
            return ListMarker(indent: lead, contentOffset: lead + markerWidth + 1, ordered: ordered, number: number)
        }
        guard rest.first == " " || rest.first == "\t" else {
            return nil
        }
        return ListMarker(indent: lead, contentOffset: lead + markerWidth + 1, ordered: ordered, number: number)
    }

    // MARK: Containers

    private static func readQuote(_ lines: [Substring], from start: Int, depth: Int) -> (MarkdownRawBlock, Int) {
        var index = start
        var inner: [Substring] = []
        while index < lines.count, isQuote(lines[index]) {
            var body = lines[index].drop(while: { $0 == " " }).dropFirst()
            if body.first == " " {
                body = body.dropFirst()
            }
            inner.append(body)
            index += 1
        }
        return (.quote(split(inner, depth: depth + 1).map(\.block)), index)
    }

    private static func readList(_ lines: [Substring], from start: Int, first: ListMarker, depth: Int) -> (MarkdownRawBlock, Int) {
        var items: [(checked: Bool?, blocks: [MarkdownRawBlock])] = []
        var index = start
        var marker = first
        while true {
            let markerWidth = marker.contentOffset - marker.indent - 1
            var body: [Substring] = [dropIndent(lines[index], marker.indent).dropFirst(markerWidth).drop(while: { $0 == " " || $0 == "\t" })]
            index += 1
            var pendingBlank = 0
            scan: while index < lines.count {
                let line = lines[index]
                if isBlank(line) {
                    pendingBlank += 1
                    index += 1
                    continue
                }
                let lead = indent(line)
                let nested = listMarker(line)
                // A line further in than this item's marker belongs to it, even when a model indents a nested list by less than the marker's width.
                if lead >= marker.contentOffset || (nested != nil && lead > marker.indent) {
                    body.append(contentsOf: Array(repeating: "", count: pendingBlank))
                    pendingBlank = 0
                    body.append(dropIndent(line, nested != nil && lead < marker.contentOffset ? lead : marker.contentOffset))
                    index += 1
                    continue
                }
                if nested != nil {
                    break scan
                }
                // Text straight under an item continues it, unless something else starts there.
                if pendingBlank == 0, !interruptsParagraph(line) {
                    body.append(line.drop(while: { $0 == " " }))
                    index += 1
                    continue
                }
                break scan
            }
            let (checked, content) = taskState(body)
            items.append((checked, split(content, depth: depth + 1).map(\.block)))
            // A blank that ended this item hands it back only if the list has really ended.
            guard index < lines.count, let next = listMarker(lines[index]), next.ordered == first.ordered, next.indent <= first.indent + 1 else {
                index = backOverBlanks(lines, index)
                break
            }
            marker = next
        }
        return (.list(ordered: first.ordered, start: first.number, items: items), index)
    }

    private static func backOverBlanks(_ lines: [Substring], _ index: Int) -> Int {
        var cursor = index
        while cursor > 0, cursor <= lines.count, isBlank(lines[cursor - 1]) {
            cursor -= 1
        }
        return cursor
    }

    private static func taskState(_ body: [Substring]) -> (Bool?, [Substring]) {
        guard let first = body.first else {
            return (nil, body)
        }
        for (prefix, state) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] where first.hasPrefix(prefix) {
            var rest = body
            rest[0] = first.dropFirst(prefix.count)
            return (state, rest)
        }
        return (nil, body)
    }

    // MARK: Tables

    private static func cells(_ line: Substring) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)[...]
        if trimmed.first == "|" {
            trimmed = trimmed.dropFirst()
        }
        var result: [String] = []
        var current = ""
        var escaped = false
        var inCode = false
        for char in trimmed {
            if escaped {
                if char != "|" {
                    current.append("\\")
                }
                current.append(char)
                escaped = false
            } else if char == "\\" {
                escaped = true
            } else if char == "`" {
                inCode.toggle()
                current.append(char)
            } else if char == "|", !inCode {
                result.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(char)
            }
        }
        let tail = current.trimmingCharacters(in: .whitespaces)
        if !tail.isEmpty || trimmed.last != "|" {
            result.append(tail)
        }
        return result
    }

    private static func delimiterAlignments(_ line: Substring) -> [MarkdownAlignment]? {
        guard line.contains("-"), line.allSatisfy({ "|-: \t".contains($0) }) else {
            return nil
        }
        var result: [MarkdownAlignment] = []
        for cell in cells(line) {
            let left = cell.hasPrefix(":")
            let right = cell.hasSuffix(":")
            let dashes = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else {
                return nil
            }
            result.append(left && right ? .center : right ? .trailing : .leading)
        }
        return result.isEmpty ? nil : result
    }

    private static func isTableStart(_ lines: [Substring], at index: Int, isOpenEnded: Bool) -> Bool {
        guard index + 1 < lines.count, lines[index].contains("|") else {
            return false
        }
        let columns = cells(lines[index]).count
        if let alignments = delimiterAlignments(lines[index + 1]), alignments.count == columns {
            return true
        }
        // Still arriving: a table's second line, cut off part way, so the header doesn't flash up as a sentence first.
        guard isOpenEnded, index + 2 == lines.count else {
            return false
        }
        let partial = lines[index + 1].trimmingCharacters(in: .whitespaces)
        return !partial.isEmpty && partial.allSatisfy { "|-: ".contains($0) }
    }

    private static func readTable(_ lines: [Substring], from start: Int) -> (MarkdownRawBlock, Int) {
        let header = cells(lines[start])
        let parsed = delimiterAlignments(lines[start + 1]) ?? []
        let alignments = (0..<header.count).map { $0 < parsed.count ? parsed[$0] : MarkdownAlignment.leading }
        var index = start + 2
        var rows: [[String]] = []
        while index < lines.count, !isBlank(lines[index]), lines[index].contains("|") {
            var row = Array(cells(lines[index]).prefix(header.count))
            row.append(contentsOf: Array(repeating: "", count: header.count - row.count))
            rows.append(row)
            index += 1
        }
        return (.table(alignments, header, rows), index)
    }

    // MARK: Paragraphs

    private static func interruptsParagraph(_ line: Substring) -> Bool {
        if fenceOpening(line) != nil || heading(line) != nil || isQuote(line) || isRule(line) {
            return true
        }
        guard let marker = listMarker(line) else {
            return false
        }
        // "2. " mid-sentence is a number, not a list; only a list starting at one breaks in.
        return !marker.ordered || marker.number == 1
    }

    private static func readParagraph(_ lines: [Substring], from start: Int, isOpenEnded: Bool) -> (MarkdownRawBlock, Int) {
        var index = start + 1
        var collected = [lines[start]]
        while index < lines.count {
            let line = lines[index]
            if isBlank(line) || interruptsParagraph(line) || isTableStart(lines, at: index, isOpenEnded: isOpenEnded) {
                break
            }
            collected.append(line)
            index += 1
        }
        var text = ""
        for (position, line) in collected.enumerated() {
            let isLast = position == collected.count - 1
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            if isLast {
                text += trimmed.trimmingCharacters(in: isOpenEnded ? CharacterSet() : .whitespaces)
            } else if trimmed.hasSuffix("  ") {
                text += trimmed.trimmingCharacters(in: .whitespaces) + "\n"
            } else if trimmed.hasSuffix("\\") {
                text += trimmed.dropLast() + "\n"
            } else {
                text += trimmed.trimmingCharacters(in: .whitespaces) + " "
            }
        }
        return (.paragraph(text), index)
    }

    // MARK: Styling

    // `isOpenEnded` reaches only the very last piece of text, the one still being written.
    static func finish(_ raw: MarkdownRawBlock, isOpenEnded: Bool) -> MarkdownBlock? {
        switch raw {
        case .heading(let level, let text):
            return .heading(level: level, MarkdownInlineParser.parse(text, isOpenEnded: isOpenEnded))
        case .paragraph(let text):
            let runs = MarkdownInlineParser.parse(text, isOpenEnded: isOpenEnded)
            return runs.isEmpty ? nil : .paragraph(runs)
        case .code(let language, let text):
            return .code(language: language, text: text)
        case .list(let ordered, let start, let items):
            let finished = items.enumerated().map { position, item in
                MarkdownListItem(checked: item.checked, blocks: finish(item.blocks, isOpenEnded: isOpenEnded && position == items.count - 1))
            }
            return .list(ordered: ordered, start: start, items: finished)
        case .quote(let inner):
            return .quote(finish(inner, isOpenEnded: isOpenEnded))
        case .table(let alignments, let header, let rows):
            return .table(
                alignments: alignments,
                header: header.map { MarkdownInlineParser.parse($0) },
                rows: rows.enumerated().map { rowIndex, row in
                    row.enumerated().map { cellIndex, cell in
                        let isTail = isOpenEnded && rowIndex == rows.count - 1 && cellIndex == row.count - 1
                        return MarkdownInlineParser.parse(cell, isOpenEnded: isTail)
                    }
                }
            )
        case .rule:
            return .rule
        }
    }

    static func finish(_ raws: [MarkdownRawBlock], isOpenEnded: Bool) -> [MarkdownBlock] {
        raws.enumerated().compactMap { position, raw in
            finish(raw, isOpenEnded: isOpenEnded && position == raws.count - 1)
        }
    }
}

// A reply's markdown, parsed. While a reply streams it reuses the finished blocks and reparses only the end, so a long reply costs the same per word as a short one.
public struct MarkdownDocument: Sendable {
    public private(set) var blocks: [MarkdownBlock] = []

    private var source = ""
    private var wasOpenEnded = false
    private var settled: [MarkdownBlock] = []
    private var settledBytes = 0

    public init() {}

    public static func parse(_ text: String, isStreaming: Bool = false) -> [MarkdownBlock] {
        var document = MarkdownDocument()
        document.update(text, isStreaming: isStreaming)
        return document.blocks
    }

    public mutating func update(_ text: String, isStreaming: Bool) {
        guard text != source || isStreaming != wasOpenEnded else {
            return
        }
        if !text.hasPrefix(source) {
            settled = []
            settledBytes = 0
        }
        source = text
        wasOpenEnded = isStreaming

        let tail = String(decoding: text.utf8.dropFirst(settledBytes), as: UTF8.self)
        let lines = MarkdownBlockParser.splitLines(tail)
        let located = MarkdownBlockParser.split(lines, isOpenEnded: isStreaming)
        blocks = settled + MarkdownBlockParser.finish(located.map(\.block), isOpenEnded: isStreaming)
        guard isStreaming else {
            return
        }
        // A block is finished once the next has begun on a line with a whole line after it: only then can no later character change where it ended.
        let completeLines = lines.count - 1
        var settledCount = 0
        for position in located.indices.dropFirst() where located[position].firstLine + 2 <= completeLines {
            settledCount = position
        }
        guard settledCount > 0 else {
            return
        }
        settled += MarkdownBlockParser.finish(located[..<settledCount].map(\.block), isOpenEnded: false)
        settledBytes += tail.utf8.distance(from: tail.startIndex, to: lines[located[settledCount].firstLine].startIndex)
    }
}
