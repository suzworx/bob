import Foundation

// One stretch of text in a single style. Pure data: the app turns runs into styled text.
public struct MarkdownRun: Equatable, Sendable {
    public struct Style: OptionSet, Equatable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let bold = Style(rawValue: 1)
        public static let italic = Style(rawValue: 2)
        public static let code = Style(rawValue: 4)
        public static let strikethrough = Style(rawValue: 8)
    }

    public var text: String
    public var style: Style
    public var link: URL?

    public init(_ text: String, style: Style = [], link: URL? = nil) {
        self.text = text
        self.style = style
        self.link = link
    }
}

public enum MarkdownLink {
    private static let allowedSchemes: Set<String> = ["https", "http", "mailto"]

    // Reply text is untrusted: only ordinary web and mail links open, and never one carrying a login in the address.
    public static func safeURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), allowedSchemes.contains(scheme) else {
            return nil
        }
        if scheme == "mailto" {
            return url
        }
        guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else {
            return nil
        }
        return url
    }
}

// Bold, italic, code, strikethrough and links inside one block.
// `isOpenEnded` is for the text still arriving: an unclosed marker styles what follows it rather than showing up as a stray character.
struct MarkdownInlineParser {
    private static let maxDepth = 8
    private static let trailingMarkers: Set<Character> = ["*", "_", "~", "`"]
    private static let entities: [(String, Character)] = [("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&nbsp;", "\u{A0}")]
    private static let urlTrailingPunctuation: Set<Character> = [".", ",", ";", ":", "!", "?", "'", "\"", ")", "]", "*", "_", "~"]

    private let chars: [Character]
    private let isOpenEnded: Bool
    private var runs: [MarkdownRun] = []
    // Markers known to have no closer from here on: remembered so a long run of them stays linear.
    private var unclosed: Set<String> = []

    static func parse(_ text: String, isOpenEnded: Bool = false) -> [MarkdownRun] {
        var chars = Array(text)
        if isOpenEnded {
            while let last = chars.last, trailingMarkers.contains(last) {
                chars.removeLast()
            }
        }
        var parser = MarkdownInlineParser(chars: chars, isOpenEnded: isOpenEnded)
        parser.parse(0..<chars.count, style: [], link: nil, depth: 0)
        return parser.runs
    }

    private init(chars: [Character], isOpenEnded: Bool) {
        self.chars = chars
        self.isOpenEnded = isOpenEnded
    }

    private mutating func append(_ text: String, _ style: MarkdownRun.Style, _ link: URL?) {
        guard !text.isEmpty else {
            return
        }
        if let last = runs.indices.last, runs[last].style == style, runs[last].link == link {
            runs[last].text += text
        } else {
            runs.append(MarkdownRun(text, style: style, link: link))
        }
    }

    private mutating func parse(_ range: Range<Int>, style: MarkdownRun.Style, link: URL?, depth: Int) {
        var index = range.lowerBound
        let end = range.upperBound
        while index < end {
            let char = chars[index]
            if depth < Self.maxDepth, let next = special(at: index, end: end, style: style, link: link, depth: depth) {
                index = next
                continue
            }
            if char == "\\", index + 1 < end, chars[index + 1].isPunctuation || chars[index + 1].isSymbol {
                append(String(chars[index + 1]), style, link)
                index += 2
            } else if char == "\\", index + 1 < end, chars[index + 1] == "\n" {
                append("\n", style, link)
                index += 2
            } else if char == "&", let entity = entity(at: index, end: end) {
                append(String(entity.value), style, link)
                index += entity.length
            } else {
                append(String(char), style, link)
                index += 1
            }
        }
    }

    private mutating func special(at index: Int, end: Int, style: MarkdownRun.Style, link: URL?, depth: Int) -> Int? {
        switch chars[index] {
        case "`":
            return codeSpan(at: index, end: end, style: style, link: link)
        case "!":
            guard index + 1 < end, chars[index + 1] == "[" else {
                return nil
            }
            // An image in a reply is never fetched: its description stands in.
            return bracketLink(at: index + 1, end: end, style: style, link: link, depth: depth)
        case "[":
            return bracketLink(at: index, end: end, style: style, link: link, depth: depth)
        case "<":
            return angleLink(at: index, end: end, style: style, link: link)
        case "h", "w":
            return link == nil ? bareLink(at: index, end: end, style: style) : nil
        case "*", "_", "~":
            return emphasis(at: index, end: end, style: style, link: link, depth: depth)
        default:
            return nil
        }
    }

    private func entity(at index: Int, end: Int) -> (value: Character, length: Int)? {
        for (name, value) in Self.entities where index + name.count <= end {
            if String(chars[index..<(index + name.count)]) == name {
                return (value, name.count)
            }
        }
        return nil
    }

    private func runLength(of char: Character, at index: Int, end: Int) -> Int {
        var cursor = index
        while cursor < end, chars[cursor] == char {
            cursor += 1
        }
        return cursor - index
    }

    private mutating func codeSpan(at index: Int, end: Int, style: MarkdownRun.Style, link: URL?) -> Int {
        let length = runLength(of: "`", at: index, end: end)
        let start = index + length
        var cursor = start
        if !unclosed.contains("`\(length)") {
            while cursor < end {
                guard chars[cursor] == "`" else {
                    cursor += 1
                    continue
                }
                let closing = runLength(of: "`", at: cursor, end: end)
                if closing == length {
                    appendCode(start..<cursor, style, link)
                    return cursor + length
                }
                cursor += closing
            }
            if end == chars.count {
                unclosed.insert("`\(length)")
            }
        }
        if isOpenEnded, end == chars.count {
            appendCode(start..<end, style, link)
            return end
        }
        append(String(repeating: "`", count: length), style, link)
        return start
    }

    private mutating func appendCode(_ range: Range<Int>, _ style: MarkdownRun.Style, _ link: URL?) {
        var text = String(chars[range]).replacingOccurrences(of: "\n", with: " ")
        if text.count > 2, text.hasPrefix(" "), text.hasSuffix(" ") {
            text = String(text.dropFirst().dropLast())
        }
        append(text, style.union(.code), link)
    }

    // [words](address). The words are kept whatever the address is; only a safe address becomes a link.
    private mutating func bracketLink(at index: Int, end: Int, style: MarkdownRun.Style, link: URL?, depth: Int) -> Int? {
        guard !unclosed.contains("["), let close = matching("[", "]", from: index, end: end) else {
            if end == chars.count {
                unclosed.insert("[")
            }
            return nil
        }
        guard close + 1 < end, chars[close + 1] == "(" else {
            return nil
        }
        guard let closeParen = matching("(", ")", from: close + 1, end: end) else {
            // The address is still arriving, so show the words and hold it back.
            guard isOpenEnded, end == chars.count else {
                return nil
            }
            parse((index + 1)..<close, style: style, link: link, depth: depth + 1)
            return end
        }
        let target = linkTarget((close + 2)..<closeParen)
        parse((index + 1)..<close, style: style, link: link ?? MarkdownLink.safeURL(target), depth: depth + 1)
        return closeParen + 1
    }

    private func linkTarget(_ range: Range<Int>) -> String {
        var target = String(chars[range]).trimmingCharacters(in: .whitespaces)
        if target.hasPrefix("<"), let close = target.firstIndex(of: ">") {
            return String(target[target.index(after: target.startIndex)..<close])
        }
        if let space = target.firstIndex(where: \.isWhitespace) {
            target = String(target[..<space])
        }
        return target
    }

    private func matching(_ open: Character, _ close: Character, from index: Int, end: Int) -> Int? {
        var depth = 0
        var cursor = index
        while cursor < end {
            let char = chars[cursor]
            if char == "\\" {
                cursor += 2
                continue
            }
            if char == open {
                depth += 1
            } else if char == close {
                depth -= 1
                if depth == 0 {
                    return cursor
                }
            }
            cursor += 1
        }
        return nil
    }

    private mutating func angleLink(at index: Int, end: Int, style: MarkdownRun.Style, link: URL?) -> Int? {
        var cursor = index + 1
        while cursor < end, chars[cursor] != ">", !chars[cursor].isWhitespace, cursor - index < 2048 {
            cursor += 1
        }
        guard cursor < end, chars[cursor] == ">", let url = MarkdownLink.safeURL(String(chars[(index + 1)..<cursor])), url.scheme?.lowercased() != "mailto" else {
            return nil
        }
        append(String(chars[(index + 1)..<cursor]), style, link ?? url)
        return cursor + 1
    }

    private func hasPrefix(_ prefix: String, at index: Int, end: Int) -> Bool {
        let wanted = Array(prefix)
        guard index + wanted.count <= end else {
            return false
        }
        for offset in wanted.indices where chars[index + offset].lowercased() != String(wanted[offset]) {
            return false
        }
        return true
    }

    private mutating func bareLink(at index: Int, end: Int, style: MarkdownRun.Style) -> Int? {
        if index > 0, chars[index - 1].isLetter || chars[index - 1].isNumber {
            return nil
        }
        let isWWW = hasPrefix("www.", at: index, end: end)
        guard isWWW || hasPrefix("https://", at: index, end: end) || hasPrefix("http://", at: index, end: end) else {
            return nil
        }
        var cursor = index
        while cursor < end, !chars[cursor].isWhitespace, chars[cursor] != "<" {
            cursor += 1
        }
        while cursor > index, Self.urlTrailingPunctuation.contains(chars[cursor - 1]) {
            if chars[cursor - 1] == ")", chars[index..<cursor].filter({ $0 == "(" }).count >= chars[index..<cursor].filter({ $0 == ")" }).count {
                break
            }
            cursor -= 1
        }
        let text = String(chars[index..<cursor])
        guard let url = MarkdownLink.safeURL(isWWW ? "https://\(text)" : text) else {
            return nil
        }
        append(text, style, url)
        return cursor
    }

    private mutating func emphasis(at index: Int, end: Int, style: MarkdownRun.Style, link: URL?, depth: Int) -> Int? {
        let char = chars[index]
        let available = runLength(of: char, at: index, end: end)
        let length: Int
        let added: MarkdownRun.Style
        if char == "~" {
            guard available == 2 else {
                return nil
            }
            (length, added) = (2, .strikethrough)
        } else if available >= 3 {
            (length, added) = (3, [.bold, .italic])
        } else if available == 2 {
            (length, added) = (2, .bold)
        } else {
            (length, added) = (1, .italic)
        }
        let start = index + length
        guard start < end, !chars[start].isWhitespace else {
            return nil
        }
        // An underscore inside a word (snake_case) is just an underscore.
        if char == "_", index > 0, chars[index - 1].isLetter || chars[index - 1].isNumber {
            return nil
        }
        let key = String(repeating: char, count: length)
        if !unclosed.contains(key) {
            if let close = closer(of: char, length: length, from: start, end: end) {
                parse(start..<close, style: style.union(added), link: link, depth: depth + 1)
                return close + length
            }
            if end == chars.count {
                unclosed.insert(key)
            }
        }
        if isOpenEnded, end == chars.count {
            parse(start..<end, style: style.union(added), link: link, depth: depth + 1)
            return end
        }
        return nil
    }

    private func closer(of char: Character, length: Int, from start: Int, end: Int) -> Int? {
        var cursor = start
        while cursor < end {
            let current = chars[cursor]
            if current == "\\" {
                cursor += 2
            } else if current == "`" {
                let ticks = runLength(of: "`", at: cursor, end: end)
                cursor = closingTicks(ticks, from: cursor + ticks, end: end) ?? (cursor + ticks)
            } else if current == char {
                let found = runLength(of: char, at: cursor, end: end)
                let afterOK = char != "_" || cursor + found >= end || !(chars[cursor + found].isLetter || chars[cursor + found].isNumber)
                // A single marker steps over a "**" pair, which is bold inside the italic.
                let fits = found >= length && !(length == 1 && found == 2)
                if fits, cursor > start, !chars[cursor - 1].isWhitespace, afterOK {
                    return cursor + found - length
                }
                cursor += found
            } else {
                cursor += 1
            }
        }
        return nil
    }

    private func closingTicks(_ length: Int, from start: Int, end: Int) -> Int? {
        var cursor = start
        while cursor < end {
            guard chars[cursor] == "`" else {
                cursor += 1
                continue
            }
            let found = runLength(of: "`", at: cursor, end: end)
            if found == length {
                return cursor + found
            }
            cursor += found
        }
        return nil
    }
}
