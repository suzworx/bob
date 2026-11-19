import Foundation

// One calendar event from GET /api/agenda, reduced to what the app shows.
public struct AgendaItem: Equatable, Sendable {
    public let eventID: String
    public let title: String
    public let location: String?
    public let body: String?
    public let isAllDay: Bool
    public let startAt: Date?
    public let endAt: Date?
    public let zoneID: String?
    public let isCancelled: Bool
    // The stable identity of one occurrence, in milliseconds: an edit of a single date sends it back unchanged.
    public let originalOccurrenceStart: Int64?
    // An all-day event's own dates; endDate is the day after its last day.
    public let startDate: String?
    public let endDate: String?
    public let spaceID: String?
    public let origin: String
    public let canEdit: Bool
    public let canDelete: Bool
    public let myResponse: AttendeeResponse?

    public var rowID: String { "\(eventID):\(originalOccurrenceStart ?? 0)" }

    public init(eventID: String, title: String, location: String? = nil, body: String? = nil, isAllDay: Bool = false, startAt: Date?, endAt: Date? = nil, zoneID: String? = nil, isCancelled: Bool = false, originalOccurrenceStart: Int64? = nil, startDate: String? = nil, endDate: String? = nil, spaceID: String? = nil, origin: String = "native", canEdit: Bool = false, canDelete: Bool = false, myResponse: AttendeeResponse? = nil) {
        self.eventID = eventID
        self.title = title
        self.location = location
        self.body = body
        self.isAllDay = isAllDay
        self.startAt = startAt
        self.endAt = endAt
        self.zoneID = zoneID
        self.isCancelled = isCancelled
        self.originalOccurrenceStart = originalOccurrenceStart
        self.startDate = startDate
        self.endDate = endDate
        self.spaceID = spaceID
        self.origin = origin
        self.canEdit = canEdit
        self.canDelete = canDelete
        self.myResponse = myResponse
    }
}

// One read-only event from the person's Google Calendar, shown beside their own.
public struct GoogleAgendaItem: Equatable, Sendable {
    public let sourceKey: String
    public let title: String
    public let location: String?
    public let startDate: String?
    public let endDate: String?
    public let startAt: Date?
    public let endAt: Date?
    public let zone: String?
    public let fetchedAt: Date

    public var isAllDay: Bool { startDate != nil }

    public init(sourceKey: String, title: String, location: String? = nil, startDate: String? = nil, endDate: String? = nil, startAt: Date? = nil, endAt: Date? = nil, zone: String? = nil, fetchedAt: Date) {
        self.sourceKey = sourceKey
        self.title = title
        self.location = location
        self.startDate = startDate
        self.endDate = endDate
        self.startAt = startAt
        self.endAt = endAt
        self.zone = zone
        self.fetchedAt = fetchedAt
    }
}

// What GET /api/agenda answers for a window: the person's events, Google's, and whether Google's are complete.
public struct AgendaPage: Equatable, Sendable {
    public enum GoogleNotice: Equatable, Sendable {
        case none, incomplete, reconnect
    }

    public let items: [AgendaItem]
    public let googleItems: [GoogleAgendaItem]
    public let googleNotice: GoogleNotice

    public init(items: [AgendaItem], googleItems: [GoogleAgendaItem] = [], googleNotice: GoogleNotice = .none) {
        self.items = items
        self.googleItems = googleItems
        self.googleNotice = googleNotice
    }
}

// Reads the person's agenda for a time window with GET /api/agenda.
public struct AgendaClient: Sendable {
    private static let maxBodyBytes = 1_048_576

    private let baseURL: URL
    private let session: URLSession
    private let auth: RequestAuth
    // Places an all-day event's date at the start of that day where the person is.
    private let calendar: Calendar

    public init(baseURL: URL, session: URLSession = .shared, calendar: Calendar = .current, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.calendar = calendar
        self.auth = RequestAuth(accessToken: accessToken, reauthenticate: reauthenticate)
    }

    // Every failure is thrown as an ApiError; cancelled events are left out.
    public func agenda(from: Date, to: Date) async throws -> [AgendaItem] {
        try await page(from: from, to: to).items
    }

    // With a space, only that space's events.
    public func page(from: Date, to: Date, spaceID: String? = nil) async throws -> AgendaPage {
        let fromMs = Self.epochMilliseconds(from)
        let toMs = Self.epochMilliseconds(to)
        guard toMs > fromMs else {
            throw ApiError.invalidRequest
        }
        return try await auth.run { token in
            let request = try makeRequest(fromMs: fromMs, toMs: toMs, spaceID: spaceID, token: token)
            let (data, status, retryAfter): (Data, Int, String?)
            do {
                (data, status, retryAfter) = try await load(request)
            } catch let error as ApiError {
                throw error
            } catch let error as URLError {
                throw ApiErrorMapper.mapTransport(error.code)
            } catch is CancellationError {
                throw ApiError.cancelled
            } catch {
                throw ApiError.unknown(status: 0)
            }
            guard (200...299).contains(status) else {
                throw ApiErrorMapper.map(status: status, body: data, retryAfter: retryAfter)
            }
            guard let decoded = try? JSONDecoder().decode(AgendaResponse.self, from: data) else {
                throw ApiError.unknown(status: status)
            }
            return AgendaPage(
                items: decoded.items.compactMap { $0.item(calendar: calendar) },
                googleItems: decoded.googleItems,
                googleNotice: decoded.googleNotice
            )
        }
    }

    private func load(_ request: URLRequest) async throws -> (Data, Int, String?) {
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiError.unknown(status: 0)
        }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > Self.maxBodyBytes {
                // An error body is only read for its code, so a cut one still maps; a cut success body cannot decode.
                guard (200...299).contains(http.statusCode) else { break }
                throw ApiError.unknown(status: http.statusCode)
            }
        }
        return (data, http.statusCode, http.value(forHTTPHeaderField: "Retry-After"))
    }

    private func makeRequest(fromMs: Int64, toMs: Int64, spaceID: String?, token: String) throws -> URLRequest {
        let url = baseURL.appendingPathComponent("api").appendingPathComponent("agenda")
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ApiError.invalidRequest
        }
        components.queryItems = [
            URLQueryItem(name: "from", value: String(fromMs)),
            URLQueryItem(name: "to", value: String(toMs))
        ]
        if let spaceID {
            components.queryItems?.append(URLQueryItem(name: "space_id", value: spaceID))
        }
        guard let full = components.url else {
            throw ApiError.invalidRequest
        }
        var request = URLRequest(url: full)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    static func epochMilliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }
}

private struct AgendaResponse: Decodable {
    let items: [AgendaWireItem]
    let googleItems: [GoogleAgendaItem]
    let googleNotice: AgendaPage.GoogleNotice

    private enum CodingKeys: String, CodingKey {
        case items, sources
        case remoteItems = "remote_items"
        case remoteUnavailable = "remote_unavailable"
    }

    private struct Source: Decodable {
        let state: String
    }

    // Google rows that can't be read cost only those rows, never the person's own events.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([AgendaWireItem].self, forKey: .items)
        let remote = try? container.decodeIfPresent([GoogleWireItem].self, forKey: .remoteItems)
        let unreadable = container.contains(.remoteItems) && remote == nil
        googleItems = (remote ?? nil)?.compactMap(\.item) ?? []
        let sources = (try? container.decodeIfPresent([Source].self, forKey: .sources)) ?? nil
        let unavailable = (try? container.decodeIfPresent(Bool.self, forKey: .remoteUnavailable)) ?? nil
        if sources?.contains(where: { $0.state == "reconnect_required" || $0.state == "permission_required" }) == true {
            googleNotice = .reconnect
        } else if unreadable || unavailable == true || sources?.contains(where: { $0.state != "fresh" }) == true {
            googleNotice = .incomplete
        } else {
            googleNotice = .none
        }
    }
}

private struct GoogleWireItem: Decodable {
    struct Time: Decodable {
        let date: String?
        let dateTime: String?
        let timeZone: String?

        var instant: Date? {
            guard let dateTime else { return nil }
            let formatter = ISO8601DateFormatter()
            if let date = formatter.date(from: dateTime) { return date }
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: dateTime)
        }
    }

    let source_key: String
    let title: String
    let location: String?
    let start: Time
    let end: Time
    let fetched_at: Double

    var item: GoogleAgendaItem? {
        guard start.date != nil || start.instant != nil else { return nil }
        return GoogleAgendaItem(
            sourceKey: source_key,
            title: title,
            location: location,
            startDate: start.date,
            endDate: end.date,
            startAt: start.instant,
            endAt: end.instant,
            zone: start.timeZone,
            fetchedAt: Date(timeIntervalSince1970: fetched_at / 1000)
        )
    }
}

// Only the fields the app uses; anything else in the item is ignored.
private struct AgendaWireItem: Decodable {
    let event_id: String
    let title: String?
    let location: String?
    let body: String?
    let all_day: Bool?
    let start_date: String?
    let end_date: String?
    let start_at: Double?
    let end_at: Double?
    let zone: String?
    let cancelled: Bool?
    let original_occurrence_start: Int64?
    let space_id: String?
    let origin: String?
    let can_edit: Bool?
    let can_delete: Bool?
    let my_response: AttendeeResponse?

    // An all-day event carries dates and null instants; a timed one carries instants in milliseconds.
    func item(calendar: Calendar) -> AgendaItem? {
        guard cancelled != true else { return nil }
        let isAllDay = all_day ?? false
        let instant = { (ms: Double?) in ms.map { Date(timeIntervalSince1970: $0 / 1000) } }
        let startAt = instant(start_at) ?? (isAllDay ? Self.startOfDay(start_date, calendar: calendar) : nil)
        let endAt = instant(end_at) ?? (isAllDay ? Self.startOfDay(end_date, calendar: calendar) : nil)
        return AgendaItem(
            eventID: event_id,
            title: title ?? "",
            location: location,
            body: body,
            isAllDay: isAllDay,
            startAt: startAt,
            endAt: endAt,
            zoneID: zone,
            isCancelled: false,
            originalOccurrenceStart: original_occurrence_start,
            startDate: start_date,
            endDate: end_date,
            spaceID: space_id,
            origin: origin ?? "native",
            canEdit: can_edit ?? false,
            canDelete: can_delete ?? false,
            myResponse: my_response
        )
    }

    // Reads "yyyy-MM-dd" as that day's start in the calendar's own time zone, so the day never shifts.
    // Anything else, including an out-of-range day such as "2026-02-30", gives nil.
    static func startOfDay(_ text: String?, calendar: Calendar) -> Date? {
        guard let text else { return nil }
        let parts = text.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else {
            return nil
        }
        let components = DateComponents(year: year, month: month, day: day)
        guard components.isValidDate(in: calendar), let date = calendar.date(from: components) else {
            return nil
        }
        return calendar.startOfDay(for: date)
    }
}
