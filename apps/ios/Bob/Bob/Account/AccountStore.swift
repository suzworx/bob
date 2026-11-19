import BobKit
import Foundation
import Observation
import SwiftUI

enum YouRoute: Hashable {
    case profile, timeZone, usage, notifications, notificationSettings, appearance, siri, yourData, deleteAccount
    case devices, administration, operatorMetrics
    case device(String)
    case deviceSound(String)
    case deviceListening(String)
    case deviceTalkingIn(String)
    case deviceStartsIn(String)
}

// The You tab's state, owned by the shell so it survives switching tabs and leaves with the person's session. Nothing here touches disk.
@MainActor @Observable final class AccountStore {
    var path = NavigationPath()
    let account: AccountModel
    let notifications: NotificationsModel
    let devices: DevicesModel

    init(services: AccountServices) {
        account = AccountModel(service: services.account, hasSession: services.hasSession, isDemo: services.isDemo)
        notifications = NotificationsModel(service: services.notifications)
        devices = DevicesModel(service: services.devices)
    }
}

@MainActor @Observable final class AccountModel {
    private(set) var profile: AccountProfile?
    private(set) var exporting = false
    private(set) var signingOutEverywhere = false
    // Why the last export didn't arrive, with whether trying again can help.
    private(set) var exportProblem: String?
    var pendingExport: AccountExport?
    var message: String?

    let service: AccountService
    let hasSession: Bool
    let isDemo: Bool

    init(service: AccountService, hasSession: Bool, isDemo: Bool) {
        self.service = service
        self.hasSession = hasSession
        self.isDemo = isDemo
    }

    var canEditProfile: Bool { hasSession || isDemo }
    var zone: String { profile?.timeZone ?? TimeZone.current.identifier }

    func loadProfile() async {
        if let found = await service.profile() { profile = found }
    }

    func saveName(_ name: String) async throws {
        try await service.setName(name)
        profile?.name = name
        await loadProfile()
        profile?.name = name
    }

    func saveZone(_ zone: String) async throws {
        try await service.setTimeZone(zone)
        profile?.timeZone = zone
        await loadProfile()
        profile?.timeZone = zone
    }

    func export() async {
        guard !exporting else { return }
        exporting = true
        exportProblem = nil
        defer { exporting = false }
        do {
            pendingExport = try await service.export()
        } catch ApiError.rateLimited {
            exportProblem = "You just exported your data. Try again in a minute."
        } catch where isCancelled(error) {
            return
        } catch {
            exportProblem = "Your data couldn't be exported. Try again."
        }
    }

    func finishExport(saved: Bool) {
        pendingExport = nil
        if saved { AccessibilityAnnouncer.say("Your data was saved") }
    }

    // A failed revoke keeps this phone signed in, so the person can see it failed and try again.
    func signOutEverywhere() async {
        signingOutEverywhere = true
        defer { signingOutEverywhere = false }
        do {
            try await service.signOutEverywhere()
            await AppSession.gate.signOut()
        } catch {
            message = "Other devices may still be signed in. Try again."
        }
    }

    // After the server has deleted it, this phone must not stay signed in, whether or not the other sessions could be ended.
    func finishDeletion() async {
        try? await service.signOutEverywhere()
        await AppSession.gate.signOut()
    }
}
