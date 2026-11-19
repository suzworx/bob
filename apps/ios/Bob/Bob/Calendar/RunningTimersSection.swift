import BobKit
import SwiftUI

struct RunningTimersSection: View {
    let model: TimersModel

    var body: some View {
        Group {
            HStack {
                Text("Timers & alarms").font(BobFont.heading).accessibilityAddTraits(.isHeader)
                Spacer()
                Button { Task { await model.refresh() } } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Refresh timers and alarms")
                .disabled(model.refreshing || model.cancellingID != nil)
            }
            .bobListRow(divider: false)
            TimerNotificationStatusView()
                .bobListRow(divider: false)
            if model.refreshing && model.timers.isEmpty {
                ProgressView("Checking timers…").bobListRow(divider: false)
            }
            if case .failed(let error) = model.phase {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Couldn't refresh timers and alarms").font(BobFont.rowTitle)
                    Text(ApiErrorMapper.userMessage(error)).font(BobFont.subline).foregroundStyle(.secondary)
                    if !model.timers.isEmpty {
                        Text("These are the last timers Bob confirmed.").font(BobFont.subline).foregroundStyle(.secondary)
                    }
                    Button("Try again") { Task { await model.refresh() } }.buttonStyle(BobSecondaryButtonStyle())
                }.bobListRow()
            }
            if let error = model.actionError {
                Text("Couldn't cancel that timer. \(ApiErrorMapper.userMessage(error)) Try Cancel again.")
                    .font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow()
            }
            ForEach(model.timers) { timer in
                HStack(spacing: 12) {
                    Image(systemName: timer.timer.kind == .alarm ? "alarm" : "timer").accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(timer.timer.title).font(BobFont.rowTitle)
                        if timer.timer.kind == .alarm {
                            Text(Self.ringTime(timer.timer)).font(BobFont.subline).foregroundStyle(.secondary)
                        }
                        Text(timer.remaining(at: model.now) == 0 ? "Due now · refresh to check status" : "\(timer.countdown(at: model.now)) left")
                            .font(BobFont.subline).monospacedDigit().foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    Spacer(minLength: 0)
                    if model.cancellingID == timer.id {
                        ProgressView().accessibilityLabel("Cancelling \(timer.timer.title)")
                    } else {
                        Button("Cancel") { Task { await model.cancel(timer.id) } }
                            .font(BobFont.subline).frame(minHeight: 44)
                            .accessibilityLabel("Cancel \(timer.timer.title)")
                            .disabled(model.cancellingID != nil)
                    }
                }.bobListRow()
            }
            if model.phase == .loaded && model.timers.isEmpty {
                Text("No running timers or alarms. Ask Bob to start a timer or set an alarm.")
                    .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            }
        }
        .privacySensitive()

    }

    static func makeModel() -> TimersModel {
        if let client = AppSession.make({ TimersClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) {
            return TimersModel(read: { try await client.list() }, cancel: { id in
                try await client.cancel(id: id)
                await TimerNotifications.shared.cancel(timerID: id)
            })
        }
        #if DEBUG
        return TimersModel(read: { [] }, cancel: { _ in throw ApiError.unauthenticated })
        #else
        return TimersModel(read: { throw ApiError.unauthenticated }, cancel: { _ in throw ApiError.unauthenticated })
        #endif
    }
    private static func ringTime(_ timer: TimerSummary) -> String {
        let format = DateFormatter()
        format.dateStyle = .medium; format.timeStyle = .short
        format.timeZone = TimeZone(identifier: timer.zone) ?? .current
        return "Rings at \(format.string(from: timer.firesAt)) · \(timer.zone)"
    }
}
