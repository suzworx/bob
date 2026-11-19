import Foundation
import Observation

public enum OperatorMetricsPage: String, CaseIterable, Sendable { case users, usage, voice, platform, ai, devices, features }
public enum OperatorMetricsRange: String, CaseIterable, Sendable {
    case day = "24h", week = "7d", month = "30d", quarter = "90d"
    public var title: String { switch self { case .day: "24 hours"; case .week: "7 days"; case .month: "30 days"; case .quarter: "90 days" } }
}
public enum OperatorMetricsLens: String, CaseIterable, Sendable {
    case users, reliability, ai, devices, features
    public var title: String { self == .ai ? "AI" : rawValue.capitalized }
    public var pages: [OperatorMetricsPage] {
        switch self { case .users: [.users]; case .reliability: [.usage, .voice, .platform]; case .ai: [.ai]; case .devices: [.devices]; case .features: [.features] }
    }
}
public struct OperatorMetricFact: Identifiable, Sendable {
    public let id, label, value: String
}
public struct OperatorMetricPoint: Identifiable, Sendable {
    public let id, series: String
    public let date: Date
    public let value: Double
}
public struct OperatorMetricBlock: Identifiable, Sendable {
    public let id, title: String
    public let facts: [OperatorMetricFact]
    public let points: [OperatorMetricPoint]
}
public struct OperatorMetricsDocument: Identifiable, Sendable {
    public var id: String { page.rawValue }
    public let page: OperatorMetricsPage
    public let from, to, bucket: String
    public let blocks: [OperatorMetricBlock]
    public static func decode(_ data: Data, page: OperatorMetricsPage) throws -> Self {
        try make(JSONDecoder().decode(MetricValue.self, from: data), page: page)
    }
    static func make(_ value: MetricValue, page: OperatorMetricsPage) throws -> Self {
        guard MetricRule.schema(page).accepts(value), let fields = value.object, let window = fields["window"]?.object,
              let from = window["from"]?.text, let to = window["to"]?.text, let bucket = window["bucket"]?.text else { throw ApiError.unknown(status: 200) }
        let blocks = fields.keys.sorted().filter { $0 != "window" }.map { key in
            let value = fields[key] ?? .null
            return OperatorMetricBlock(id: key, title: label(key), facts: facts(value, path: [key], label: nil), points: points(value))
        }
        return Self(page: page, from: from, to: to, bucket: bucket, blocks: blocks)
    }
    private static func facts(_ value: MetricValue, path: [String], label rowLabel: String?) -> [OperatorMetricFact] {
        let key = path.last ?? "value"
        let title = rowLabel ?? label(key)
        switch value {
        case .object(let fields):
            return fields.keys.sorted().flatMap { child in facts(fields[child] ?? .null, path: path + [child], label: (rowLabel ?? (path.count > 1 ? label(key) : nil)).map { $0 + " · " + label(child) }) }
        case .array(let rows):
            return rows.enumerated().flatMap { index, row in
                let name = row.object.flatMap { fields in ["t", "model", "tool", "intent", "event_type", "fw_version", "type"].compactMap { fields[$0]?.text }.first } ?? "\(index + 1)"
                return facts(row, path: path + [String(index)], label: name)
            }
        case .null:
            return [OperatorMetricFact(id: path.joined(separator: "."), label: title, value: privateCount(path) ? "Hidden" : "Unavailable")]
        case .text(let text):
            return [OperatorMetricFact(id: path.joined(separator: "."), label: title, value: text)]
        case .number(let number):
            let shown: String
            if privateCount(path) && number < 3 { shown = "Hidden" }
            else if key.contains("ratio") || key.contains("rate") { shown = number.formatted(.percent.precision(.fractionLength(0...1))) }
            else {
                let unit = path.contains("latency_ms") || key.hasSuffix("_ms") || path.contains("first_audio_p95_by_bucket") ? " ms" : key.hasSuffix("_seconds") ? " sec" : key == "game_minutes" ? " min" : ""
                shown = number.formatted(.number.precision(.fractionLength(0...2))) + unit
            }
            return [OperatorMetricFact(id: path.joined(separator: "."), label: title, value: shown)]
        }
    }
    private static func privateCount(_ path: [String]) -> Bool { path.contains("active_users") || path.contains("activated_users") }
    private static func points(_ value: MetricValue) -> [OperatorMetricPoint] {
        guard case .array(let rows) = value else { return [] }
        let parser = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return rows.enumerated().flatMap { index, row -> [OperatorMetricPoint] in
            guard let fields = row.object, let t = fields["t"]?.text else { return [] }
            let date = parser.date(from: t) ?? fractional.date(from: t)
            guard let date else { return [] }
            return fields.keys.sorted().compactMap { key in
                guard case .number(let value) = fields[key] else { return nil }
                return OperatorMetricPoint(id: "\(index).\(key)", series: label(key), date: date, value: value)
            }
        }
    }
    private static func label(_ key: String) -> String {
        let names = ["ai": "AI", "stt": "Speech recognition", "tts": "Speech synthesis", "p50": "Median", "p95": "95th percentile", "web_voice": "Web voice", "web_text": "Web text", "fw_version": "Firmware", "by_fw_version": "Firmware versions", "in_window": "In selected period", "under_1h": "Under 1 hour", "under_24h": "Under 24 hours", "under_7d": "Under 7 days", "awaitingConfirmation": "Awaiting confirmation", "waitingVerified": "Verified, waiting", "withAccount": "With an account"]
        return names[key] ?? key.replacingOccurrences(of: "_", with: " ").prefix(1).uppercased() + key.replacingOccurrences(of: "_", with: " ").dropFirst()
    }
}
public struct OperatorMetricsClient: Sendable {
    private let http: JSONRequester
    public init(baseURL: URL, session: URLSession = MemoryClient.memoryOnlySession, accessToken: @escaping @Sendable () async throws -> String?, reauthenticate: Reauthenticator? = nil) {
        http = JSONRequester(baseURL: baseURL, session: session, accessToken: accessToken, reauthenticate: reauthenticate)
    }
    public func document(page: OperatorMetricsPage, range: OperatorMetricsRange) async throws -> OperatorMetricsDocument {
        let value: MetricValue = try await http.decoded("GET", ["operator", "metrics", page.rawValue], query: [URLQueryItem(name: "range", value: range.rawValue)])
        return try OperatorMetricsDocument.make(value, page: page)
    }
}
@MainActor @Observable public final class OperatorMetricsModel {
    public var lens: OperatorMetricsLens = .users
    public var range: OperatorMetricsRange = .week
    public private(set) var documents: [OperatorMetricsDocument] = []
    public private(set) var phase: InsightLoadPhase = .loading
    public private(set) var allowed = false
    @ObservationIgnored private let probe: @Sendable () async throws -> Bool
    @ObservationIgnored private let read: @Sendable (OperatorMetricsPage, OperatorMetricsRange) async throws -> OperatorMetricsDocument
    @ObservationIgnored private var generation = 0
    public init(probe: @escaping @Sendable () async throws -> Bool, read: @escaping @Sendable (OperatorMetricsPage, OperatorMetricsRange) async throws -> OperatorMetricsDocument) { self.probe = probe; self.read = read }
    public func refresh() async {
        generation += 1; let request = generation; let lens = lens; let range = range
        phase = .loading; documents = []; allowed = false
        do {
            guard try await probe() else { throw ApiError.forbidden }
            var result: [OperatorMetricsDocument] = []
            for page in lens.pages { result.append(try await read(page, range)) }
            guard request == generation, lens == self.lens, range == self.range, !Task.isCancelled else { return }
            documents = result; phase = .loaded; allowed = true
        } catch {
            guard request == generation, !Task.isCancelled, !(error is CancellationError), (error as? ApiError) != .cancelled else { return }
            documents = []; allowed = false; phase = .failed((error as? ApiError) ?? .unknown(status: 0))
        }
    }
    public func cancel() { generation += 1 }
}
