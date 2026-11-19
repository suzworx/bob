import BobKit
import SwiftUI
import UIKit

private let bobKitModule = BobKit.moduleName

@main struct BobApp: App {
    @UIApplicationDelegateAdaptor(BobApplicationDelegate.self) private var delegate
    init() {
        _ = bobKitModule
        _ = TimerNotifications.shared
        BobNavigationAppearance.apply(BobAppearanceStore.shared.value.typeface)
    }

    var body: some Scene {
        WindowGroup {
            AppShell()
        }
    }
}

final class BobApplicationDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushNotifications.shared.registered(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        Task { @MainActor in PushNotifications.shared.registrationFailed() }
    }
}
