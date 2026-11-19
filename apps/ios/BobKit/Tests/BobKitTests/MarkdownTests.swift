import XCTest
@testable import BobKit

final class MarkdownTests: XCTestCase {
    private func plain(_ text: String) -> [MarkdownRun] { [MarkdownRun(text)] }

    private func inline(_ text: String, open: Bool = false) -> [MarkdownRun] {
        MarkdownInlineParser.parse(text, isOpenEnded: open)
    }

    func testHeadingsParagraphsAndRules() {
        XCTAssertEqual(MarkdownDocument.parse("# One\n\n### Three ###\nText\nmore\n\n---\n\n#nospace"), [
            .heading(level: 1, plain("One")),
            .heading(level: 3, plain("Three")),
            .paragraph(plain("Text more")),
            .rule,
            .paragraph(plain("#nospace"))
        ])
    }

    func testInlineStyles() {
        XCTAssertEqual(inline("a **b** *c* `d` ~~e~~ ***f***"), [
            MarkdownRun("a "), MarkdownRun("b", style: .bold), MarkdownRun(" "), MarkdownRun("c", style: .italic), MarkdownRun(" "),
            MarkdownRun("d", style: .code), MarkdownRun(" "), MarkdownRun("e", style: .strikethrough), MarkdownRun(" "),
            MarkdownRun("f", style: [.bold, .italic])
        ])
    }

    func testNestedStyleAndNoStyleInsideCode() {
        XCTAssertEqual(inline("*a **b** c*"), [
            MarkdownRun("a ", style: .italic), MarkdownRun("b", style: [.italic, .bold]), MarkdownRun(" c", style: .italic)
        ])
        XCTAssertEqual(inline("`**x**`"), [MarkdownRun("**x**", style: .code)])
    }

    func testThingsThatLookLikeMarkersStayText() {
        XCTAssertEqual(inline("2 * 3 * 4"), plain("2 * 3 * 4"))
        XCTAssertEqual(inline("snake_case_name"), plain("snake_case_name"))
        XCTAssertEqual(inline(#"\*not\*"#), plain("*not*"))
        XCTAssertEqual(inline("**unclosed"), plain("**unclosed"))
        XCTAssertEqual(inline("AT&amp;T"), plain("AT&T"))
    }

    func testOnlySafeLinksBecomeLinks() {
        let url = URL(string: "https://example.com/a")!
        XCTAssertEqual(inline("[go](https://example.com/a)"), [MarkdownRun("go", link: url)])
        XCTAssertEqual(inline("[go](javascript:alert(1))"), plain("go"))
        XCTAssertEqual(inline("[go](file:///etc/passwd)"), plain("go"))
        XCTAssertEqual(inline("[go](https://user:pw@example.com)"), plain("go"))
        XCTAssertEqual(inline("[go](relative/path)"), plain("go"))
        XCTAssertEqual(inline("[mail](mailto:a@b.com)"), [MarkdownRun("mail", link: URL(string: "mailto:a@b.com"))])
    }

    func testBareAndAngleLinksStopBeforeTrailingPunctuation() {
        let url = URL(string: "https://example.com/a")!
        XCTAssertEqual(inline("See https://example.com/a."), [MarkdownRun("See "), MarkdownRun("https://example.com/a", link: url), MarkdownRun(".")])
        XCTAssertEqual(inline("<https://example.com/a>"), [MarkdownRun("https://example.com/a", link: url)])
        XCTAssertEqual(inline("www.example.com"), [MarkdownRun("www.example.com", link: URL(string: "https://www.example.com"))])
        XCTAssertEqual(inline("washington"), plain("washington"))
    }

    func testImagesAreNeverFetchedAndShowTheirDescription() {
        XCTAssertEqual(inline("![a cat](javascript:x)"), plain("a cat"))
    }

    func testCodeBlocks() {
        XCTAssertEqual(MarkdownDocument.parse("```swift title\nlet a = 1\n  **b**\n```\nafter"), [
            .code(language: "swift", text: "let a = 1\n  **b**"),
            .paragraph(plain("after"))
        ])
        XCTAssertEqual(MarkdownDocument.parse("```\nnever closed\n# x"), [.code(language: nil, text: "never closed\n# x")])
    }

    func testLists() {
        let item = { (text: String) in MarkdownListItem(blocks: [.paragraph(self.plain(text))]) }
        XCTAssertEqual(MarkdownDocument.parse("- a\n- b"), [.list(ordered: false, start: 1, items: [item("a"), item("b")])])
        XCTAssertEqual(MarkdownDocument.parse("3. a\n4. b\n\ntext"), [
            .list(ordered: true, start: 3, items: [item("a"), item("b")]),
            .paragraph(plain("text"))
        ])
    }

    func testNestedListsEvenWhenIndentedLessThanTheMarker() {
        let expected: [MarkdownBlock] = [.list(ordered: true, start: 1, items: [
            MarkdownListItem(blocks: [
                .paragraph(plain("a")),
                .list(ordered: false, start: 1, items: [MarkdownListItem(blocks: [.paragraph(plain("b"))])])
            ]),
            MarkdownListItem(blocks: [.paragraph(plain("c"))])
        ])]
        XCTAssertEqual(MarkdownDocument.parse("1. a\n  - b\n2. c"), expected)
        XCTAssertEqual(MarkdownDocument.parse("1. a\n   - b\n2. c"), expected)
    }

    func testTasksAndLooseLists() {
        XCTAssertEqual(MarkdownDocument.parse("- [x] done\n\n- [ ] todo"), [.list(ordered: false, start: 1, items: [
            MarkdownListItem(checked: true, blocks: [.paragraph(plain("done"))]),
            MarkdownListItem(checked: false, blocks: [.paragraph(plain("todo"))])
        ])])
    }

    func testBlockQuoteHoldsBlocks() {
        XCTAssertEqual(MarkdownDocument.parse("> # H\n> line\n\nout"), [
            .quote([.heading(level: 1, plain("H")), .paragraph(plain("line"))]),
            .paragraph(plain("out"))
        ])
    }

    func testTablesAlignPadAndCut() {
        XCTAssertEqual(MarkdownDocument.parse("| a | b |\n|:--|--:|\n| 1 |\n| 2 | 3 | 4 |\n| `x|y` | \\| |\n\nend"), [
            .table(alignments: [.leading, .trailing], header: [plain("a"), plain("b")], rows: [
                [plain("1"), []],
                [plain("2"), plain("3")],
                [[MarkdownRun("x|y", style: .code)], plain("|")]
            ]),
            .paragraph(plain("end"))
        ])
    }

    func testAPipeWithoutADelimiterRowIsASentence() {
        XCTAssertEqual(MarkdownDocument.parse("a | b\nc | d"), [.paragraph(plain("a | b c | d"))])
    }

    // MARK: Streaming

    func testUnclosedMarkersStyleWhatFollowsWhileStreaming() {
        XCTAssertEqual(inline("a **bo", open: true), [MarkdownRun("a "), MarkdownRun("bo", style: .bold)])
        XCTAssertEqual(inline("a **bo*", open: true), [MarkdownRun("a "), MarkdownRun("bo", style: .bold)])
        XCTAssertEqual(inline("a `co", open: true), [MarkdownRun("a "), MarkdownRun("co", style: .code)])
        XCTAssertEqual(inline("a **", open: true), plain("a "))
    }

    func testALinkStillArrivingShowsItsWords() {
        XCTAssertEqual(inline("[go](https://exa", open: true), plain("go"))
    }

    func testATableHeaderDoesNotFlashAsASentence() {
        guard case .table(_, let header, let rows) = MarkdownDocument.parse("| a | b |\n|--", isStreaming: true).first else {
            return XCTFail("expected a table")
        }
        XCTAssertEqual(header, [plain("a"), plain("b")])
        XCTAssertEqual(rows, [])
    }

    func testOnlyTheLastBlockIsTreatedAsOpen() {
        XCTAssertEqual(MarkdownDocument.parse("**a\n\n**b", isStreaming: true), [
            .paragraph(plain("**a")),
            .paragraph([MarkdownRun("b", style: .bold)])
        ])
    }

    private static let sample = """
    # Title

    A paragraph with **bold**, *italic*, `code` and [a link](https://example.com).
    Second line  
    hard break

    - one
      - nested
    - two

    1. first
    2. second

    > quoted
    > more

    | a | b |
    |---|:-:|
    | 1 | 2 |
    | 3 | 4 |

    ```swift
    let x = "é🙂"

    print(x)
    ```

    ---
    para then
    ---x
    a|b
    |-|-x

    Ending with ***style***🙂\r
    CRLF line
    """

    // Reusing finished blocks must never give a different answer from parsing the whole text.
    func testIncrementalParsingMatchesAFullParseAtEveryPrefix() {
        var document = MarkdownDocument()
        var text = ""
        for char in Self.sample {
            text.append(char)
            document.update(text, isStreaming: true)
            XCTAssertEqual(document.blocks, MarkdownDocument.parse(text, isStreaming: true), "at: \(text.suffix(20))")
        }
        document.update(text, isStreaming: false)
        XCTAssertEqual(document.blocks, MarkdownDocument.parse(text))
    }

    func testChangedTextStartsAgain() {
        var document = MarkdownDocument()
        document.update("one\n\ntwo\n\nthree\n\nfour\n", isStreaming: true)
        document.update("other", isStreaming: true)
        XCTAssertEqual(document.blocks, [.paragraph(plain("other"))])
    }

    func testHostileInputNeverCrashes() {
        let inputs = [
            String(repeating: "*", count: 20_000),
            String(repeating: "**a ", count: 5_000),
            String(repeating: "[", count: 20_000),
            String(repeating: "`", count: 20_001) + "x",
            String(repeating: "> ", count: 5_000) + "deep",
            (0..<2_000).map { String(repeating: " ", count: $0 % 40) + "- x" }.joined(separator: "\n"),
            String(repeating: "|", count: 5_000) + "\n" + String(repeating: "|-", count: 2_500),
            "\u{0}\u{FEFF}\r\n\r\n```\r\n",
            ""
        ]
        for input in inputs {
            _ = MarkdownDocument.parse(input)
            _ = MarkdownDocument.parse(input, isStreaming: true)
        }
    }

    func testAVeryLongStreamStaysFast() {
        let paragraph = "Some **bold** words and `code` with a [link](https://example.com) in them.\n\n"
        let chunks = Array(repeating: paragraph, count: 2_000)
        var document = MarkdownDocument()
        var text = ""
        let started = Date()
        for chunk in chunks {
            text += chunk
            document.update(text, isStreaming: true)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual(document.blocks.count, 2_000)
    }
}
