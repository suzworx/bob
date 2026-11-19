import BobKit
import ImageIO
import SwiftUI
import QuickLook
import UniformTypeIdentifiers
import UIKit

// A whole reply in the order it happened: thinking and tool work quietly, the words on the page.
struct ChatReplyView: View {
    let parts: [ChatReplyPart]
    let isLive: Bool

    @ScaledMetric(relativeTo: .body) private var spacing: CGFloat = 8

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(parts.indices, id: \.self) { index in
                switch parts[index] {
                case .text(let text):
                    if !text.isEmpty {
                        ChatMarkdownView(text: text, isStreaming: isLive && index == parts.count - 1)
                    }
                case .reasoning(let text, let isStreaming):
                    ChatReasoningView(text: text, isStreaming: isLive && isStreaming)
                case .tools(let calls):
                    ChatToolActivityView(calls: calls, isLive: isLive)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Bob's reply")
    }
}

// One quiet line with a chevron, opening onto more. Shared by thinking and tool work.
private struct ChatDisclosure<Label: View, Content: View>: View {
    let accessibilityText: String
    @ViewBuilder let label: () -> Label
    @ViewBuilder let content: () -> Content

    @State private var isOpen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if reduceMotion {
                    isOpen.toggle()
                } else {
                    withAnimation(.easeOut(duration: 0.2)) { isOpen.toggle() }
                }
            } label: {
                HStack(spacing: 6) {
                    label()
                    Image(systemName: "chevron.right")
                        .font(BobFont.subline.weight(.medium))
                        .imageScale(.small)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.secondary)
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityValue(isOpen ? "Open" : "Closed")
            .accessibilityAddTraits(.isButton)
            if isOpen {
                content()
                    .transition(.opacity)
            }
        }
    }
}

// "Thinking..." then "Thought for 12 seconds", closed until asked for. The time is measured here, as the web does.
private struct ChatReasoningView: View {
    let text: String
    let isStreaming: Bool

    @State private var startedAt: Date?
    @State private var seconds: Int?

    private var label: String {
        ChatReplyPart.thoughtLabel(isStreaming: isStreaming, seconds: seconds)
    }

    var body: some View {
        ChatDisclosure(accessibilityText: label) {
            Text(label).font(BobFont.subline)
        } content: {
            ChatMarkdownView(text: text, isStreaming: isStreaming, font: BobFont.subline)
                .foregroundStyle(.secondary)
        }
        .onAppear { if isStreaming { startedAt = Date() } }
        .onChange(of: isStreaming) { _, streaming in
            if streaming {
                startedAt = Date()
            } else if let startedAt {
                seconds = Int(Date().timeIntervalSince(startedAt).rounded())
                self.startedAt = nil
            }
        }
    }
}

// One call is one line. Several fold under the latest, as the web folds them.
private struct ChatToolActivityView: View {
    let calls: [ChatToolActivity]
    let isLive: Bool

    var body: some View {
        if calls.count == 1, let call = calls.first {
            ToolLine(call: call, isLive: isLive)
                .frame(minHeight: 28, alignment: .leading)
        } else if let latest = calls.last {
            ChatDisclosure(accessibilityText: "\(latest.label). \(calls.count) steps") {
                ToolLine(call: latest, isLive: isLive)
            } content: {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(calls) { ToolLine(call: $0, isLive: isLive) }
                }
            }
        }
    }
}

private struct ToolLine: View {
    let call: ChatToolActivity
    let isLive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 6) {
            status
                .accessibilityHidden(true)
            Text(call.label)
                .font(BobFont.subline)
                .foregroundStyle(isFailure ? BobColor.dangerText : .secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var isFailure: Bool {
        call.status == .failed || call.status == .denied
    }

    @ViewBuilder private var status: some View {
        switch call.status {
        case .running:
            if isLive, !reduceMotion {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: "ellipsis").imageScale(.small).foregroundStyle(.secondary)
            }
        case .done:
            Image(systemName: "checkmark").imageScale(.small).foregroundStyle(.secondary)
        case .failed, .denied:
            Image(systemName: "exclamationmark.circle").imageScale(.small).foregroundStyle(BobColor.dangerText)
        }
    }
}

// Files on a past message: images themselves, anything else by name and size. Decoded in memory only.
struct ChatAttachmentsView: View {
    let attachments: [ChatAttachment]
    let alignment: HorizontalAlignment

    var body: some View {
        VStack(alignment: alignment, spacing: 8) {
            ForEach(attachments.indices, id: \.self) { index in
                let attachment = attachments[index]
                if attachment.isImage {
                    ChatImageAttachment(attachment: attachment)
                } else {
                    ChatFileLine(attachment: attachment)
                }
            }
        }
    }
}

private struct ChatFileLine: View {
    let attachment: ChatAttachment
    @State private var preview: URL?
    @State private var directory: URL?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: openPreview) {
                Label(attachment.summary, systemImage: "paperclip")
                    .font(BobFont.subline)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 44)
            }
            .disabled(attachment.byteCount == nil)
            .accessibilityLabel("Preview \(attachment.summary)")
            if let error { Text(error).font(BobFont.caption).foregroundStyle(BobColor.dangerText) }
        }
        .quickLookPreview($preview)
        .onChange(of: preview) { _, value in if value == nil { cleanUp() } }
        .onDisappear { cleanUp() }
    }

    private func openPreview() {
        do {
            guard let count = attachment.byteCount, count <= ChatOutgoingAttachment.maxFileBytes,
                  let type = attachment.mediaType, ChatOutgoingAttachment.allowedTypes.contains(type),
                  let bytes = attachment.decodedData() else { throw ChatAttachmentError.unreadable }
            cleanUp()
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("bob-preview-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            directory = folder
            let suffix = UTType(mimeType: type)?.preferredFilenameExtension ?? "bin"
            let name = URL(fileURLWithPath: attachment.displayName).lastPathComponent
            let file = folder.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "Attachment.\(suffix)" : name)
            try bytes.write(to: file, options: [.atomic, .completeFileProtection])
            error = nil
            preview = file
        } catch {
            cleanUp()
            self.error = "This file couldn't be previewed."
        }
    }

    private func cleanUp() {
        if let directory { try? FileManager.default.removeItem(at: directory) }
        directory = nil
    }
}

private struct ChatImageAttachment: View {
    let attachment: ChatAttachment

    private enum Phase {
        case loading
        case ready(UIImage)
        case failed
    }

    @State private var phase = Phase.loading
    @ScaledMetric(relativeTo: .body) private var maxSide: CGFloat = 220

    var body: some View {
        Group {
            switch phase {
            case .loading:
                RoundedRectangle(cornerRadius: 12)
                    .fill(BobColor.wash)
                    .frame(width: maxSide * 0.6, height: maxSide * 0.6)
                    .accessibilityLabel("Image: \(attachment.displayName)")
            case .ready(let image):
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxSide, maxHeight: maxSide)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Image: \(attachment.displayName)")
            case .failed:
                ChatFileLine(attachment: attachment)
            }
        }
        .task(id: attachment.displayName) {
            let attachment = attachment
            let side = maxSide * 3
            let image = await Task.detached(priority: .userInitiated) {
                Self.thumbnail(of: attachment, maxPixels: side)
            }.value
            phase = image.map(Phase.ready) ?? .failed
        }
    }

    // A thumbnail rather than the full image, so a 4 MB photo doesn't sit in memory at full size for each row.
    private nonisolated static func thumbnail(of attachment: ChatAttachment, maxPixels: CGFloat) -> UIImage? {
        guard let data = attachment.decodedData(), let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

// Thumbs on a reply. The chosen one fills in and can't be sent again; the other can change it.
struct ChatFeedbackButtons: View {
    let rating: Bool?
    let isEnabled: Bool
    let onRate: (Bool) -> Void

    var body: some View {
        thumb(positive: true, icon: "hand.thumbsup", label: "Helpful response")
        thumb(positive: false, icon: "hand.thumbsdown", label: "Unhelpful response")
    }

    private func thumb(positive: Bool, icon: String, label: String) -> some View {
        let chosen = rating == positive
        return Button { onRate(positive) } label: {
            Image(systemName: chosen ? "\(icon).fill" : icon)
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .disabled(!isEnabled || chosen)
        .accessibilityLabel(label)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

// The message's words, to pick out any part of them. Long-press on the page belongs to the message's menu.
struct ChatSelectTextSheet: View {
    let text: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SelectableTextView(text: text)
                .padding(.horizontal, 16)
                .bobPage()
                .privacySensitive()
                .bobNavTitle("Select text")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
    }
}

private struct SelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.font = .preferredFont(forTextStyle: .body)
        view.dataDetectorTypes = []
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        view.text = text
    }
}
