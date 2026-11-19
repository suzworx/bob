import Foundation

// Where a chat message came from, as the server records it.
public enum ChatOrigin: String, Sendable {
    case text = "web_text"
    case voice = "web_voice"

    // The words shown beside a message, as a stored one has them.
    public var note: String? {
        self == .voice ? "spoken" : nil
    }
}

// What a turn does to the stored conversation, as POST /api/chat names it.
public enum ChatTurn: Equatable, Sendable {
    // Appends the message.
    case new
    // Answers the person's last stored message again; nothing is appended.
    case regenerate
    // Keeps everything up to and including this message, deletes the rest, then appends.
    case edit(after: String)
    // Deletes every message, then appends: the first message has nothing before it to keep.
    case editFromStart
}

// Sends one message to POST /api/chat and streams the reply; stops a running turn with POST /api/chat/stop.
public struct ChatClient: Sendable {
    private static let maxErrorBodyBytes = 65536
    private static let maxFeedBytes = 1024
    private static let lineFeed: UInt8 = 0x0A

    private let baseURL: URL
    private let session: URLSession
    private let auth: RequestAuth

    public init(baseURL: URL, session: URLSession = .shared, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.auth = RequestAuth(accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // Does its work when iterated; every failure is thrown as an ApiError, and cancelling ends the stream quietly.
    public func send(text: String, messageID: String, conversationID: String? = nil, origin: ChatOrigin = .text, turn: ChatTurn = .new, workflowID: String? = nil, appBinding: ChatAppBinding? = nil, attachments: [ChatOutgoingAttachment] = []) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        var request = SendBody(
            id: conversationID,
            message: SendMessage(id: messageID, role: "user", parts: (text.isEmpty && !attachments.isEmpty ? [] : [SendPart(text: text)]) + attachments.map(SendPart.init)),
            origin: origin.rawValue,
            workflowId: workflowID,
            appBinding: appBinding
        )
        switch turn {
        case .new: break
        case .regenerate: request.regenerate = true
        case .edit(let after): request.editFrom = after
        case .editFromStart: request.editFromStart = true
        }
        let body = request
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try ChatOutgoingAttachment.validate(attachments)
                    try await stream(body: body, into: continuation)
                    continuation.finish()
                } catch is ChatAttachmentError {
                    continuation.finish(throwing: ApiError.invalidRequest)
                } catch let error as ApiError {
                    continuation.finish(throwing: error)
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as URLError {
                    if Task.isCancelled {
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: ApiErrorMapper.mapTransport(error.code))
                    }
                } catch {
                    if Task.isCancelled {
                        continuation.finish()
                    } else {
                        continuation.finish(throwing: ApiError.unknown(status: 0))
                    }
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    public func stop(messageID: String) async throws -> Bool {
        guard !messageID.isEmpty else {
            throw ApiError.invalidRequest
        }
        return try await auth.run { token in
            let request = try makeRequest(path: ["api", "chat", "stop"], token: token, body: StopBody(messageId: messageID), streaming: false)
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: request)
            } catch let error as URLError {
                throw ApiErrorMapper.mapTransport(error.code)
            } catch let error as ApiError {
                throw error
            } catch {
                throw ApiError.unknown(status: 0)
            }
            guard let http = response as? HTTPURLResponse else {
                throw ApiError.unknown(status: 0)
            }
            guard (200...299).contains(http.statusCode) else {
                throw ApiErrorMapper.map(status: http.statusCode, body: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
            }
            guard let decoded = try? JSONDecoder().decode(StopResponse.self, from: data) else {
                throw ApiError.unknown(status: http.statusCode)
            }
            return decoded.stopped
        }
    }

    private func stream(body: SendBody, into continuation: AsyncThrowingStream<ChatStreamEvent, Error>.Continuation) async throws {
        guard body.appBinding?.isValid != false else { throw ApiError.invalidRequest }
        // A regenerated turn appends nothing, so a stored message with only an attachment can be answered again.
        guard body.regenerate == true || !body.message.parts.allSatisfy({ $0.type != "file" && ($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
              !body.message.id.isEmpty else {
            throw ApiError.invalidRequest
        }
        // A 401 arrives before any reply bytes, so nothing has been yielded when the attempt is repeated.
        try await auth.run { token in
            let request = try makeRequest(path: ["api", "chat"], token: token, body: body, streaming: true)
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ApiError.unknown(status: 0)
            }
            guard (200...299).contains(http.statusCode) else {
                var errorBody = Data()
                for try await byte in bytes {
                    errorBody.append(byte)
                    if errorBody.count >= Self.maxErrorBodyBytes {
                        break
                    }
                }
                throw ApiErrorMapper.map(status: http.statusCode, body: errorBody, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
            }
            var parser = ChatStreamParser()
            var pending = Data()
            // Feeds at every line end so events are yielded as soon as their line is complete.
            for try await byte in bytes {
                pending.append(byte)
                if byte == Self.lineFeed || pending.count >= Self.maxFeedBytes {
                    for event in parser.feed(pending) {
                        continuation.yield(event)
                    }
                    pending = Data()
                }
            }
            try Task.checkCancellation()
            if !pending.isEmpty {
                for event in parser.feed(pending) {
                    continuation.yield(event)
                }
            }
            for event in parser.finish() {
                continuation.yield(event)
            }
        }
    }

    private func makeRequest(path: [String], token: String, body: some Encodable, streaming: Bool) throws -> URLRequest {
        var url = baseURL
        for component in path {
            url = url.appendingPathComponent(component)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if streaming {
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        do {
            request.httpBody = try encoder.encode(body)
        } catch {
            throw ApiError.invalidRequest
        }
        return request
    }
}

private struct SendPart: Encodable, Sendable {
    let type: String
    let text: String?
    let mediaType: String?
    let filename: String?
    let url: String?
    init(text: String) {
        type = "text"; self.text = text; mediaType = nil; filename = nil; url = nil
    }
    init(_ file: ChatOutgoingAttachment) {
        type = "file"; text = nil; mediaType = file.mediaType; filename = file.name; url = file.dataURL
    }
}

private struct SendMessage: Encodable, Sendable {
    let id: String
    let role: String
    let parts: [SendPart]
}

// A nil `id` is left out of the JSON entirely.
private struct SendBody: Encodable, Sendable {
    let id: String?
    let message: SendMessage
    let origin: String
    let workflowId: String?
    let appBinding: ChatAppBinding?
    var regenerate: Bool?
    var editFrom: String?
    var editFromStart: Bool?
}

private struct StopBody: Encodable, Sendable {
    let messageId: String
}

private struct StopResponse: Decodable {
    let stopped: Bool
}
