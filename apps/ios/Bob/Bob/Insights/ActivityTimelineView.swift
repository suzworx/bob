import BobKit
import SwiftUI

struct ActivityTimelineView: View {
    let store: ProductivityStore
    let chat: ChatRouting
    @Environment(ShellStore.self) private var shell
    @State private var model = InsightServices.timeline()
    @State private var moreTask: Task<Void, Never>?
    @State private var detail: TimelineEntry?

    var body: some View {
        List {
            controls
            Text("A day at a time: conversations, recaps and things you worked on. Notes show their latest update; this isn't a complete change log.")
                .font(BobFont.subline).foregroundStyle(.secondary)
                .bobListRow(divider: false)
            results
        }
        .bobList()
        .bobNavTitle("Timeline")
        .privacySensitive()
        .task(id: model.query) { await model.refresh() }
        .refreshable { await model.refresh() }
        .onDisappear { moreTask?.cancel(); model.cancel() }
        .sheet(item: $detail) { entry in
            NavigationStack {
                TimelineDetailView(entry: entry)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { detail = nil } } }
            }
            .bobSheet()
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { model.shiftDay(-1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                    .accessibilityLabel("Previous day")
                DatePicker("Day", selection: $model.date, displayedComponents: .date)
                    .labelsHidden()
                    .environment(\.timeZone, TimeZone(identifier: model.timeZone) ?? .current)
                    .frame(maxWidth: .infinity)
                Button { model.shiftDay(1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }
                    .accessibilityLabel("Next day")
            }
            HStack {
                Picker("Show", selection: $model.kind) {
                    ForEach(TimelineKind.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.menu)
                Spacer()
                Button("Today") { model.date = Date() }.frame(minHeight: 44)
            }
            Text(model.timeZone.replacingOccurrences(of: "_", with: " "))
                .font(BobFont.caption).foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .padding(.vertical, 8)
        .bobListRow(divider: false)
    }

    @ViewBuilder private var results: some View {
        switch model.phase {
        case .loading:
            ProgressView("Opening your day…").bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load this day", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loaded:
            if model.page?.entries.isEmpty == true {
                ContentUnavailableView("A quiet day here", systemImage: "sun.max", description: Text("Activity appears as you chat, finish tasks and run routines. Try another day or choose Everything."))
                    .bobListRow(divider: false)
            }
            ForEach(model.page?.entries ?? []) { entry in
                Button { open(entry) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: entry.kind.symbol).frame(width: 24).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.title.isEmpty ? "Untitled" : entry.title).font(BobFont.rowTitle)
                            Text("\(ProductivityText.time(entry.at, zone: model.timeZone)) · \(entry.status ?? entry.action)")
                                .font(BobFont.subline).foregroundStyle(.secondary)
                            if entry.count > 1 { Text("\(entry.count) items").font(BobFont.caption).foregroundStyle(.secondary) }
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(BobFont.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                    }
                    .foregroundStyle(BobColor.ink)
                    .padding(.vertical, 8)
                }
                .buttonStyle(BobPressStyle())
                .bobListRow()
            }
            if let error = model.moreError {
                Text(ApiErrorMapper.userMessage(error)).font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow(divider: false)
            }
            if model.page?.nextCursor != nil {
                Button(model.moreError == nil ? "Show earlier activity" : "Try earlier activity again") {
                    moreTask?.cancel()
                    moreTask = Task { await model.more() }
                }
                .disabled(model.moreBusy)
                .overlay(alignment: .trailing) { if model.moreBusy { ProgressView() } }
                .bobListRow(divider: false)
            }
        }
    }

    private func open(_ entry: TimelineEntry) {
        switch entry.kind {
        case .task: store.openItem(.task(entry.recordID), in: entry.spaceID)
        case .note: store.openItem(.note(entry.recordID), in: entry.spaceID)
        case .event:
            store.calendar.eventTarget = CalendarEventTarget(eventID: entry.recordID, spaceID: entry.spaceID)
            shell.openCalendar()
        case .conversation:
            if let spaceID = entry.spaceID {
                store.path.append(ProductivityRoute.thread(id: entry.recordID, spaceID: spaceID))
            } else { chat.open(entry.recordID) }
        default: detail = entry
        }
    }
}

private struct TimelineDetailView: View {
    let entry: TimelineEntry
    @State private var recap: TimelineRecap?
    @State private var failure: ApiError?
    @State private var loading = false
    @State private var revision = 0

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 12) {
                Text(entry.title).font(BobFont.heading).accessibilityAddTraits(.isHeader)
                Text(ProductivityText.moment(entry.at)).font(BobFont.subline).foregroundStyle(.secondary)
                Text(entry.status ?? entry.action).font(BobFont.caption).foregroundStyle(.secondary)
                if loading { ProgressView("Opening this recap…") }
                if let recap {
                    if let result = recap.result {
                        if result.partial { Text("Some sources couldn't be included.").font(BobFont.subline) }
                        ChatMarkdownView(text: result.summary).textSelection(.enabled)
                        ForEach(result.sources) { source in
                            if let url = source.safeURL { Link(source.label, destination: url).font(BobFont.body) }
                            else { Text(source.label).font(BobFont.body) }
                        }
                    } else {
                        Text("No saved recap is available for this run.").font(BobFont.body)
                    }
                }
                if entry.kind == .event {
                    Text("This records when the event was added. Open Calendar for its current schedule and details.")
                        .font(BobFont.body)
                }
            }
            .padding(.vertical, 12)
            .bobListRow(divider: false)
            if let failure {
                BobLoadFailure(title: "Couldn't open this recap", error: failure) { revision += 1 }
                    .bobListRow(divider: false)
            }
        }
        .bobList()
        .bobNavTitle(entry.kind == .routine ? "Routine recap" : "Activity")
        .privacySensitive()
        .task(id: revision) { await load() }
    }

    private func load() async {
        guard entry.kind == .routine, let routineID = entry.routineID else { return }
        guard let client = AppSession.make({ TimelineClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) else { return }
        loading = true
        failure = nil
        defer { loading = false }
        do {
            let recap = try await client.recap(routineID: routineID, runID: entry.recordID)
            guard !Task.isCancelled else { return }
            self.recap = recap
        } catch {
            guard !Task.isCancelled, !isCancelled(error) else { return }
            failure = apiError(error)
        }
    }
}
