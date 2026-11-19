import Foundation
import XCTest
@testable import BobKit

final class ApprovalProposalTests: XCTestCase {
    private let full = """
    {"id": "p1", "status": "pending", "title": "Plan the dinner",
     "steps": [{"action": "create_event", "title": "Book Friday 7pm", "subline": "Calendar"},
               {"action": "send_message", "title": "Text Sam"}],
     "changes": [{"label": "Time", "before": "6pm", "after": "7pm"}],
     "notify": [{"name": "Sam", "detail": "Friend"}],
     "reminder": {"label": "10 min before", "offset_minutes": 10},
     "created_at": 1760000000000, "decided_at": null}
    """
    private let minimal = """
    {"id": "p2", "status": "pending", "title": "Note it",
     "steps": [{"action": "create_note", "title": "Save note"}],
     "changes": [], "notify": [], "created_at": 1760000000000}
    """
    private let actions: [(String, ProposalAction, Bool)] = [
        ("send_email", .sendEmail, true), ("send_message", .sendMessage, true),
        ("purchase", .purchase, true), ("delete_item", .deleteItem, true),
        ("share_item", .shareItem, true), ("forget", .forget, true),
        ("notify_people", .notifyPeople, true), ("create_reminder", .createReminder, false),
        ("create_task", .createTask, false), ("create_note", .createNote, false),
        ("create_event", .createEvent, false), ("move_event", .moveEvent, false),
        ("complete_task", .completeTask, false)
    ]

    private func decode(_ json: String) throws -> ApprovalProposal {
        try ApprovalProposal.decode(Data(json.utf8))
    }

    private func withStatus(_ status: String) throws -> ApprovalProposal {
        try decode(minimal.replacingOccurrences(of: "\"pending\"", with: "\"\(status)\""))
    }

    private func withAction(_ action: String) throws -> ProposalAction? {
        try decode(minimal.replacingOccurrences(of: "\"create_note\"", with: "\"\(action)\"")).steps.first?.action
    }

    private func assertFails(_ json: String, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try decode(json), label, file: file, line: line) { error in
            XCTAssertTrue(error is DecodingError, "\(label): \(error)", file: file, line: line)
        }
    }

    func testFullProposalDecodesEveryField() throws {
        let proposal = try decode(full)
        XCTAssertEqual(proposal.id, "p1")
        XCTAssertEqual(proposal.status, .pending)
        XCTAssertEqual(proposal.title, "Plan the dinner")
        XCTAssertEqual(proposal.steps, [
            ProposalStep(action: .createEvent, title: "Book Friday 7pm", subline: "Calendar"),
            ProposalStep(action: .sendMessage, title: "Text Sam", subline: nil)
        ])
        XCTAssertEqual(proposal.changes, [ProposalChange(label: "Time", before: "6pm", after: "7pm")])
        XCTAssertEqual(proposal.notify, [ProposalPerson(name: "Sam", detail: "Friend")])
        XCTAssertEqual(proposal.reminder, ProposalReminder(label: "10 min before", offsetMinutes: 10))
        XCTAssertEqual(proposal.createdAt, Date(timeIntervalSince1970: 1760000000))
        XCTAssertNil(proposal.decidedAt)
    }

    func testMinimalProposalLeavesOptionalsNil() throws {
        let proposal = try decode(minimal)
        XCTAssertEqual(proposal.steps, [ProposalStep(action: .createNote, title: "Save note", subline: nil)])
        XCTAssertEqual(proposal.changes, [])
        XCTAssertEqual(proposal.notify, [])
        XCTAssertNil(proposal.reminder)
        XCTAssertNil(proposal.decidedAt)
    }

    func testDecidedProposalHasDecidedAt() throws {
        let json = full.replacingOccurrences(of: "\"decided_at\": null", with: "\"decided_at\": 1760000060500")
            .replacingOccurrences(of: "\"pending\"", with: "\"approved\"")
        let proposal = try decode(json)
        XCTAssertEqual(proposal.decidedAt, Date(timeIntervalSince1970: 1760000060.5))
        XCTAssertEqual(proposal.status, .approved)
    }

    func testEveryKnownStatusDecodes() throws {
        let expected: [(String, ProposalStatus)] = [
            ("pending", .pending), ("approved", .approved), ("declined", .declined), ("failed", .failed)
        ]
        for (raw, status) in expected {
            XCTAssertEqual(try withStatus(raw).status, status, raw)
        }
    }

    func testEveryKnownActionDecodesAndRoundTrips() throws {
        XCTAssertEqual(actions.count, 13)
        for (raw, action, _) in actions {
            XCTAssertEqual(try withAction(raw), action, raw)
            XCTAssertEqual(action.rawValue, raw)
            XCTAssertEqual(ProposalAction(rawValue: action.rawValue), action)
        }
    }

    func testNeedsExplicitApprovalForEachKnownAction() {
        for (raw, action, needsApproval) in actions {
            XCTAssertEqual(action.needsExplicitApproval, needsApproval, raw)
        }
    }

    func testUnknownStatusKeepsItsString() throws {
        XCTAssertEqual(try withStatus("running").status, .unknown("running"))
    }

    func testUnknownActionKeepsItsStringAndNeedsApproval() throws {
        let action = try withAction("wire_money")
        XCTAssertEqual(action, .unknown("wire_money"))
        XCTAssertEqual(action?.rawValue, "wire_money")
        XCTAssertEqual(action?.needsExplicitApproval, true)
    }

    func testOnlyPendingCanBeDecided() throws {
        let cases: [(String, Bool)] = [
            ("pending", true), ("approved", false), ("declined", false), ("failed", false), ("running", false)
        ]
        for (raw, expected) in cases {
            let proposal = try withStatus(raw)
            XCTAssertEqual(proposal.isPending, expected, raw)
            XCTAssertEqual(proposal.canDecide, expected, raw)
        }
    }

    func testUnknownExtraKeysAreIgnored() throws {
        let json = minimal.replacingOccurrences(of: "\"id\": \"p2\"", with: "\"id\": \"p2\", \"extra\": {\"x\": 1}")
            .replacingOccurrences(of: "\"title\": \"Save note\"", with: "\"title\": \"Save note\", \"params\": [1, 2]")
        XCTAssertNotEqual(json, minimal)
        XCTAssertEqual(try decode(json), try decode(minimal))
    }

    func testMissingTopLevelRequiredFieldFails() throws {
        for key in ["id", "status", "title", "steps", "changes", "notify", "created_at"] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(full.utf8)) as? [String: Any])
            XCTAssertNotNil(object.removeValue(forKey: key), key)
            let data = try JSONSerialization.data(withJSONObject: object)
            assertFails(String(decoding: data, as: UTF8.self), key)
        }
    }

    func testMissingNestedRequiredFieldFails() {
        let removals: [(String, String)] = [
            ("step action", "\"action\": \"send_message\", "), ("step title", ", \"title\": \"Text Sam\""),
            ("change label", "\"label\": \"Time\", "), ("change after", ", \"after\": \"7pm\""),
            ("person name", "\"name\": \"Sam\", "), ("reminder label", "\"label\": \"10 min before\", "),
            ("reminder offset_minutes", ", \"offset_minutes\": 10")
        ]
        for (label, fragment) in removals {
            XCTAssertTrue(full.contains(fragment), label)
            assertFails(full.replacingOccurrences(of: fragment, with: ""), label)
        }
    }

    func testStringWhereNumberExpectedFails() {
        assertFails(full.replacingOccurrences(of: "1760000000000", with: "\"abc\""), "created_at abc")
    }

    func testEmptyInputFails() {
        assertFails("", "empty input")
    }

    func testNullReminderDecodesToNil() throws {
        let json = full.replacingOccurrences(of: "{\"label\": \"10 min before\", \"offset_minutes\": 10}", with: "null")
        XCTAssertNotEqual(json, full)
        XCTAssertNil(try decode(json).reminder)
    }
}
