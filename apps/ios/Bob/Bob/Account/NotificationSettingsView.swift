import BobKit
import SwiftUI

// iPhone delivery permissions are separate from Core's inbox preferences.
struct NotificationSettingsView: View {
    let service: NotificationsService
    @Environment(\.scenePhase) private var scenePhase

    @State private var phase: LoadPhase = .loading
    @State private var preferences: [NotificationPreference] = []
    @State private var saving: NotificationKind?
    @State private var message: String?

    var body: some View {
        List {
            Section {
                TimerNotificationStatusView().bobListRow(divider: false)
                Text("Timers and alarms are synced while Bob is open, then delivered by your iPhone even after you leave the app. Changes made elsewhere need Bob to open and sync again.")
                    .font(BobFont.subline).foregroundStyle(BobColor.ink2).bobListRow(divider: false)
            } header: {
                Text("On this iPhone")
            }
            Section {
                PushNotificationStatusView().bobListRow(divider: false)
            } header: {
                Text("Reminders and remote updates")
            }
            Section {
            switch phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading notification settings")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load notification settings", error: error) { await load() }
                    .bobListRow(divider: false)
            case .loaded:
                Text("Choose which updates Bob sends to your inbox and, when available, this iPhone. Control banners and sounds in iPhone Settings.")
                    .font(BobFont.subline)
                    .foregroundStyle(BobColor.ink2)
                    .bobListRow(divider: false)
                ForEach(NotificationRules.settings) { setting in
                    Toggle(isOn: binding(setting.kind)) {
                        label(setting.label, setting.description)
                    }
                    .toggleStyle(BobToggleStyle())
                    .disabled(saving != nil)
                    .bobListRow()
                }
                Toggle(isOn: .constant(true)) {
                    label("Security notices", "New sign-ins, paired devices and connected accounts. Always on.")
                }
                .toggleStyle(BobToggleStyle())
                .disabled(true)
                .bobListRow()
            }
            } header: {
                Text("Bob inbox")
            }
        }
        .bobList()
        .bobNavTitle("Notification settings")
        .task {
            async let preferences: Void = load()
            await TimerNotifications.shared.refresh()
            await preferences
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await TimerNotifications.shared.refresh(); await PushNotifications.shared.refresh() }
            }
        }
        .bobErrorAlert(message) { message = nil }
    }

    private func label(_ title: String, _ description: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(BobFont.rowTitle)
            Text(description).font(BobFont.subline).foregroundStyle(BobColor.ink2)
        }
    }

    private func binding(_ kind: NotificationKind) -> Binding<Bool> {
        Binding(
            get: { !NotificationRules.isMuted(preferences, kind: kind) },
            set: { on in Task { await save(kind, on: on) } }
        )
    }

    private func load() async {
        phase = .loading
        do {
            preferences = try await service.preferences()
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            phase = .failed(apiError(error))
        }
    }

    // The switch moves at once and goes back if the save fails.
    private func save(_ kind: NotificationKind, on: Bool) async {
        let previous = preferences
        let isThisKind: (NotificationPreference) -> Bool = { $0.isAccountWide && $0.kind == kind }
        preferences = previous.filter { !isThisKind($0) } + [NotificationPreference(kind: kind, muted: !on)]
        saving = kind
        defer { saving = nil }
        do {
            let saved = try await service.setMuted(kind, muted: !on)
            preferences = preferences.filter { !isThisKind($0) } + [saved]
        } catch {
            preferences = previous
            if !isCancelled(error) { message = "Couldn't save that setting. Try again." }
        }
    }
}
