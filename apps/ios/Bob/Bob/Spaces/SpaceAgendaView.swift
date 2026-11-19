import BobKit
import SwiftUI

struct SpaceAgendaView: View {
    let model: SpaceDetailModel
    let calendar: CalendarModel

    var body: some View {
        List {
            BobGroupHeader(title: "The next seven days")
            SpaceAgendaRows(model: model, calendar: calendar)
        }
        .bobList()
        .bobNavTitle("This week")
        .privacySensitive()
        .refreshable { await model.loadAgenda() }
        .task { await model.loadAgenda() }
    }
}

// Both the room preview and the full week open a freshly resolved occurrence.
struct SpaceAgendaRows: View {
    let model: SpaceDetailModel
    let calendar: CalendarModel
    var limit: Int?
    @State private var selected: CalendarEventTarget?

    var body: some View {
        Group {
            switch model.agendaPhase {
            case .loading:
                ProgressView().accessibilityLabel("Loading this week's events")
                    .frame(maxWidth: .infinity).bobListRow()
            case .failed(let error):
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn't load this week's events").font(BobFont.rowTitle)
                    Text(ApiErrorMapper.userMessage(error))
                        .font(BobFont.subline).foregroundStyle(.secondary)
                    Button("Try again") { Task { await model.loadAgenda() } }
                        .buttonStyle(BobSecondaryButtonStyle())
                }
                .bobListRow()
            case .loaded:
                if model.agenda.isEmpty {
                    Text("Nothing on the agenda this week.")
                        .font(BobFont.subline).foregroundStyle(.secondary).bobListRow()
                }
                ForEach(Array(model.agenda.prefix(limit ?? model.agenda.count)), id: \.rowID) { item in
                    Button {
                        selected = CalendarEventTarget(item: item)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(BobFont.rowTitle).foregroundStyle(.primary)
                                Text(item.startAt?.formatted(.dateTime.weekday().hour().minute()) ?? item.startDate ?? "All day")
                                    .font(BobFont.subline).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this event")
                    .bobListRow()
                }
            }
        }
        .sheet(item: $selected, onDismiss: { Task { await model.loadAgenda() } }) { target in
            CalendarEventTargetSheet(target: target, model: calendar).bobSheet()
        }
    }
}
