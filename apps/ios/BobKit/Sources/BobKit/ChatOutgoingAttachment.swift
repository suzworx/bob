import Foundation

public enum ChatAttachmentError: Error, Equatable, Sendable {
    case unsupported, empty, fileTooLarge, tooMany, totalTooLarge, unreadable
    public var message: String {
        switch self {
        case .unsupported: "Choose a PDF, Word document, text file, or PNG, JPEG, WebP or GIF image."
        case .empty: "That file is empty."
        case .fileTooLarge: "That file is larger than 4 MB."
        case .tooMany: "Attach up to four files to one message."
        case .totalTooLarge: "Those files come to more than 8 MB together. Remove one and try again."
        case .unreadable: "That file couldn't be read. Please choose it again."
        }
    }
}

/// Prepared in memory, sent only as part of the authenticated chat request. No separate upload exists.
public struct ChatOutgoingAttachment: Identifiable, Equatable, Sendable {
    public static let maxFileBytes = 4 * 1024 * 1024
    public static let maxMessageBytes = 8 * 1024 * 1024
    public static let allowedTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
    public let id: UUID
    public let name: String
    public let mediaType: String
    public let data: Data
    public init(name: String, mediaType: String, data: Data) throws {
        guard Self.allowedTypes.contains(mediaType.lowercased()), !name.isEmpty, name.utf16.count <= 255 else { throw ChatAttachmentError.unsupported }
        guard !data.isEmpty else { throw ChatAttachmentError.empty }
        guard data.count <= Self.maxFileBytes else { throw ChatAttachmentError.fileTooLarge }
        id = UUID()
        self.name = name
        self.mediaType = mediaType.lowercased()
        self.data = data
    }
    public init(stored: ChatAttachment) throws {
        guard let data = stored.decodedData(), let type = stored.mediaType else { throw ChatAttachmentError.unreadable }
        try self.init(name: stored.displayName, mediaType: type, data: data)
    }
    public var dataURL: String { "data:\(mediaType);base64,\(data.base64EncodedString())" }
    public var display: ChatAttachment { ChatAttachment(name: name, mediaType: mediaType, url: dataURL) }
    public static func validate(_ attachments: [Self]) throws {
        guard attachments.count <= 4 else { throw ChatAttachmentError.tooMany }
        guard attachments.reduce(0, { $0 + $1.data.count }) <= maxMessageBytes else { throw ChatAttachmentError.totalTooLarge }
    }
}
