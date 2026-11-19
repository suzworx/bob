import BobKit
import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatAttachmentPicker: View {
    let model: ChatViewModel
    var onDictate: (() -> Void)? = nil
    @State private var choosingFiles = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        Menu {
            Button("Choose files", systemImage: "doc") { choosingFiles = true }
            PhotosPicker(selection: $photos, maxSelectionCount: 4, matching: .images, preferredItemEncoding: .compatible) {
                Label("Choose photos", systemImage: "photo")
            }
            if let onDictate {
                Divider()
                Button("Dictate into message", systemImage: "mic", action: onDictate)
                    .disabled(model.openPhase != .ready)
            }
        } label: {
            Image(systemName: "plus").font(.title3).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel("Message options: attachments and dictation")
        .disabled(!model.isIdle || model.transcript.isStreaming || model.preparingAttachments)
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: Self.fileTypes, allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                model.prepareAttachments {
                    try await Task.detached(priority: .userInitiated) {
                        guard urls.count <= 4 else { throw ChatAttachmentError.tooMany }
                        return try urls.map(ChatAttachmentLoader.read)
                    }.value
                }
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError { model.attachmentError = ChatAttachmentError.unreadable.message }
            }
        }
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            model.prepareAttachments {
                var files: [ChatOutgoingAttachment] = []
                for item in items {
                    try Task.checkCancellation()
                    guard let photo = try await item.loadTransferable(type: PickedChatPhoto.self) else { throw ChatAttachmentError.unreadable }
                    files.append(photo.file)
                }
                return files
            }
        }
    }

    private static var fileTypes: [UTType] {
        ChatOutgoingAttachment.allowedTypes.compactMap { UTType(mimeType: $0) }
    }
}

private struct PickedChatPhoto: Transferable {
    let file: ChatOutgoingAttachment
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            PickedChatPhoto(file: try ChatAttachmentLoader.read(received.file))
        }
    }
}

private enum ChatAttachmentLoader {
    nonisolated static func read(_ url: URL) throws -> ChatOutgoingAttachment {
        guard url.isFileURL else { throw ChatAttachmentError.unreadable }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        if let size, size > ChatOutgoingAttachment.maxFileBytes { throw ChatAttachmentError.fileTooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        // The bounded read still protects us if the provider's reported size is missing or changes.
        var data = Data()
        while data.count <= ChatOutgoingAttachment.maxFileBytes {
            try Task.checkCancellation()
            let remaining = ChatOutgoingAttachment.maxFileBytes + 1 - data.count
            guard let chunk = try handle.read(upToCount: remaining), !chunk.isEmpty else { break }
            data.append(chunk)
        }
        let mediaType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        return try ChatOutgoingAttachment(name: url.lastPathComponent, mediaType: mediaType, data: data)
    }
}
