import Foundation

// One spoken sentence as the server made it: MP3 bytes, held in memory only.
public struct SpokenAudio: Equatable, Sendable {
    public let data: Data
    // The server read out a shorter version: it speaks at most 700 characters per request.
    public let isTruncated: Bool

    public init(data: Data, isTruncated: Bool) {
        self.data = data
        self.isTruncated = isTruncated
    }
}

// Words from audio through POST /api/voice and audio from words through POST /api/speech.
public struct VoiceClient: Sendable {
    // The server's default BOB_WEB_AUDIO_MAX_BYTES, which the web checks before uploading too.
    public static let maxAudioBytes = 2_097_152

    private let baseURL: URL
    private let session: URLSession
    private let auth: RequestAuth

    // Audio and words never reach a URL cache.
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.auth = RequestAuth(accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // The server takes base64 in a JSON body and answers {"text":"..."}; words it can't find are a 422.
    public func transcribe(wav: Data, workflowID: String? = nil) async throws -> String {
        guard !wav.isEmpty else {
            throw ApiError.invalidRequest
        }
        guard wav.count <= Self.maxAudioBytes else {
            throw ApiError.audioTooLarge
        }
        let (data, http) = try await post("voice", body: TranscribeBody(audio: wav.base64EncodedString(), format: "wav", workflowId: workflowID))
        guard let decoded = try? JSONDecoder().decode(TranscribeResponse.self, from: data) else {
            throw ApiError.unknown(status: http.statusCode)
        }
        guard !decoded.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ApiError.noSpeechDetected
        }
        return decoded.text
    }

    public func speak(text: String, workflowID: String? = nil) async throws -> SpokenAudio {
        guard !text.isEmpty else {
            throw ApiError.invalidRequest
        }
        let (data, http) = try await post("speech", body: SpeakBody(text: text, workflowId: workflowID))
        return SpokenAudio(data: data, isTruncated: http.value(forHTTPHeaderField: "X-Bob-Speech-Truncated") == "true")
    }

    private func post(_ route: String, body: some Encodable) async throws -> (Data, HTTPURLResponse) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let payload = try? encoder.encode(body) else {
            throw ApiError.invalidRequest
        }
        let url = baseURL.appendingPathComponent("api").appendingPathComponent(route)
        return try await auth.run { token in
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = payload
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: request)
            } catch let error as URLError {
                throw ApiErrorMapper.mapTransport(error.code)
            } catch is CancellationError {
                throw ApiError.cancelled
            } catch {
                throw ApiError.unknown(status: 0)
            }
            guard let http = response as? HTTPURLResponse else {
                throw ApiError.unknown(status: 0)
            }
            guard (200...299).contains(http.statusCode) else {
                throw ApiErrorMapper.map(status: http.statusCode, body: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
            }
            return (data, http)
        }
    }
}

// A nil `workflowId` is left out of the JSON entirely.
private struct TranscribeBody: Encodable {
    let audio: String
    let format: String
    let workflowId: String?
}

private struct SpeakBody: Encodable {
    let text: String
    let workflowId: String?
}

private struct TranscribeResponse: Decodable {
    let text: String
}

// 16-bit mono PCM in a RIFF/WAVE container, the same bytes the web uploads.
public enum VoiceWAV {
    public static let sampleRate = 16000

    public static func encode(samples: [Int16], sampleRate: Int = VoiceWAV.sampleRate) -> Data {
        let dataBytes = samples.count * 2
        var wav = Data(capacity: 44 + dataBytes)
        func ascii(_ text: String) { wav.append(contentsOf: text.utf8) }
        func little32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { wav.append(contentsOf: $0) } }
        func little16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { wav.append(contentsOf: $0) } }
        ascii("RIFF")
        little32(36 + dataBytes)
        ascii("WAVE")
        ascii("fmt ")
        little32(16)
        little16(1) // uncompressed PCM
        little16(1) // mono
        little32(sampleRate)
        little32(sampleRate * 2) // bytes per second
        little16(2) // bytes per frame
        little16(16) // bits per sample
        ascii("data")
        little32(dataBytes)
        for sample in samples {
            withUnsafeBytes(of: sample.littleEndian) { wav.append(contentsOf: $0) }
        }
        return wav
    }
}
