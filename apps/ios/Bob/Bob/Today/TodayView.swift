import BobKit
import SwiftUI

// The Today tab: Bob says what's next, then the rest of the day in order.
struct TodayView: View {
    let model: TodayViewModel
    var onGetStarted: (GetStartedStep) -> Void = { _ in }
    var onBob: () -> Void = {}
    var onEvent: (CalendarEventTarget) -> Void = { _ in }
    var onCalendar: () -> Void = {}
    var onDestination: (ProductivityRoute) -> Void = { _ in }
    var notifications: NotificationsModel?
    var onNotifications: () -> Void = {}

    @Environment(\.scenePhase) private var scenePhase

    private var place: BobAppearance.BobPlace { BobAppearanceStore.shared.value.bobPlace }
    private let margin = BobLayout.pageMargin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    if place == .date { bobButton(size: 32) }
                    Text(TodayDateText.dayLine(for: model.now, calendar: .current, locale: .current))
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 32)
                calendarEntry
                    .padding(.top, 16)
                content
                everydayEntries
                    .padding(.top, 28)
            }
            .padding(.horizontal, margin)
            .padding(.top, 12)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await model.refresh() }
        .bobPage()
        .bobNavTitle("Today")
        .toolbar {
            if let notifications {
                ToolbarItem(placement: .topBarTrailing) {
                    BobNotificationsButton(model: notifications, action: onNotifications)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Calendar", systemImage: "calendar", action: onCalendar)
                    .accessibilityHint("Opens your full calendar")
            }
        }
        .task { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            Task { await model.refresh() }
        }
        .privacySensitive()
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 240)
                .accessibilityLabel("Loading your day")
        case .failed(let error):
            ContentUnavailableView {
                Label("Couldn't load your day", systemImage: "wifi.slash")
            } description: {
                Text(ApiErrorMapper.userMessage(error))
            } actions: {
                Button("Try again") {
                    Task { await model.refresh() }
                }
                .buttonStyle(BobPrimaryButtonStyle())
            }
            .padding(.top, 48)
        case .loaded(let content), .stale(let content):
            loaded(content)
        }
    }

    @ViewBuilder private func loaded(_ content: TodayContent) -> some View {
        if place == .speaker {
            Button(action: onBob) {
                HStack(spacing: 8) {
                    BobFaceBadge(size: 32)
                    Text("Bob").font(BobFont.caption)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityLabel("Talk to Bob")
            .padding(.top, 14)
        }
        Text(content.plan.headline(now: model.now))
            .font(BobFont.greeting)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, place == .speaker ? 4 : 10)
        if model.state.showsOfflineNote {
            Label("Offline, showing your last update", systemImage: "wifi.slash")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .padding(.top, 10)
        }
        section(rows: content.plan.today.map { ($0.id, $0.title, $0.subline, $0.timeText, $0.target) })
            .padding(.top, 28)
        if place == .resting {
            Button(action: onBob) {
                Image("BobHelper").resizable().scaledToFit().frame(height: 132)
            }
            .buttonStyle(BobPressStyle())
            .accessibilityLabel("Talk to Bob")
            .frame(maxWidth: .infinity)
            .padding(.top, 32)
        }
        if !content.plan.thisWeek.isEmpty {
            Text("This week").font(BobFont.caption).padding(.top, 32)
            section(rows: content.plan.thisWeek.map { ($0.id, $0.title, $0.subline, $0.whenText, $0.target) })
                .padding(.top, 6)
        }

    }

    private var calendarEntry: some View {
        Button(action: onCalendar) {
            HStack(spacing: 12) {
                Image(systemName: "calendar")
                    .font(.title3)
                    .foregroundStyle(BobColor.accent)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Calendar").font(BobFont.rowTitle)
                    Text("See your week and make a little room")
                        .font(BobFont.subline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .background(BobColor.wash, in: RoundedRectangle(cornerRadius: BobLayout.controlRadius))
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel("Calendar")
        .accessibilityHint("Opens your calendar and events")
    }

    private var everydayEntries: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Your day, together").font(BobFont.caption)
                .foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
                .padding(.bottom, 8)
            everydayEntry("Tasks", detail: "One small thing at a time", icon: "checkmark.circle", route: .tasks)
            everydayEntry("Notes", detail: "Ideas worth keeping", icon: "note.text", route: .notes)
            everydayEntry("Reminders", detail: "A nudge at the right moment", icon: "bell", route: .reminders)
            everydayEntry("Suggested by Bob", detail: "You choose what happens next", icon: "sparkles", route: .suggestions)
            everydayEntry("Timeline", detail: "Look back on your day", icon: "clock.arrow.circlepath", route: .timeline)
            Menu {
                ForEach(GetStartedStep.allCases) { step in
                    Button(step.title) { onGetStarted(step) }
                }
            } label: {
                Label("Make Bob yours", systemImage: "slider.horizontal.3")
                    .font(BobFont.subline)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .padding(.top, 12)
        }
    }

    @ViewBuilder private func everydayEntry(_ title: String, detail: String, icon: String, route: ProductivityRoute) -> some View {
        Button { onDestination(route) } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).frame(width: 26).foregroundStyle(.secondary).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(BobFont.rowTitle)
                    Text(detail).font(BobFont.subline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        BobDivider()
    }

    private func section(rows: [(String, String, String?, String, CalendarEventTarget?)]) -> some View {
        VStack(spacing: 0) {
            ForEach(rows, id: \.0) { row in
                Button {
                    if let target = row.4 { onEvent(target) }
                } label: {
                    TodayEventRow(title: row.1, subline: row.2, time: row.3)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .disabled(row.4 == nil)
                .accessibilityHint("Opens this event")
                if row.0 != rows.last?.0 { BobDivider() }
            }
        }
    }

    private func bobButton(size: CGFloat) -> some View {
        Button(action: onBob) {
            BobFaceBadge(size: size)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel("Talk to Bob")
    }
}

#Preview("Loaded") {
    TodayView(model: TodayViewModel(
        provider: StubTodayProvider(delay: .zero), clock: Date.init,
        state: .loaded(StubTodayProvider.content(now: Date()))
    ))
}
