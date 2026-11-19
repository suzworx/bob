import BobKit
import SwiftUI

// One message in the chat list, with the typing dots, a "Stopped" note or the error row under Bob's reply.
struct ChatMessageRow: View {
    let message: ChatMessage
    var failureMessage: String? = nil
    // In a shared chat, the people who can be mentioned. Nil in a private one.
    var handles: [String]? = nil
    var onRetry: () -> Void = {}

    @ScaledMetric(relativeTo: .caption) private var noteSpacing: CGFloat = 4
    // Fixed so large text keeps the width for the words.
    private let errorSpacing: CGFloat = 8

    var body: some View {
        VStack(alignment: message.isMine ? .trailing : .leading, spacing: noteSpacing) {
            if !message.isMine, let author = message.author {
                authorLine(author)
            }
            if !message.attachments.isEmpty {
                ChatAttachmentsView(attachments: message.attachments, alignment: message.isMine ? .trailing : .leading)
            }
            content
            if let meta = metaLine {
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            switch message.state {
            case .stopped:
                Text("Stopped")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .failed:
                if let failureMessage {
                    errorRow(failureMessage)
                }
            case .complete, .streaming:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: message.isMine ? .trailing : .leading)
    }

    private func authorLine(_ author: ChatAuthor) -> some View {
        HStack(spacing: 6) {
            if message.role == .bob {
                Image("BobPlayful").resizable().scaledToFit().frame(width: 24, height: 24).accessibilityHidden(true)
            } else {
                BobAvatar(initials: author.initials, fillIndex: author.fillIndex)
            }
            Text(author.name).font(BobFont.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var content: some View {
        if message.isDeleted {
            Text("Message deleted")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
        } else if message.role == .bob {
            if message.state == .streaming, message.parts.isEmpty {
                BobTypingDots()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Bob is typing")
            } else {
                ChatReplyView(parts: message.parts, isLive: message.state == .streaming)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(BobColor.bobBubble, in: RoundedRectangle(cornerRadius: 12))
            }
        } else if !message.text.isEmpty {
            BobChatBubble(text: message.text, isFromBob: false, speaker: message.isMine ? nil : message.author?.name, handles: handles)
        }
    }

    // The time and where it was said, quietly on one line. Nothing yet while Bob is only typing.
    private var metaLine: String? {
        guard message.role == .person || !message.parts.isEmpty else {
            return nil
        }
        let pieces = [message.createdAt.map { ChatTimeFormat.text($0) }, message.originNote, message.isEdited ? "edited" : nil].compactMap { $0 }
        return pieces.isEmpty ? nil : pieces.joined(separator: " · ")
    }

    private func errorRow(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: errorSpacing) {
            Label {
                Text(text)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.circle")
            }
            .font(BobFont.subline)
            .foregroundStyle(BobColor.dangerText)
            .accessibilityElement(children: .combine)
            BobPill(title: "Try again", action: onRetry)
        }
    }
}

// Three dots that take turns rising while Bob thinks; still under Reduce Motion.
private struct BobTypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                if reduceMotion {
                    dot
                } else {
                    dot.phaseAnimator([false, true]) { view, up in
                        view.offset(y: up ? -3 : 2)
                    } animation: { _ in
                        .easeInOut(duration: 0.45).delay(Double(index) * 0.12)
                    }
                }
            }
        }
        .padding(.vertical, 8)
    }

    private var dot: some View {
        Circle().fill(.secondary).frame(width: 7, height: 7)
    }
}

#Preview {
    var transcript = ChatTranscript()
    transcript.beginTurn(userMessageID: "p1", replyMessageID: "b1", text: "What's on today?", at: Date())
    transcript.apply(.textDelta(id: "t1", delta: "You have **two** things"))
    transcript.fail(.offline)
    var typing = ChatTranscript()
    typing.beginTurn(userMessageID: "p2", replyMessageID: "b2", text: "And tomorrow?")
    return VStack(spacing: 12) {
        ForEach(transcript.messages + typing.messages) { message in
            ChatMessageRow(message: message, failureMessage: transcript.failureMessage)
        }
    }
    .padding(16)
    .bobPage()
}
