import BobKit
import SwiftUI

// What Bob and other people told the person. Native push isn't here yet: it needs the server half, #1264.
struct NotificationsView: View {
    let model: NotificationsModel
    let zone: String
    let open: (NotificationTarget, String?) -> Void

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            Picker("Notifications filter", selection: Binding(
                get: { model.unreadOnly },
                set: { value in Task { await model.setUnreadOnly(value) } }
            )) {
                Text("All").tag(false)
                Text("Unread").tag(true)
            }
            .pickerStyle(.segmented)
            .bobListRow(divider: false)
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading notifications")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load notifications", error: error) { await model.refresh() }
                    .bobListRow(divider: false)
            case .loaded:
                if model.items.isEmpty {
                    ContentUnavailableView {
                        Text("You're all caught up").font(BobFont.heading)
                    } description: {
                        Text(model.unreadOnly ? "No unread notifications. Your other updates are in All." : "Mentions, assignments, reminders and notes from Bob show up here.")
                    }
                    .bobListRow(divider: false)
                }
                ForEach(model.items) { row($0) }
                moreRow
            }
        }
        .bobList()
        .privacySensitive()
        .bobNavTitle("Notifications")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Mark all read") { Task { await model.markAllRead() } }
                    .font(BobFont.caption)
                    .disabled(!model.hasUnread || model.items.isEmpty)
            }
        }
        .task { await model.refresh(quiet: !model.items.isEmpty) }
        .refreshable { await model.refresh(quiet: true) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh(quiet: true) } }
        }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private func row(_ item: InboxNotification) -> some View {
        let row = NotificationRules.row(item, zone: zone, now: Date())
        return Button {
            Task { await model.markRead(item, quietly: true) }
            if let target = row.target { open(target, item.spaceID) }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.label).font(BobFont.rowTitle).fontWeight(item.isUnread ? .semibold : .regular).foregroundStyle(.primary)
                    if !row.description.isEmpty {
                        Text(row.description).font(BobFont.subline).foregroundStyle(.secondary)
                    }
                    Text(item.createdAt, format: .relative(presentation: .named))
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if item.isUnread {
                    Circle().fill(BobColor.accent).frame(width: 8, height: 8).accessibilityHidden(true)
                }
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityValue(item.isUnread ? "Unread" : "")
        .accessibilityHint(row.target == nil ? (item.isUnread ? "Marks it read" : "") : "Opens it")
        .bobListRow()
        .swipeActions(edge: .leading) {
            if item.isUnread {
                Button("Mark read") { Task { await model.markRead(item) } }
                    .tint(BobColor.accent)
            }
        }
    }

    @ViewBuilder private var moreRow: some View {
        if model.nextCursor != nil {
            VStack(alignment: .leading, spacing: 4) {
                Button {
                    Task { await model.loadMore() }
                } label: {
                    if model.loadingMore {
                        ProgressView().accessibilityLabel("Loading older notifications")
                    } else {
                        Text("Show older")
                    }
                }
                .buttonStyle(BobSecondaryButtonStyle())
                .disabled(model.loadingMore)
                if model.moreFailed {
                    Text("Couldn't load older notifications.").font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                }
            }
            .padding(.top, 12)
            .bobListRow(divider: false)
        }
    }
}

// One inbox indicator across the five root screens, backed by the account inbox count.
struct BobNotificationsButton: View {
    let model: NotificationsModel
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "bell")
                .frame(minWidth: 44, minHeight: 44)
                .overlay(alignment: .topTrailing) {
                    if model.unread > 0 {
                        Text(NotificationRules.unreadLabel(model.unread))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(BobColor.page)
                            .padding(.horizontal, 5)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(BobColor.accent, in: Capsule())
                            .accessibilityHidden(true)
                    }
                }
        }
        .accessibilityLabel("Notifications")
        .accessibilityValue(model.unread > 0 ? "\(model.unread) unread" : "No unread notifications")
        .task { await model.refreshCount() }
    }
}
