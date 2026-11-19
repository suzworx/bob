import BobKit
import SwiftUI

// Who is invited and the person's own answer. A failed read says so, never "no one invited".
struct EventPeopleSection: View {
    let event: CalendarEvent
    let service: CalendarService
    let me: String?
    let canManage: Bool

    @State private var attendees: [EventAttendee] = []
    @State private var members: [SpaceMember] = []
    @State private var phase: LoadPhase = .loading
    @State private var failure: String?

    private var mine: EventAttendee? { attendees.first { $0.userID != nil && $0.userID == me } }

    private var inviteChoices: [SpaceMember] {
        let invited = Set(attendees.compactMap(\.userID))
        return members.filter { !invited.contains($0.userID) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("People").font(BobFont.caption).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
            switch phase {
            case .loading:
                ProgressView().accessibilityLabel("Loading who's invited").frame(minHeight: 44)
            case .failed:
                HStack {
                    Text("Who's invited could not be loaded.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    Spacer(minLength: 8)
                    Button("Try again") { Task { await load() } }
                        .font(BobFont.caption)
                        .frame(minHeight: 44)
                        .buttonStyle(BobPressStyle())
                }
            case .loaded:
                if attendees.isEmpty {
                    Text("No one invited yet.").font(BobFont.subline).foregroundStyle(.secondary)
                }
                ForEach(Array(attendees.enumerated()), id: \.offset) { _, attendee in
                    row(attendee)
                }
                if canManage {
                    inviteMenu
                } else {
                    Text("Only the organizer can change who's invited.").font(BobFont.subline).foregroundStyle(.secondary)
                }
                if let mine { answerPicker(mine) }
            }
            if let failure {
                Text(failure).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
            }
            BobDivider()
        }
        .task(id: event.id) { await load() }
    }

    private func row(_ attendee: EventAttendee) -> some View {
        let name = CalendarRules.attendeeName(attendee, members: members)
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(BobFont.rowTitle)
                Text(attendee.response.label).font(BobFont.subline).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if canManage, let userID = attendee.userID {
                Button {
                    Task { await remove(userID) }
                } label: {
                    Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .accessibilityLabel("Remove \(name)")
            }
        }
        .frame(minHeight: 44)
    }

    @ViewBuilder private var inviteMenu: some View {
        if !inviteChoices.isEmpty {
            Menu {
                ForEach(inviteChoices, id: \.userID) { member in
                    Button(CalendarRules.memberName(member)) { Task { await invite(member.userID) } }
                }
            } label: {
                Text("Invite someone").font(BobFont.rowTitle).frame(minHeight: 44)
            }
        }
    }

    private func answerPicker(_ mine: EventAttendee) -> some View {
        Picker("Your answer", selection: Binding(
            get: { mine.response == .needsAction ? nil : mine.response },
            set: { response in
                if let response { Task { await respond(response) } }
            }
        )) {
            ForEach([AttendeeResponse.accepted, .tentative, .declined], id: \.self) { response in
                Text(response.label).tag(AttendeeResponse?.some(response))
            }
        }
        .bobChoicePicker()
        .frame(minHeight: 44)
    }

    private func load() async {
        phase = .loading
        do {
            attendees = try await service.attendees(eventID: event.id)
            members = (try? await service.members(spaceID: event.spaceID)) ?? []
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            phase = .failed(apiError(error))
        }
    }

    private func reload() async {
        if let latest = try? await service.attendees(eventID: event.id) { attendees = latest }
    }

    private func invite(_ userID: String) async {
        await change { try await service.addAttendee(eventID: event.id, userID: userID) }
        await reload()
    }

    private func remove(_ userID: String) async {
        await change { try await service.removeAttendee(eventID: event.id, userID: userID) }
        await reload()
    }

    private func respond(_ response: AttendeeResponse) async {
        await change {
            let updated = try await service.setResponse(eventID: event.id, response: response)
            if let index = attendees.firstIndex(where: { $0.userID == updated.userID }) { attendees[index] = updated }
        }
    }

    private func change(_ work: () async throws -> Void) async {
        failure = nil
        do {
            try await work()
        } catch where isCancelled(error) {
            return
        } catch ApiError.unknown(status: 403) {
            failure = "Only the organizer can change who's invited."
        } catch {
            failure = "That change could not be saved."
        }
    }
}
