import XCTest
@testable import BobKit

private enum AgendaStubReply: Sendable {
    case response(status: Int, body: Data)
    case failure(URLError.Code)
}

private final class AgendaStubState: @unchecked Sendable {
    private let lock = NSLock()
    private var reply: AgendaStubReply = .response(status: 200, body: Data())
    private var recorded: [URLRequest] = []

    func reset(_ newReply: AgendaStubReply) {
        lock.withLock { reply = newReply; recorded = [] }
    }

    func record(_ request: URLRequest) -> AgendaStubReply {
        lock.withLock { recorded.append(request); return reply }
    }

    var requests: [URLRequest] { lock.withLock { recorded } }
}

private final class AgendaStubURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = AgendaStubState()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        switch Self.state.record(request) {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .response(let status, let body):
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil) else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

final class AgendaClientTests: XCTestCase {
    private let from = Date(timeIntervalSince1970: 1_792_281_600)
    private let to = Date(timeIntervalSince1970: 1_792_886_400)

    private func reply(_ status: Int, _ body: String = "") {
        AgendaStubURLProtocol.state.reset(.response(status: status, body: Data(body.utf8)))
    }

    private func calendar(_ zone: String) throws -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: zone))
        return calendar
    }

    private func client(token: String? = "access-1", zone: String = "UTC") throws -> AgendaClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgendaStubURLProtocol.self]
        let url = try XCTUnwrap(URL(string: "https://example.invalid"))
        return AgendaClient(baseURL: url, session: URLSession(configuration: configuration), calendar: try calendar(zone), accessToken: { token })
    }

    private func startOfDay(_ year: Int, _ month: Int, _ day: Int, zone: String) throws -> Date {
        let calendar = try calendar(zone)
        return try XCTUnwrap(calendar.date(from: DateComponents(year: year, month: month, day: day)))
    }

    private func allDayItem(_ id: String, start: String, end: String?) -> String {
        let endValue = end.map { "\"\($0)\"" } ?? "null"
        return #"{"event_id":"\#(id)","title":"Holiday","all_day":true,"start_date":"\#(start)","end_date":\#(endValue),"start_at": null,"end_at": null,"zone":null,"cancelled":false,"moved":false}"#
    }

    private func agendaError(_ client: AgendaClient) async -> Error? {
        do {
            _ = try await client.agenda(from: from, to: to)
            return nil
        } catch {
            return error
        }
    }

    func testDecodesTimedAndAllDayItemsDropsCancelledAndIgnoresUnknownFields() async throws {
        reply(200, #"""
        {"items":[
          {"event_id":"e1","title":"Dentist","location":"12 High St","body":null,"all_day":false,"start_date":null,"end_date":null,
           "start_at":1792317600000,"end_at":1792321200000,"zone":"Europe/London","cancelled":false,"moved":false,"colour":"x","extra":{"a":1}},
          {"event_id":"e2","title":"Holiday","location":null,"body":"Pack bags","all_day":true,"start_date":"2026-10-18","end_date":"2026-10-19",
           "start_at": null,"end_at": null,"zone":null,"cancelled":false,"moved":true},
          {"event_id":"e3","title":"Old call","all_day":false,"start_at":1792320000000,"end_at":null,"zone":null,"cancelled":true,"moved":false}
        ],"next":"ignored"}
        """#)
        let items = try await client().agenda(from: from, to: to)
        XCTAssertEqual(items, [
            AgendaItem(eventID: "e1", title: "Dentist", location: "12 High St", body: nil, isAllDay: false,
                       startAt: Date(timeIntervalSince1970: 1_792_317_600), endAt: Date(timeIntervalSince1970: 1_792_321_200), zoneID: "Europe/London"),
            AgendaItem(eventID: "e2", title: "Holiday", body: "Pack bags", isAllDay: true,
                       startAt: try startOfDay(2026, 10, 18, zone: "UTC"), endAt: try startOfDay(2026, 10, 19, zone: "UTC"), startDate: "2026-10-18", endDate: "2026-10-19")
        ])
    }

    func testAllDayDatesLandOnTheSameDayInANonUTCZone() async throws {
        reply(200, #"{"items":[\#(allDayItem("e1", start: "2026-10-18", end: "2026-10-19"))]}"#)
        let items = try await client(zone: "America/Los_Angeles").agenda(from: from, to: to)
        let item = try XCTUnwrap(items.first)
        XCTAssertEqual(item.startAt, try startOfDay(2026, 10, 18, zone: "America/Los_Angeles"))
        XCTAssertEqual(item.endAt, try startOfDay(2026, 10, 19, zone: "America/Los_Angeles"))
        let local = try calendar("America/Los_Angeles").dateComponents([.year, .month, .day, .hour], from: try XCTUnwrap(item.startAt))
        XCTAssertEqual([local.year, local.month, local.day, local.hour], [2026, 10, 18, 0])
    }

    func testMalformedStartDateLeavesStartNilWithoutCrashing() async throws {
        let bad = ["2026-13-01", "2026-02-30", "18/10/2026", "2026-1-18", "", "abcd-ef-gh", "2026-10-18T00:00"]
        reply(200, #"{"items":[\#(bad.enumerated().map { allDayItem("b\($0.offset)", start: $0.element, end: nil) }.joined(separator: ","))]}"#)
        let items = try await client().agenda(from: from, to: to)
        XCTAssertEqual(items.count, bad.count)
        XCTAssertTrue(items.allSatisfy { $0.startAt == nil && $0.endAt == nil && $0.isAllDay })
    }

    func testAllDayItemWithOnlyStartAtStillWorks() async throws {
        reply(200, #"{"items":[{"event_id":"old","title":"Holiday","all_day":true,"start_at":1792281600000,"end_at":null}]}"#)
        let items = try await client(zone: "America/Los_Angeles").agenda(from: from, to: to)
        XCTAssertEqual(items, [AgendaItem(eventID: "old", title: "Holiday", isAllDay: true, startAt: Date(timeIntervalSince1970: 1_792_281_600))])
    }

    func testSendsExactQueryAndBearerHeader() async throws {
        reply(200, #"{"items":[]}"#)
        _ = try await client().agenda(from: from, to: to)
        let request = try XCTUnwrap(AgendaStubURLProtocol.state.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://example.invalid/api/agenda?from=1792281600000&to=1792886400000")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-1")
    }

    func testRejectsMissingTokenAndEmptyWindowWithoutRequest() async throws {
        reply(200, #"{"items":[]}"#)
        let noToken = await agendaError(try client(token: nil))
        XCTAssertEqual(noToken as? ApiError, .unauthenticated)
        let backwards = try await { () async throws -> Error? in
            do { _ = try await client().agenda(from: to, to: from); return nil } catch { return error }
        }()
        XCTAssertEqual(backwards as? ApiError, .invalidRequest)
        XCTAssertTrue(AgendaStubURLProtocol.state.requests.isEmpty)
    }

    func testFailuresMapToApiErrors() async throws {
        reply(401, #"{"error":{"code":"unauthorized"}}"#)
        let unauthorized = await agendaError(try client())
        XCTAssertEqual(unauthorized as? ApiError, .unauthenticated)
        reply(500, "oops")
        let server = await agendaError(try client())
        XCTAssertEqual(server as? ApiError, .server)
        AgendaStubURLProtocol.state.reset(.failure(.notConnectedToInternet))
        let offline = await agendaError(try client())
        XCTAssertEqual(offline as? ApiError, .offline)
        reply(200, #"{"items":[{"title":"no id"}"#)
        let malformed = await agendaError(try client())
        XCTAssertEqual(malformed as? ApiError, .unknown(status: 200))
        reply(200, String(repeating: " ", count: 1_100_000))
        let oversized = await agendaError(try client())
        XCTAssertEqual(oversized as? ApiError, .unknown(status: 200))
    }
}
