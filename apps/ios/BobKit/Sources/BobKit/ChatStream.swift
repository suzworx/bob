import Foundation

// One event of the Vercel AI SDK "UI message stream" that POST /api/chat sends as Server-Sent Events.
public enum ChatStreamEvent: Equatable, Sendable {
    // The server's own time for the reply and the id its feedback attaches to ride on the same metadata.
    case messageStart(messageID: String?, conversationID: String?, title: String?, createdAt: Date? = nil, traceID: String? = nil)
    case textStart(id: String)
    case textDelta(id: String, delta: String)
    case textEnd(id: String)
    case reasoningStart(id: String)
    case reasoningDelta(id: String, delta: String)
    case reasoningEnd(id: String)
    case toolInputStart(toolCallID: String, toolName: String)
    case toolInputAvailable(toolCallID: String, toolName: String)
    case toolInputError(toolCallID: String, toolName: String)
    case toolOutputAvailable(toolCallID: String)
    case toolOutputError(toolCallID: String)
    case toolOutputDenied(toolCallID: String)
    case stepStart
    case stepFinish
    case finish(conversationID: String?, title: String?, traceID: String? = nil)
    case abort
    case error(ApiError)
    case done
    case ignored(type: String)
    case malformed
}

// Turns raw SSE bytes, arriving in arbitrary chunks, into typed events. Pure: no networking, no clocks.
public struct ChatStreamParser: Sendable {
    private static let lineFeed: UInt8 = 0x0A
    private static let carriageReturn: UInt8 = 0x0D
    private static let colon: UInt8 = 0x3A
    private static let space: UInt8 = 0x20
    private static let dataPrefix = Data("data:".utf8)

    private var buffer = Data()
    private var blockDataLines: [Data] = []

    public init() {}

    public mutating func feed(_ data: Data) -> [ChatStreamEvent] {
        buffer.append(data)
        var events: [ChatStreamEvent] = []
        while let newline = buffer.firstIndex(of: Self.lineFeed) {
            let line = Self.stripCarriageReturn(Data(buffer[buffer.startIndex..<newline]))
            buffer = Data(buffer[buffer.index(after: newline)...])
            if line.isEmpty {
                if let event = completeBlock() {
                    events.append(event)
                }
            } else {
                consume(line: line)
            }
        }
        return events
    }

    public mutating func finish() -> [ChatStreamEvent] {
        let remainder = Self.stripCarriageReturn(buffer)
        buffer = Data()
        if !remainder.isEmpty {
            consume(line: remainder)
        }
        guard let event = completeBlock() else {
            return []
        }
        return [event]
    }

    private mutating func consume(line: Data) {
        if line.first == Self.colon {
            return
        }
        guard line.starts(with: Self.dataPrefix) else {
            return
        }
        var value = Data(line.dropFirst(Self.dataPrefix.count))
        if value.first == Self.space {
            value = Data(value.dropFirst())
        }
        blockDataLines.append(value)
    }

    private mutating func completeBlock() -> ChatStreamEvent? {
        guard !blockDataLines.isEmpty else {
            return nil
        }
        var payload = Data()
        for (index, line) in blockDataLines.enumerated() {
            if index > 0 {
                payload.append(Self.lineFeed)
            }
            payload.append(line)
        }
        blockDataLines = []
        return Self.event(from: payload)
    }

    private static func stripCarriageReturn(_ line: Data) -> Data {
        guard line.last == carriageReturn else {
            return line
        }
        return Data(line.dropLast())
    }

    private static func event(from payload: Data) -> ChatStreamEvent {
        guard let text = String(data: payload, encoding: .utf8) else {
            return .malformed
        }
        if text == "[DONE]" {
            return .done
        }
        guard
            let object = try? JSONSerialization.jsonObject(with: payload),
            let fields = object as? [String: Any],
            let type = fields["type"] as? String
        else {
            return .malformed
        }
        return event(type: type, fields: fields) ?? .malformed
    }

    private static func event(type: String, fields: [String: Any]) -> ChatStreamEvent? {
        func string(_ key: String) -> String? {
            fields[key] as? String
        }
        // A new chat's id and title ride on the start and finish parts' messageMetadata.
        func metadata(_ key: String) -> String? {
            (fields["messageMetadata"] as? [String: Any])?[key] as? String
        }
        var createdAt: Date? {
            ((fields["messageMetadata"] as? [String: Any])?["createdAt"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
        }
        var traceID: String? {
            metadata("traceId").flatMap { ReplyFeedback.isTraceID($0) ? $0 : nil }
        }
        switch type {
        case "start":
            return .messageStart(messageID: string("messageId"), conversationID: metadata("conversationId"), title: metadata("title"), createdAt: createdAt, traceID: traceID)
        case "text-start":
            return string("id").map { .textStart(id: $0) }
        case "text-delta":
            guard let id = string("id"), let delta = string("delta") else {
                return nil
            }
            return .textDelta(id: id, delta: delta)
        case "text-end":
            return string("id").map { .textEnd(id: $0) }
        case "reasoning-start":
            return string("id").map { .reasoningStart(id: $0) }
        case "reasoning-delta":
            guard let id = string("id"), let delta = string("delta") else {
                return nil
            }
            return .reasoningDelta(id: id, delta: delta)
        case "reasoning-end":
            return string("id").map { .reasoningEnd(id: $0) }
        case "tool-input-start", "tool-input-available", "tool-input-error":
            guard let toolCallID = string("toolCallId"), let toolName = string("toolName") else {
                return nil
            }
            switch type {
            case "tool-input-start":
                return .toolInputStart(toolCallID: toolCallID, toolName: toolName)
            case "tool-input-available":
                return .toolInputAvailable(toolCallID: toolCallID, toolName: toolName)
            default:
                return .toolInputError(toolCallID: toolCallID, toolName: toolName)
            }
        case "tool-output-available":
            return string("toolCallId").map { .toolOutputAvailable(toolCallID: $0) }
        case "tool-output-error":
            return string("toolCallId").map { .toolOutputError(toolCallID: $0) }
        case "tool-output-denied":
            return string("toolCallId").map { .toolOutputDenied(toolCallID: $0) }
        case "start-step":
            return .stepStart
        case "finish-step":
            return .stepFinish
        case "finish":
            return .finish(conversationID: metadata("conversationId"), title: metadata("title"), traceID: traceID)
        case "abort":
            return .abort
        case "error":
            // The server's own text is never surfaced: only the kind of failure is kept.
            return .error(ApiErrorMapper.mapStreamError(errorText: string("errorText")))
        default:
            return .ignored(type: type)
        }
    }
}
