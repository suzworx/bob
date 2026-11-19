import BobKit
import SwiftUI

// One device: how it is, what can be done with it now, its settings, what it heard lately, and what it is.
struct DeviceDetailView: View {
    let id: String
    let model: DevicesModel
    var openChat: (String) -> Void = { _ in }
    var onRemoved: () -> Void = {}

    @Environment(\.scenePhase) private var scenePhase
    @State private var activity: [DeviceActivityItem]?
    @State private var activityFailed = false
    @State private var renaming: Device?
    @State private var removing: Device?
    @State private var announcing = false
    @State private var toast: String?

    var body: some View {
        Group {
            if let device = model.device(id) {
                content(device)
            } else if model.phase == .loading {
                ProgressView().accessibilityLabel("Loading the device").frame(maxWidth: .infinity, maxHeight: .infinity).bobPage()
            } else if case .failed(let error) = model.phase {
                BobLoadFailure(title: "Couldn't load this device", error: error) { await model.refresh() }
                    .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).bobPage()
            } else {
                ContentUnavailableView {
                    Text("This device isn't here anymore").font(BobFont.heading)
                } description: {
                    Text("It may have been removed, or it's paired to another account.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .bobPage()
            }
        }
        .bobNavTitle(model.device(id)?.name ?? "Device")
        .task { if model.device(id) == nil { await model.refresh(quiet: true) } }
    }

    private func content(_ device: Device) -> some View {
        List {
            Text(DeviceRules.status(device))
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .bobListRow(divider: false)
            notes(device)
            quickActions(device)
            NavigationLink(value: YouRoute.deviceTalkingIn(device.id)) { summary("Talking in", model.talkingIn(device)) }
                .bobListRow()
            NavigationLink(value: YouRoute.deviceStartsIn(device.id)) { summary("New conversations start in", model.startsIn(device)) }
                .bobListRow()
            NavigationLink(value: YouRoute.deviceSound(device.id)) { summary("Sound", DeviceRules.soundSummary(device.settings)) }
                .bobListRow()
            NavigationLink(value: YouRoute.deviceListening(device.id)) { summary("Listening", DeviceRules.listeningSummary(device)) }
                .bobListRow()
            recent(device)
            about(device)
        }
        .bobList()
        .privacySensitive()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Rename") { renaming = device }
                    Button("Remove device", role: .destructive) { removing = device }
                } label: {
                    Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Actions for \(device.name)")
            }
        }
        .task(id: device.id) {
            await model.loadTalkChoices()
            await loadActivity()
        }
        .refreshable {
            await model.refresh(quiet: true)
            await loadActivity()
        }
        // A saved change reads Applying until the device reports it back, so keep looking while it does.
        .task(id: device.pending) {
            while device.pending, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                await model.refresh(quiet: true)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh(quiet: true) } }
        }
        .sheet(item: $renaming) { RenameDeviceSheet(device: $0, model: model).bobSheet() }
        .sheet(isPresented: $announcing) {
            AnnounceSheet(device: device, service: model.service, onSent: { toast = $0 }).bobSheet()
        }
        .deviceRemovalAlert($removing, model: model, onRemoved: onRemoved)
        .bobErrorAlert(model.message) { model.message = nil }
        .alert(toast ?? "", isPresented: Binding(get: { toast != nil }, set: { if !$0 { toast = nil } })) {
            Button("OK", role: .cancel) { toast = nil }
        }
    }

    @ViewBuilder private func notes(_ device: Device) -> some View {
        if !device.settingsSupported {
            note("Update \(device.name) to change settings from here.")
        } else {
            if device.pending { note("Applying…") }
            if !DeviceRules.isOnline(device) { note("Changes apply when \(device.name) is back online.") }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
    }

    private func summary(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(BobFont.rowTitle)
            Text(detail).font(BobFont.subline).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func quickActions(_ device: Device) -> some View {
        let locked = !device.settingsSupported || model.saving != nil
        settingToggle("Do not disturb", isOn: device.settings.dnd, disabled: locked) { change(device, .dnd($0)) }
        settingToggle("Mute", isOn: device.settings.muted, disabled: locked) { change(device, .muted($0)) }
        let blocked = DeviceRules.testBlockedReason(device)
        actionRow("Test speaker", detail: blocked, disabled: blocked != nil) {
            Task { await sendSpeakerTest(device) }
        }
        let online = DeviceRules.isOnline(device)
        actionRow("Announce", detail: online ? nil : "\(device.name) is offline", disabled: !online, showsMore: true) {
            announcing = true
        }
    }

    private func settingToggle(_ title: String, isOn: Bool, disabled: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(title, isOn: Binding(get: { isOn }, set: set))
            .toggleStyle(BobToggleStyle())
            .disabled(disabled)
            .bobListRow()
    }

    private func change(_ device: Device, _ change: DeviceSettingChange) {
        Task { await model.change(device, change) }
    }

    private func actionRow(_ title: String, detail: String?, disabled: Bool, showsMore: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(BobFont.rowTitle).foregroundStyle(.primary)
                    if let detail {
                        Text(detail).font(BobFont.subline).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if showsMore {
                    Image(systemName: "chevron.right").font(.footnote).foregroundStyle(.secondary).accessibilityHidden(true)
                }
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
        .bobListRow()
    }

    private func sendSpeakerTest(_ device: Device) async {
        do {
            let status = try await model.service.announce(deviceID: device.id, title: "Speaker test", body: nil, ring: true)
            toast = DeviceRules.announceOutcome(status, name: device.name)
        } catch ApiError.noDevice {
            toast = "\(device.name) is offline."
        } catch where isCancelled(error) {
            return
        } catch {
            toast = "Couldn't reach \(device.name). Try again."
        }
    }

    @ViewBuilder private func recent(_ device: Device) -> some View {
        BobGroupHeader(title: "Recent")
        if let activity {
            if activity.isEmpty {
                note("Nothing yet. What you say to \(device.name) shows up here.")
            }
            ForEach(Array(activity.enumerated()), id: \.offset) { _, item in activityRow(item) }
            if activity.contains(where: { if case .timer = $0 { true } else { false } }) {
                note("A timer rings on every device on your account.")
            }
        } else if activityFailed {
            Button("Couldn't load recent activity. Try again") { Task { await loadActivity() } }
                .font(BobFont.subline)
                .foregroundStyle(BobColor.dangerText)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                .buttonStyle(BobPressStyle())
                .bobListRow(divider: false)
        } else {
            ProgressView().accessibilityLabel("Loading recent activity").frame(maxWidth: .infinity, minHeight: 44).bobListRow(divider: false)
        }
    }

    @ViewBuilder private func activityRow(_ item: DeviceActivityItem) -> some View {
        switch item {
        case .timer(let at, let label, let dismissed):
            activityText("Timer: \(label ?? "untitled"), \(dismissed ? "dismissed" : "rang")", at: at, detail: nil)
                .accessibilityElement(children: .combine)
                .bobListRow()
        case .turn(let at, let title, let heard, let conversationID):
            let line = heard.isEmpty ? title : "“\(heard)”"
            if let conversationID {
                Button { openChat(conversationID) } label: {
                    activityText(line, at: at, detail: title)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .accessibilityHint("Opens the conversation")
                .bobListRow()
            } else {
                activityText(line, at: at, detail: title)
                    .accessibilityElement(children: .combine)
                    .bobListRow()
            }
        }
    }

    private func activityText(_ line: String, at: Date, detail: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(line).font(BobFont.rowTitle).foregroundStyle(.primary)
            HStack(spacing: 0) {
                if let detail { Text("\(detail) · ") }
                Text(at, format: .relative(presentation: .named))
            }
            .font(BobFont.subline)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func about(_ device: Device) -> some View {
        let product = DeviceRules.product(device.model)
        BobGroupHeader(title: "About")
        BobFactRow(title: "Model", value: product.hardware.map { "\(product.name) · \($0)" } ?? product.name)
        BobFactRow(title: "Firmware", value: device.live.firmware ?? "Unknown")
        BobFactRow(title: "Paired", value: device.pairedAt.formatted(date: .abbreviated, time: .omitted))
        BobFactRow(title: "Battery", value: DeviceRules.battery(device.live))
    }

    private func loadActivity() async {
        activityFailed = false
        do {
            activity = try await model.service.activity(deviceID: id)
        } catch where isCancelled(error) {
            return
        } catch {
            // A failed reload keeps what's on screen.
            activityFailed = activity == nil
        }
    }
}

private struct AnnounceSheet: View {
    let device: Device
    let service: DevicesService
    let onSent: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var title = ""
    @State private var message = ""
    @State private var sending = false
    @State private var notice: String?

    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Shows as a card on its screen.").font(BobFont.subline).foregroundStyle(.secondary)
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "Title") {
                        TextField("Title", text: Binding(get: { title }, set: { title = String($0.prefix(DeviceRules.announceTitleLimit)) }))
                            .focused($focused)
                    }
                    BobField(label: "Message, optional") {
                        TextField("Message, optional", text: Binding(get: { message }, set: { message = String($0.prefix(DeviceRules.announceBodyLimit)) }), axis: .vertical)
                            .lineLimit(2...6)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .bobPage()
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    Text("Announce on \(device.name)").font(BobFont.caption).accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView().accessibilityLabel("Sending")
                    } else {
                        Button("Announce", action: send).disabled(trimmedTitle.isEmpty)
                    }
                }
            }
        }
        .task { focused = true }
    }

    private func send() {
        sending = true
        notice = nil
        let body = message.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { sending = false }
            do {
                let status = try await service.announce(deviceID: device.id, title: trimmedTitle, body: body.isEmpty ? nil : body, ring: false)
                onSent(DeviceRules.announceOutcome(status, name: device.name))
                dismiss()
            } catch ApiError.noDevice {
                notice = "\(device.name) is offline."
            } catch where isCancelled(error) {
                return
            } catch {
                notice = "Couldn't reach \(device.name). Try again."
            }
        }
    }
}

// Volume, ring sound and ring length.
struct DeviceSoundView: View {
    let id: String
    let model: DevicesModel

    @State private var volume: Double?
    @State private var settle: Task<Void, Never>?

    var body: some View {
        List {
            if let device = model.device(id) {
                let locked = !device.settingsSupported || model.saving != nil
                let ringLocked = locked || !device.ringSettingsSupported
                let ringNote = device.ringSettingsSupported ? nil : "Needs a firmware update"
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Volume").font(BobFont.rowTitle)
                        Spacer()
                        Text(device.settings.muted ? "Muted" : String(Int(volume ?? Double(device.settings.volume))))
                            .font(BobFont.subline)
                            .foregroundStyle(.secondary)
                    }
                    Slider(value: volumeBinding(device), in: 0...10, step: 1)
                        .disabled(!device.settingsSupported)
                        .accessibilityLabel("Volume")
                        .accessibilityValue(device.settings.muted ? "Muted" : String(Int(volume ?? Double(device.settings.volume))))
                }
                .padding(.vertical, 4)
                .bobListRow()
                BobMenuRow(title: "Ring sound", note: ringNote, options: RingSound.allCases, label: \.title, selection: device.settings.ringSound, disabled: ringLocked) { sound in
                    Task { await model.change(device, .ringSound(sound)) }
                }
                BobMenuRow(title: "Timer ring length", note: ringNote ?? "How long a timer or alarm rings.", options: DeviceRules.ringOptions(current: device.settings.ringSeconds), label: DeviceRules.ringLabel, selection: device.settings.ringSeconds, disabled: ringLocked) { seconds in
                    Task { await model.change(device, .ringSeconds(seconds)) }
                }
            }
        }
        .bobList()
        .bobNavTitle("Sound")
        .bobErrorAlert(model.message) { model.message = nil }
    }

    // Saves once, after the slider has settled, and shows where the person put it until then. VoiceOver's steps go through here too.
    private func volumeBinding(_ device: Device) -> Binding<Double> {
        Binding(
            get: { volume ?? Double(device.settings.volume) },
            set: { value in
                volume = value
                settle?.cancel()
                settle = Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    guard !Task.isCancelled else { return }
                    if Int(value) != device.settings.volume { await model.change(device, .volume(Int(value))) }
                    if volume == value { volume = nil }
                }
            }
        )
    }
}

// How the device starts listening.
struct DeviceListeningView: View {
    let id: String
    let model: DevicesModel

    var body: some View {
        List {
            if let device = model.device(id) {
                let locked = !device.settingsSupported || model.saving != nil
                BobMenuRow(title: "Listening mode", note: "How \(device.name) starts listening.", options: DeviceMode.allCases, label: \.title, selection: device.settings.mode, disabled: locked) { mode in
                    Task { await model.change(device, .mode(mode)) }
                }
                if device.settings.mode == .wake, device.wakeWordSupported {
                    BobMenuRow(title: "Wake word", note: "What you say to wake \(device.name).", options: WakeWord.allCases, label: \.title, selection: device.settings.wakeWord, disabled: locked) { word in
                        Task { await model.change(device, .wakeWord(word)) }
                    }
                }
            }
        }
        .bobList()
        .bobNavTitle("Listening")
        .bobErrorAlert(model.message) { model.message = nil }
    }
}

// What a device talks in: the current conversation can be opened, and anything else chosen.
struct DeviceTalkingInView: View {
    let id: String
    let model: DevicesModel
    var openChat: (String) -> Void = { _ in }
    var openThread: (String, String) -> Void = { _, _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        List {
            if let device = model.device(id) {
                content(device)
            }
        }
        .bobList()
        .privacySensitive()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search conversations")
        .bobNavTitle("Talking in")
        .refreshable { await model.loadTalkChoices() }
        .task { await model.loadTalkChoices() }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    @ViewBuilder private func content(_ device: Device) -> some View {
        if let current = currentOption(device) {
            row("Open \(current.title)", detail: "What \(device.name) is talking in") {
                if let threadID = current.threadID, let spaceID = current.spaceID {
                    openThread(threadID, spaceID)
                } else {
                    openChat(current.ref)
                }
            }
        }
        row("New conversation", detail: "Starts in \(model.startsIn(device)) on the next turn", isCurrent: device.activeConversationID == nil) {
            choose(device, .newConversation(spaceID: device.activeSpaceID))
        }
        switch model.talkPhase {
        case .loading:
            ProgressView()
                .accessibilityLabel("Loading conversations")
                .frame(maxWidth: .infinity, minHeight: 88)
                .bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load conversations", error: error) { await model.loadTalkChoices() }
                .bobListRow(divider: false)
        case .loaded:
            let shared = model.talkChoices?.spaces.filter(SpaceRules.isShared) ?? []
            if !shared.isEmpty {
                Menu {
                    ForEach(shared) { space in
                        Button(space.name) {
                            Task {
                                await model.startThread(device, in: space)
                                dismiss()
                            }
                        }
                    }
                } label: {
                    Text("New in a space")
                        .font(BobFont.rowTitle)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .disabled(model.savingPointer)
                .bobListRow()
            }
            BobGroupHeader(title: "Recent")
            let options = DeviceTalkRules.matching(model.talkChoices?.options ?? [], query: query)
            if options.isEmpty {
                Text("Nothing matches.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            }
            ForEach(options) { option in
                row(option.title, detail: option.place, isCurrent: option.ref == device.activeConversationID) {
                    choose(device, option.target(defaultSpace: device.activeSpaceID))
                }
            }
        }
    }

    private func currentOption(_ device: Device) -> DeviceTalkOption? {
        model.talkChoices?.options.first { $0.ref == device.activeConversationID }
    }

    private func choose(_ device: Device, _ target: DeviceTalkTarget) {
        Task {
            await model.setTalkingIn(device, target: target)
            if model.message == nil { dismiss() }
        }
    }

    private func row(_ title: String, detail: String, isCurrent: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(BobFont.rowTitle).foregroundStyle(.primary)
                    Text(detail).font(BobFont.subline).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                Spacer(minLength: 8)
                if isCurrent {
                    Image(systemName: "checkmark").foregroundStyle(BobColor.accent).accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .disabled(model.savingPointer)
        .accessibilityValue(isCurrent ? "Current" : "")
        .bobListRow()
    }
}

// Where a device's next new conversation starts.
struct DeviceStartsInView: View {
    let id: String
    let model: DevicesModel

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if let device = model.device(id) {
                row("General", isCurrent: device.activeSpaceID == nil) { pick(device, nil) }
                ForEach(model.talkChoices?.spaces.filter(SpaceRules.isShared) ?? []) { space in
                    row(space.name, isCurrent: device.activeSpaceID == space.id) { pick(device, space.id) }
                }
            }
        }
        .bobList()
        .bobNavTitle("New conversations start in")
        .task { await model.loadTalkChoices() }
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private func pick(_ device: Device, _ spaceID: String?) {
        Task {
            await model.setStartsIn(device, spaceID: spaceID)
            if model.message == nil { dismiss() }
        }
    }

    private func row(_ title: String, isCurrent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(BobFont.rowTitle).foregroundStyle(.primary)
                Spacer(minLength: 8)
                if isCurrent {
                    Image(systemName: "checkmark").foregroundStyle(BobColor.accent).accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .disabled(model.savingPointer)
        .accessibilityValue(isCurrent ? "Current" : "")
        .bobListRow()
    }
}
