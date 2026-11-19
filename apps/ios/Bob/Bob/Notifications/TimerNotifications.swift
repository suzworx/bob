import BobKit
import Observation
import SwiftUI
import UserNotifications

@MainActor
@Observable
final class TimerNotifications: NSObject {
    static let shared = TimerNotifications()

    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var statusMessage = "Enable alerts for timers and alarms synced on this iPhone."
    private(set) var errorMessage: String?
    private(set) var refreshing = false
    private let scheduler: TimerNotificationScheduler
    private let reconciler: TimerAlertReconciler
    private var generation = 0
    private var askingPermission = false

    override private init() {
        let scheduler = TimerNotificationScheduler()
        self.scheduler = scheduler
        reconciler = TimerAlertReconciler(scheduler: scheduler)
        super.init()
        // Retained for the application's lifetime, installed before any request can be delivered.
        scheduler.center.delegate = self
    }

    func refresh(requestPermission: Bool = false) async {
        let lease = TimerNotificationBackgroundLease()
        defer { lease.end() }
        generation += 1
        let attempt = generation
        refreshing = true
        defer { if attempt == generation { refreshing = false } }
        await updateAuthorization()
        guard attempt == generation else { return }
        do {
            guard let manager = AppSession.manager, let accountID = try await manager.userID(),
                  let client = AppSession.make({ TimersClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) else {
                await signedOut()
                return
            }
            guard attempt == generation else { return }
            if requestPermission && authorization == .notDetermined && !askingPermission {
                let timers = try await client.list()
                guard attempt == generation, try await manager.userID() == accountID else { return }
                if !timers.isEmpty {
                    await askPermission()
                    // The system permission sheet changes scene phase. A foreground
                    // refresh can supersede us; always reconcile a fresh signed-in session.
                    await refresh()
                    return
                }
            }
            guard attempt == generation, try await manager.userID() == accountID else { return }
            guard authorization == .authorized || authorization == .provisional || authorization == .ephemeral else {
                await reconciler.signOut()
                return
            }
            await reconciler.refresh(accountID: accountID) { trackedIDs in
                guard try await manager.userID() == accountID else { throw CancellationError() }
                let timers = try await client.notificationState(trackedIDs: trackedIDs)
                guard try await manager.userID() == accountID else { throw CancellationError() }
                return timers
            }
            guard attempt == generation, try await manager.userID() == accountID else { return }
            errorMessage = reconciler.errorMessage
            await PushNotifications.shared.refresh()
        } catch where isCancelled(error) {
            return
        } catch {
            if attempt == generation { errorMessage = "Bob couldn't refresh timer alerts. Try again when you're connected." }
        }
    }

    func signedOut() async {
        generation += 1
        refreshing = false
        errorMessage = nil
        await reconciler.signOut()
    }

    func requestPermission() async {
        await askPermission()
        await refresh()
    }

    func cancel(timerID: String) async {
        guard let accountID = try? await AppSession.manager?.userID() else { return }
        await reconciler.cancel(timerID: timerID, accountID: accountID)
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func askPermission() async {
        guard !askingPermission else { return }
        askingPermission = true
        defer { askingPermission = false }
        do {
            _ = try await scheduler.center.requestAuthorization(options: [.alert, .sound])
            errorMessage = nil
        } catch {
            errorMessage = "Bob couldn't ask for notification access. Try again in Settings."
        }
        await updateAuthorization()
    }

    private func updateAuthorization() async {
        let settings = await scheduler.center.notificationSettings()
        authorization = settings.authorizationStatus
        switch authorization {
        case .notDetermined:
            statusMessage = "Enable alerts for timers and alarms synced on this iPhone."
        case .denied:
            statusMessage = "Timer alerts are off. Allow notifications for Bob in iPhone Settings."
        case .authorized, .ephemeral:
            if settings.alertSetting != .enabled {
                statusMessage = "Timer banners are off. Check notification settings on this iPhone."
            } else {
                statusMessage = settings.soundSetting == .enabled
                    ? "Timer alerts are on. Silent mode and Focus can silence them."
                    : "Timer alerts are on, but sounds are off in iPhone Settings."
            }
        case .provisional:
            statusMessage = "Timer alerts arrive quietly. Enable sounds and banners in iPhone Settings."
        @unknown default:
            statusMessage = "Check notification access in iPhone Settings."
        }
    }

    private func belongsToSignedInAccount(_ accountID: String) async -> Bool {
        guard let current = try? await AppSession.manager?.userID() else { return false }
        return current == accountID
    }
}

/// Finish a just-created timer's sync if the person leaves Bob immediately.
/// iOS bounds this lease; it does not provide background polling or execution.
@MainActor
private final class TimerNotificationBackgroundLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Sync timer alerts") { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}

extension TimerNotifications: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        if let payload = PushNotifications.payload(notification.request.content.userInfo) {
            return await PushNotifications.shared.willPresent(payload) ? [.banner, .list, .sound] : []
        }
        guard let alert = TimerNotificationScheduler.alert(notification.request),
              await belongsToSignedInAccount(alert.accountID) else { return [] }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse) async {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let payload = PushNotifications.payload(response.notification.request.content.userInfo) {
            await PushNotifications.shared.open(payload)
            return
        }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let alert = TimerNotificationScheduler.alert(response.notification.request),
              await belongsToSignedInAccount(alert.accountID) else { return }
        await MainActor.run { ShellDestinations.shared.send(.calendar) }
    }
}

/// Shared by Calendar and Settings so disabled or failed delivery is never hidden.
struct TimerNotificationStatusView: View {
    private let alerts = TimerNotifications.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(alerts.statusMessage).font(BobFont.subline).foregroundStyle(BobColor.ink2)
            if let error = alerts.errorMessage {
                Text(error).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                Button("Retry timer alerts") { Task { await alerts.refresh() } }
                    .buttonStyle(BobSecondaryButtonStyle()).disabled(alerts.refreshing)
            }
            if alerts.authorization == .notDetermined {
                Button("Enable timer alerts") { Task { await alerts.requestPermission() } }
                    .buttonStyle(BobSecondaryButtonStyle()).disabled(alerts.refreshing)
            } else {
                Button("iPhone notification settings") { alerts.openSettings() }
                    .font(BobFont.subline).frame(minHeight: 44)
            }
        }
    }
}
