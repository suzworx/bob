import BobKit
import Foundation
import Observation

// The devices paired to the account. Held in memory only.
@MainActor @Observable final class DevicesModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var devices: [Device] = []
    // The change being saved: every control waits while one saves, except the volume slider itself.
    private(set) var saving: DeviceSettingChange?
    private(set) var justPaired: String?
    var message: String?

    let service: DevicesService
    private var loadID = 0

    init(service: DevicesService) {
        self.service = service
    }

    var summary: String? {
        guard phase == .loaded, !devices.isEmpty else { return nil }
        return "\(devices.filter(DeviceRules.isOnline).count) connected"
    }

    func device(_ id: String) -> Device? {
        devices.first { $0.id == id }
    }

    // A quiet refresh keeps the list on a failure, and a store outage is never shown as an empty list.
    func refresh(quiet: Bool = false) async {
        loadID += 1
        let id = loadID
        if !quiet { phase = .loading }
        do {
            let found = try await service.devices()
            guard id == loadID, saving == nil else { return }
            devices = found
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            guard id == loadID else { return }
            if quiet, phase == .loaded { return }
            phase = .failed(apiError(error))
        }
    }

    // Throws so the sheet can keep the text and say why.
    func rename(_ device: Device, to name: String) async throws {
        let saved = try await service.rename(deviceID: device.id, name: name)
        if let index = devices.firstIndex(where: { $0.id == device.id }) { devices[index].name = saved }
        AccessibilityAnnouncer.say("Renamed to \(saved)")
    }

    func remove(_ device: Device) async throws {
        try await service.remove(deviceID: device.id)
        devices.removeAll { $0.id == device.id }
        AccessibilityAnnouncer.say("\(device.name) removed")
    }

    // Every control shows what the server acknowledged. A failure keeps that value and says which setting.
    func change(_ device: Device, _ change: DeviceSettingChange) async {
        saving = change
        defer { saving = nil }
        do {
            let update = try await service.update(deviceID: device.id, change: change)
            if let index = devices.firstIndex(where: { $0.id == device.id }) {
                devices[index].settings = update.settings
                devices[index].pending = update.pending
            }
        } catch where isCancelled(error) {
            return
        } catch ApiError.settingUnsupported {
            message = ApiErrorMapper.userMessage(.settingUnsupported)
        } catch {
            message = "Couldn't change \(change.name)."
        }
    }

    // What the talking-in rows need. A failure leaves them saying less; the pickers say so.
    private(set) var talkChoices: DeviceTalkChoices?
    private(set) var talkPhase: LoadPhase = .loading
    private(set) var savingPointer = false

    func loadTalkChoices() async {
        do {
            talkChoices = try await service.talkChoices()
            talkPhase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            if talkChoices == nil { talkPhase = .failed(apiError(error)) }
        }
    }

    func talkingIn(_ device: Device) -> String {
        guard let choices = talkChoices else { return device.activeConversationID == nil ? "A new conversation" : "A conversation" }
        return DeviceTalkRules.talkingIn(device, options: choices.options, spaces: choices.spaces)
    }

    func startsIn(_ device: Device) -> String {
        DeviceTalkRules.spaceName(device.activeSpaceID, spaces: talkChoices?.spaces ?? [])
    }

    // An offline device takes this up when it next connects, so that's what the person is told.
    func setTalkingIn(_ device: Device, target: DeviceTalkTarget) async {
        savingPointer = true
        defer { savingPointer = false }
        do {
            try await service.setTalkingIn(deviceID: device.id, target: target)
            await refresh(quiet: true)
            AccessibilityAnnouncer.say(DeviceRules.isOnline(device) ? "Changed" : "Waiting for \(device.name) to come online")
        } catch where isCancelled(error) {
            return
        } catch {
            message = "Couldn't change what \(device.name) talks in."
        }
    }

    func setStartsIn(_ device: Device, spaceID: String?) async {
        savingPointer = true
        defer { savingPointer = false }
        do {
            try await service.setNewConversationSpace(deviceID: device.id, spaceID: spaceID)
            await refresh(quiet: true)
        } catch where isCancelled(error) {
            return
        } catch {
            message = "Couldn't change where \(device.name) starts conversations."
        }
    }

    func startThread(_ device: Device, in space: SpaceSummary) async {
        do {
            let thread = try await service.startThread(spaceID: space.id)
            await setTalkingIn(device, target: .thread(id: thread.id, spaceID: space.id))
            await loadTalkChoices()
        } catch where isCancelled(error) {
            return
        } catch {
            message = productivityMessage(error)
        }
    }

    func pair(code: String, name: String?) async throws {
        let paired = try await service.pair(code: PairCode.normalized(code), name: name)
        justPaired = paired.deviceID
        await refresh(quiet: true)
        AccessibilityAnnouncer.say("\(paired.name) is paired")
    }
}
