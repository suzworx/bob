import BobKit
import SwiftUI

// One chat message: Bob's words sit on the page, the person's sit in a quiet bubble on the trailing side.
struct BobChatBubble: View {
    let text: String
    let isFromBob: Bool
    // Someone else in a shared chat. Their message hangs on the other side.
    var speaker: String? = nil
    // Who stands out when mentioned. Nil where nobody can be.
    var handles: [String]? = nil

    // Written by a person, so it stays plain text: no links or markdown from someone else's words.
    private var words: Text {
        guard let handles else { return Text(verbatim: text) }
        var out = AttributedString()
        for segment in RoomMentions.segments(text, handles: handles) {
            var piece = AttributedString(segment.text)
            if segment.isMention { piece.inlinePresentationIntent = .stronglyEmphasized }
            out += piece
        }
        return Text(out)
    }

    private var bubble: some View {
        words
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(BobColor.userBubble, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel(speaker.map { "\($0) said: \(text)" } ?? "You said: \(text)")
    }

    var body: some View {
        if isFromBob {
            ChatMarkdownView(text: text)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack {
                if speaker == nil { Spacer(minLength: 56) }
                bubble
                if speaker != nil { Spacer(minLength: 56) }
            }
        }
    }
}
