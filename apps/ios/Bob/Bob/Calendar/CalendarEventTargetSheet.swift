import BobKit
import SwiftUI

// Today and Search retain the event and space they opened, even outside the loaded month.
struct CalendarEventTargetSheet: View {
    let target: CalendarEventTarget
    let model: CalendarModel

    @Environment(\.dismiss) private var dismiss
    @State private var item: AgendaItem?
    @State private var failure: ApiError?

    var body: some View {
        Group {
            if let item {
                if item.origin == "native", item.canEdit {
                    EventEditorSheet(mode: .edit(item), model: model)
                } else {
                    EventDetailSheet(item: item, model: model)
                }
            } else {
                NavigationStack {
                    Group {
                        if let failure {
                            ContentUnavailableView {
                                Label(failure == .notFound || failure == .forbidden ? "Event unavailable" : "Couldn't load this event", systemImage: "calendar.badge.exclamationmark")
                            } description: {
                                Text(failure == .notFound || failure == .forbidden ? "It may have been removed, moved, or is no longer shared with you." : ApiErrorMapper.userMessage(failure))
                            } actions: {
                                Button("Try again") { Task { await load() } }
                                    .buttonStyle(BobSecondaryButtonStyle())
                            }
                        } else {
                            ProgressView().accessibilityLabel("Loading event")
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .bobPage()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { dismiss() }
                        }
                    }
                }
            }
        }
        .privacySensitive()
        .task(id: target) { await load() }
    }

    private func load() async {
        item = nil
        failure = nil
        do {
            let service = model.service
            let loaded = try await target.resolve(zone: model.zone, event: { try await service.event(id: $0) }, agenda: { try await service.agenda(from: $0, to: $1) })
            guard !Task.isCancelled else { return }
            if let day = loaded.startDate ?? loaded.startAt.map({ WallClock.day($0, zone: model.zone) }) {
                model.select(day)
            }
            item = loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard !Task.isCancelled else { return }
            failure = apiError(error)
        }
    }
}
