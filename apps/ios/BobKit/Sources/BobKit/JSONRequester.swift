import Foundation

// A stale write: someone saved first, so the caller keeps its draft and reloads. Only a 409 that names the current revision is this.
public struct RevisionConflict: Error, Equatable, Sendable {
    public let currentRevision: Int

    public init(currentRevision: Int) {
        self.currentRevision = currentRevision
    }
}

// One signed JSON request under /api: failures become ApiError or RevisionConflict, success bodies decode with times in milliseconds.
struct JSONRequester: Sendable {
    // A space's notes can be many times 20 KB each, so this is well above the agenda's limit.
    static let defaultMaxBodyBytes = 16 * 1_048_576

    let baseURL: URL
    let session: URLSession
    let auth: RequestAuth
    let maxBodyBytes: Int

    init(baseURL: URL, session: URLSession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator?, maxBodyBytes: Int = JSONRequester.defaultMaxBodyBytes) {
        self.baseURL = baseURL
        self.session = session
        self.maxBodyBytes = maxBodyBytes
        self.auth = RequestAuth(accessToken: accessToken, reauthenticate: reauthenticate)
    }

    func decoded<Response: Decodable>(_ method: String, _ path: [String], query: [URLQueryItem] = [], body: [String: Any]? = nil) async throws -> Response {
        let data = try await send(method, path, query: query, body: body)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw ApiError.unknown(status: 200)
        }
    }

    // For a route whose refusals carry a body worth reading: these statuses decode as success would.
    func decoded<Response: Decodable>(_ method: String, _ path: [String], accepting statuses: Set<Int>) async throws -> Response {
        let data = try await send(method, path, body: nil, accepting: statuses)
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw ApiError.unknown(status: 200)
        }
    }

    // For the routes that answer 204 with nothing to read.
    func empty(_ method: String, _ path: [String], query: [URLQueryItem] = [], body: [String: Any]? = nil) async throws {
        _ = try await send(method, path, query: query, body: body)
    }

    // A whole file in memory, with its Content-Disposition. Read in one go because an export can be far larger than a JSON reply.
    func file(_ path: [String]) async throws -> (data: Data, disposition: String?) {
        try await auth.run { token in
            var request = URLRequest(url: try url(path, query: []))
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw ApiError.unknown(status: 0)
                }
                guard (200...299).contains(http.statusCode) else {
                    throw ApiErrorMapper.map(status: http.statusCode, body: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
                }
                return (data, http.value(forHTTPHeaderField: "Content-Disposition"))
            } catch let error as URLError {
                throw ApiErrorMapper.mapTransport(error.code)
            } catch is CancellationError {
                throw ApiError.cancelled
            }
        }
    }

    private func send(_ method: String, _ path: [String], query: [URLQueryItem] = [], body: [String: Any]?, accepting statuses: Set<Int> = []) async throws -> Data {
        let payload = try body.map { try JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys]) }
        return try await auth.run { token in
            var request = URLRequest(url: try url(path, query: query))
            request.httpMethod = method
            request.httpBody = payload
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if payload != nil {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (data, http) = try await load(request)
            guard (200...299).contains(http.statusCode) || statuses.contains(http.statusCode) else {
                if http.statusCode == 409, let current = Self.currentRevision(in: data) {
                    throw RevisionConflict(currentRevision: current)
                }
                throw ApiErrorMapper.map(status: http.statusCode, body: data, retryAfter: http.value(forHTTPHeaderField: "Retry-After"))
            }
            return data
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ApiError.unknown(status: 0)
            }
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBodyBytes {
                    throw ApiError.unknown(status: http.statusCode)
                }
            }
            return (data, http)
        } catch let error as ApiError {
            throw error
        } catch let error as URLError {
            throw ApiErrorMapper.mapTransport(error.code)
        } catch is CancellationError {
            throw ApiError.cancelled
        } catch {
            throw ApiError.unknown(status: 0)
        }
    }

    private func url(_ path: [String], query: [URLQueryItem]) throws -> URL {
        let url = path.reduce(baseURL.appendingPathComponent("api")) { $0.appendingPathComponent($1) }
        guard !query.isEmpty else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ApiError.invalidRequest
        }
        components.queryItems = query
        // URLComponents leaves "+" alone, and the server would read it as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let full = components.url else {
            throw ApiError.invalidRequest
        }
        return full
    }

    private static func currentRevision(in data: Data) -> Int? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = object["error"] as? [String: Any] else {
            return nil
        }
        return error["current_revision"] as? Int
    }
}
