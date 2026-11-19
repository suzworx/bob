import Foundation

// Mirrors the strict aggregate-only server schema. Unknown fields never reach presentation.
indirect enum MetricValue: Decodable, Sendable {
    case number(Double), text(String), null, object([String: MetricValue]), array([MetricValue])
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .text(value) }
        else if let value = try? container.decode([String: MetricValue].self) { self = .object(value) }
        else { self = .array(try container.decode([MetricValue].self)) }
    }
    var object: [String: MetricValue]? { if case .object(let value) = self { value } else { nil } }
    var text: String? { if case .text(let value) = self { value } else { nil } }
}
indirect enum MetricRule {
    case count, average, ratio, text(Int), values(Set<String>), nullable(MetricRule), optional(MetricRule), object([String: MetricRule]), array(MetricRule), emptyArray
    func accepts(_ value: MetricValue) -> Bool {
        switch (self, value) {
        case (.count, .number(let n)): n.isFinite && n >= 0 && n.rounded() == n
        case (.average, .number(let n)): n.isFinite && n >= 0
        case (.ratio, .number(let n)): n.isFinite && (0...1).contains(n)
        case (.text(let limit), .text(let text)): !text.isEmpty && text.utf16.count <= limit
        case (.values(let options), .text(let text)): options.contains(text)
        case (.nullable, .null): true
        case (.nullable(let rule), _), (.optional(let rule), _): rule.accepts(value)
        case (.array(let rule), .array(let rows)): rows.allSatisfy(rule.accepts)
        case (.emptyArray, .array(let rows)): rows.isEmpty
        case (.object(let fields), .object(let values)):
            Set(values.keys).isSubset(of: Set(fields.keys)) && fields.allSatisfy { key, rule in
                if let value = values[key] { return rule.accepts(value) }
                if case .optional = rule { return true }
                return false
            }
        default: false
        }
    }
    static func schema(_ page: OperatorMetricsPage) -> MetricRule {
        let n = MetricRule.count, nullable = MetricRule.nullable(.count), ratio = MetricRule.nullable(.ratio)
        let window = MetricRule.object(["from": .text(64), "to": .text(64), "bucket": .values(["hour", "day", "week"])])
        let active = MetricRule.object(["day": nullable, "week": nullable, "month": nullable, "in_window": nullable])
        let accounts = MetricRule.object(["total": n, "enabled": n, "disabled": n, "awaitingConfirmation": n])
        let tokens: [String: MetricRule] = ["input": n, "output": n, "cached_input": n]
        let percentiles = MetricRule.object(["p50": nullable, "p95": nullable])
        let surface = MetricRule.object(["turns": n, "outcomes": .object(["completed": n, "failed": n, "cancelled": n, "empty": n]), "success_rate": ratio,
            "latency_ms": .object(["first_audio": percentiles, "stt": percentiles, "model": percentiles, "tts": percentiles, "total": percentiles])])
        var fields: [String: MetricRule]
        switch page {
        case .users:
            fields = ["accounts": accounts, "signups": n, "signups_by_bucket": .array(.object(["t": .text(64), "count": n])), "active_users": active, "activated_users": nullable,
                "waitlist": .object(["total": n, "verified": n, "pending": n, "withAccount": n, "waitingVerified": n])]
        case .usage:
            fields = ["turns_by_bucket": .array(.object(["t": .text(64), "device": n, "web_voice": n, "web_text": n])), "turns_total": n, "conversations_created": n, "signups": n, "active_users": active]
        case .voice:
            fields = ["by_surface": .object(["device": surface, "web_voice": surface, "web_text": surface, "analytics": .optional(surface)]), "failed_by_stage": .object(["input": n, "stt": n, "agent": n, "tts": n]), "first_audio_p95_by_bucket": .array(.object(["t": .text(64), "device": nullable, "web_voice": nullable]))]
        case .platform:
            fields = ["backlog": n, "oldest_pending_seconds": nullable, "retried": n, "failed_by_event_type": .array(.object(["event_type": .text(64), "count": n]))]
        case .ai:
            fields = ["turns": n, "tokens": .object(tokens.merging(["cache_write": n, "reasoning": n]) { _, new in new }), "cache_hit_ratio": ratio, "avg_steps": .nullable(.average), "avg_output_tokens": .nullable(.average), "interrupted_rate": ratio,
                "by_model": .array(.object(tokens.merging(["model": .text(128), "turns": n]) { _, new in new })), "tools": .array(.object(["tool": .text(64), "count": n])),
                "intents": .array(.object(["intent": .values(["timer_reminder", "calendar", "task_note", "memory", "game", "device_control", "search_info", "space_collab", "chat", "other", "unknown"]), "turns": n, "success_rate": ratio, "p95_total_ms": nullable])),
                "tokens_by_bucket": .array(.object(tokens.merging(["t": .text(64)]) { _, new in new }))]
        case .devices:
            fields = ["devices": .object(["paired": n, "active_in_window": n, "revoked": n]), "by_fw_version": .array(.object(["fw_version": .text(40), "count": n])), "by_model": .array(.object(["model": .text(40), "count": n])), "freshness": .object(["under_1h": n, "under_24h": n, "under_7d": n, "older": n, "never": n]), "pairing": .object(["requested": n, "approved": n, "expired": n, "other": n])]
        case .features:
            fields = ["created_by_bucket": .array(.object(["t": .text(64), "tasks": n, "notes": n, "reminders": n])), "tasks": .object(["created": n, "completed": n]), "reminders": .object(["created": n, "delivered": n, "acknowledged": n, "snoozed": n]), "notifications": .object(["created": n, "read": n, "by_type": .array(.object(["type": .text(48), "count": n]))]), "calendar": .object(["events_created": n, "by_origin": .emptyArray]), "spaces": .object(["created": n, "by_kind": .object(["private": n, "pair": n, "group": n])]), "game_minutes": n]
        }
        fields["window"] = window
        return .object(fields)
    }
}
