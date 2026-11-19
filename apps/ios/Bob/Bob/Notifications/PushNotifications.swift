import BobKit
import Observation
import SwiftUI
import UserNotifications

@MainActor @Observable final class PushNotifications {
    static let shared = PushNotifications()
    private(set) var pendingTap: BobPushNotification?
    private(set) var refreshing = false
    private(set) var statusMessage = "Checking remote alerts…"
    private(set) var errorMessage: String?
    private let coordinator = PushRegistrationCoordinator()
    private let timers = TimerNotificationScheduler()
    private let environment = (Bundle.main.object(forInfoDictionaryKey: "BobPushEnvironment") as? String)
        .flatMap(PushDeviceRegistration.Environment.init(rawValue:))
    private let installationID: String
    private var deviceToken: String?
    private var registrationRequested = false
    private var generation = 0
    var supported: Bool { environment != nil }

    private init() {
        let key = "bob.push.installation.v1"
        if let stored = UserDefaults.standard.string(forKey: key), UUID(uuidString: stored) != nil { installationID = stored }
        else { installationID = UUID().uuidString.lowercased(); UserDefaults.standard.set(installationID, forKey: key) }
    }

    func refresh() async {
        generation += 1
        let attempt = generation
        refreshing = true
        errorMessage = nil
        defer { if generation == attempt { refreshing = false } }
        guard let environment else {
            statusMessage = "Remote alerts aren't available in this build. Local timer alerts still work."
            return
        }
        let settings = await timers.center.notificationSettings()
        guard generation == attempt else { return }
        guard [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else {
            UIApplication.shared.unregisterForRemoteNotifications()
            deviceToken = nil; registrationRequested = false
            await coordinator.signOut()
            guard generation == attempt else { return }
            statusMessage = settings.authorizationStatus == .denied
                ? "Remote alerts are off. Allow Bob notifications in iPhone Settings."
                : "Enable notifications to receive reminders and updates from Bob."
            return
        }
        do {
            let capturedSession = try await AppSession.pushSession()
            guard generation == attempt else { return }
            guard let session = capturedSession else { await signedOut(); return }
            if let previous = coordinator.accountID, previous != session.accountID {
                await removeDelivered(accountID: previous)
                guard generation == attempt else { return }
            }
            guard let deviceToken else {
                statusMessage = "Connecting iPhone alerts…"
                if !registrationRequested { registrationRequested = true; UIApplication.shared.registerForRemoteNotifications() }
                return
            }
            let localTimerIDs = await timers.localTimerIDs(accountID: session.accountID)
            guard generation == attempt, try await AppSession.manager?.userID() == session.accountID else { return }
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
            let input = PushDeviceRegistration(installationID: installationID, token: deviceToken, environment: environment,
                                               topic: Bundle.main.bundleIdentifier ?? "", appVersion: String(version.prefix(40)), localTimerIDs: localTimerIDs)
            await coordinator.register(input, session: session)
            guard generation == attempt else { return }
            errorMessage = coordinator.errorMessage
            if coordinator.deliveryAvailable == true {
                statusMessage = settings.authorizationStatus == .provisional || settings.alertSetting != .enabled
                    ? "Remote updates can arrive quietly. Check iPhone Settings for banners and sounds."
                    : "Remote alerts are on. Focus and silent mode can silence them."
            } else { statusMessage = "Remote delivery isn't ready on Bob's service yet. Local timer alerts still work." }
        } catch {
            if generation == attempt { errorMessage = "Bob couldn't connect remote alerts. Try again when you're online." }
        }
    }

    func requestPermission() async {
        guard supported else { await refresh(); return }
        do { _ = try await timers.center.requestAuthorization(options: [.alert, .sound]) }
        catch { errorMessage = "Bob couldn't request notification access. You can review it in iPhone Settings." }
        await refresh()
    }

    func registered(deviceToken: Data) async {
        registrationRequested = false
        guard supported, (32...256).contains(deviceToken.count), (try? await AppSession.manager?.userID()) != nil else {
            UIApplication.shared.unregisterForRemoteNotifications()
            return
        }
        self.deviceToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        await refresh()
    }

    func registrationFailed() {
        guard registrationRequested else { return }
        registrationRequested = false
        errorMessage = "This iPhone couldn't connect remote notifications. Local timer alerts still work."
    }

    func signedOut() async {
        generation += 1
        let attempt = generation
        let oldAccount = coordinator.accountID
        UIApplication.shared.unregisterForRemoteNotifications()
        deviceToken = nil; registrationRequested = false; pendingTap = nil; refreshing = false; errorMessage = nil
        await coordinator.signOut()
        let delivered = await timers.center.deliveredNotifications()
        let ids = delivered.filter { notification in
            guard let payload = Self.payload(notification.request.content.userInfo) else { return false }
            return oldAccount.map { payload.belongs(to: $0) } ?? (attempt == generation)
        }.map { $0.request.identifier }
        timers.center.removeDeliveredNotifications(withIdentifiers: ids)
        if generation == attempt { statusMessage = "Sign in to receive Bob updates on this iPhone." }
    }

    nonisolated static func payload(_ userInfo: [AnyHashable: Any]) -> BobPushNotification? {
        guard let bob = userInfo["bob"] as? [String: Any], JSONSerialization.isValidJSONObject(bob),
              let data = try? JSONSerialization.data(withJSONObject: bob) else { return nil }
        return BobPushNotification.decode(data)
    }

    func willPresent(_ payload: BobPushNotification) async -> Bool {
        guard let account = try? await AppSession.manager?.userID(), payload.belongs(to: account) else { return false }
        if payload.kind == .timer {
            let covered = await timers.localTimerIDs(accountID: account)
            guard (try? await AppSession.manager?.userID()) == account else { return false }
            return !covered.contains(payload.resourceID)
        }
        return true
    }

    func open(_ payload: BobPushNotification) async {
        guard let account = try? await AppSession.manager?.userID(), payload.belongs(to: account) else { return }
        pendingTap = payload
    }

    func clearPendingTap() { pendingTap = nil }

    private func removeDelivered(accountID: String) async {
        let delivered = await timers.center.deliveredNotifications()
        let ids = delivered.filter { Self.payload($0.request.content.userInfo)?.belongs(to: accountID) == true }
            .map { $0.request.identifier }
        timers.center.removeDeliveredNotifications(withIdentifiers: ids)
    }
}

struct PushNotificationStatusView: View {
    private let push = PushNotifications.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(push.statusMessage).font(BobFont.subline).foregroundStyle(BobColor.ink2)
            if let error = push.errorMessage { Text(error).font(BobFont.subline).foregroundStyle(BobColor.dangerText) }
            if push.supported {
                Button("Enable or retry remote alerts") { Task { await push.requestPermission() } }
                    .buttonStyle(BobSecondaryButtonStyle()).disabled(push.refreshing)
                Button("iPhone notification settings") { TimerNotifications.shared.openSettings() }
                    .font(BobFont.subline).frame(minHeight: 44)
            }
        }.task { await push.refresh() }
    }
}
