import BobKit
import SwiftUI

struct DeviceHandoffRequest: Identifiable {
    let id = UUID()
    let title: String
    let target: DeviceTalkTarget
}

// A deliberate device choice: no pointer moves until the person taps a named device.
struct DeviceHandoffSheet: View {
    let request: DeviceHandoffRequest
    @State private var devices: [Device] = []
    @State private var loading = true
    @State private var error: ApiError?
    @State private var sendingID: String?
    @State private var receipt: String?
    @State private var generation = 0
    @Environment(\.dismiss) private var dismiss
    private let client = AppSession.make { DevicesClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }
    private let demoService: DevicesService = AccountServices.make().devices

    var body: some View {
        NavigationStack {
            List {
                VStack(alignment: .leading, spacing: 8) {
                    Text(request.title).font(BobFont.heading)
                    Text(explanation).font(BobFont.body).foregroundStyle(.secondary)
                    if client == nil { Text("Preview devices · changes stay in this demo").font(BobFont.caption).foregroundStyle(.secondary) }
                }.padding(.vertical, 12).bobListRow(divider: false)
                if let receipt {
                    Label(receipt, systemImage: "checkmark.circle").font(BobFont.body).bobListRow(divider: false)
                }
                if let error {
                    BobLoadFailure(title: devices.isEmpty ? "Couldn't load your devices" : "Couldn't change the device conversation", error: error) { await load() }.bobListRow(divider: false)
                }
                if loading { ProgressView("Finding your devices…").bobListRow(divider: false) }
                else if devices.isEmpty && error == nil {
                    ContentUnavailableView("No devices paired yet", systemImage: "desktopcomputer", description: Text("Open You, then Devices, to pair Bob with the code on its screen.")).bobListRow(divider: false)
                }
                ForEach(devices) { device in
                    Button { send(to: device) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(device.name).font(BobFont.rowTitle)
                                Text(DeviceRules.isOnline(device) ? "Connected" : "Offline · applies when it reconnects").font(BobFont.subline).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            if sendingID == device.id { ProgressView().accessibilityLabel("Sending to \(device.name)") }
                        }.padding(.vertical, 8).frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(BobPressStyle()).disabled(sendingID != nil).bobListRow()
                }
            }
            .bobList().bobNavTitle("Use on device").privacySensitive()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(sendingID != nil) } }
            .task { await load() }.refreshable { await load() }
            .onDisappear { generation += 1 }
            .interactiveDismissDisabled(sendingID != nil)
        }.bobSheet()
    }
    private var explanation: String {
        switch request.target {
        case .newConversation(let spaceID): spaceID == nil ? "The next turn starts a new conversation in General on the device you choose." : "The next turn starts a new conversation in this space on the device you choose."
        case .conversation: "Continue this chat on the device you choose. Its next turn will use this conversation."
        case .thread: "Continue this space thread on the device you choose. Its next turn will use this thread."
        }
    }
    private func load() async {
        guard sendingID == nil else { return }
        generation += 1; let request = generation
        loading = devices.isEmpty; error = nil
        do {
            let rows: [Device]
            if let client { rows = try await client.devices() } else { rows = try await demoService.devices() }
            guard request == generation, !Task.isCancelled else { return }; devices = rows; loading = false
        } catch {
            guard request == generation, !Task.isCancelled else { return }; loading = false
            self.error = (error as? ApiError) ?? .unknown(status: 0)
        }
    }
    private func send(to device: Device) {
        guard sendingID == nil else { return }
        generation += 1; let lifetime = generation
        sendingID = device.id; error = nil; receipt = nil
        Task {
            defer { if lifetime == generation { sendingID = nil } }
            do {
                let result: DeviceHandoffReceipt
                if let client { result = try await client.handoff(deviceID: device.id, target: request.target) }
                else {
                    try await demoService.setTalkingIn(deviceID: device.id, target: request.target)
                    result = DeviceRules.isOnline(device) ? .sent : .pending
                }
                guard lifetime == generation, !Task.isCancelled else { return }
                receipt = result == .pending ? "Pending — applies when \(device.name) reconnects." : "Sent to \(device.name)."
                if let receipt { AccessibilityAnnouncer.say(receipt) }
            } catch {
                guard lifetime == generation, !Task.isCancelled else { return }
                self.error = (error as? ApiError) ?? .unknown(status: 0)
            }
        }
    }
}
