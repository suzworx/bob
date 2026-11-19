import BobKit
import SwiftUI

// One row per paired device, with pairing by the code on its screen.
struct DevicesView: View {
    let model: DevicesModel

    @Environment(\.scenePhase) private var scenePhase
    @State private var pairing = false
    @State private var renaming: Device?
    @State private var removing: Device?

    var body: some View {
        List {
            switch model.phase {
            case .loading:
                ProgressView()
                    .accessibilityLabel("Loading devices")
                    .frame(maxWidth: .infinity, minHeight: 200)
                    .bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Couldn't load your devices", error: error) { await model.refresh() }
                    .bobListRow(divider: false)
            case .loaded:
                if model.devices.isEmpty {
                    ContentUnavailableView {
                        Text("No devices yet").font(BobFont.heading)
                    } description: {
                        Text("Pair a Bob device to talk hands-free.")
                    } actions: {
                        Button("Pair a device") { pairing = true }
                            .buttonStyle(BobSecondaryButtonStyle())
                    }
                    .bobListRow(divider: false)
                } else {
                    ForEach(model.devices) { row($0) }
                }
            }
        }
        .bobList()
        .bobNavTitle("Devices")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { pairing = true } label: {
                    Image(systemName: "plus").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Pair a device")
            }
        }
        .task { await model.refresh(quiet: !model.devices.isEmpty) }
        .refreshable { await model.refresh(quiet: true) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh(quiet: true) } }
        }
        .sheet(isPresented: $pairing) { PairDeviceSheet(model: model).bobSheet() }
        .sheet(item: $renaming) { RenameDeviceSheet(device: $0, model: model).bobSheet() }
        .deviceRemovalAlert($removing, model: model)
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private func row(_ device: Device) -> some View {
        NavigationLink(value: YouRoute.device(device.id)) {
            HStack(spacing: 12) {
                DeviceStatusDot(device: device)
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name).font(BobFont.rowTitle)
                    Text((model.justPaired == device.id ? "Just paired · " : "") + DeviceRules.status(device))
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
        .accessibilityAction(named: "Rename") { renaming = device }
        .accessibilityAction(named: "Remove") { removing = device }
        .bobListRow()
        .swipeActions(edge: .leading) {
            Button("Rename") { renaming = device }
                .tint(BobColor.accent)
        }
        .swipeActions(edge: .trailing) {
            Button("Remove", role: .destructive) { removing = device }
        }
        .contextMenu {
            Button("Rename") { renaming = device }
            Button("Remove device", role: .destructive) { removing = device }
        }
    }
}

struct DeviceStatusDot: View {
    let device: Device

    var body: some View {
        Circle()
            .fill(DeviceRules.isOnline(device) ? BobColor.okText : BobColor.muted)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

extension View {
    // Names the device and what happens to it. A failure says so.
    func deviceRemovalAlert(_ device: Binding<Device?>, model: DevicesModel, onRemoved: @escaping () -> Void = {}) -> some View {
        alert(
            "Remove \(device.wrappedValue?.name ?? "this device")?",
            isPresented: Binding(get: { device.wrappedValue != nil }, set: { if !$0 { device.wrappedValue = nil } }),
            presenting: device.wrappedValue
        ) { target in
            Button("Remove", role: .destructive) {
                Task {
                    do {
                        try await model.remove(target)
                        onRemoved()
                    } catch where isCancelled(error) {
                        return
                    } catch {
                        model.message = "Couldn't remove \(target.name). Try again."
                    }
                }
            }
            Button("Keep it", role: .cancel) {}
        } message: { target in
            Text("\(target.name) stops working until you pair it again.")
        }
    }
}

struct RenameDeviceSheet: View {
    let device: Device
    let model: DevicesModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var draft = ""
    @State private var saving = false
    @State private var notice: String?

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "Device name") {
                        TextField("Device name", text: Binding(get: { draft }, set: { draft = String($0.prefix(DeviceRules.nameLimit)) }))
                            .submitLabel(.done)
                            .focused($focused)
                            .onSubmit { if canSave { save() } }
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
                BobSheetBar(title: "Rename \(device.name)", canSave: canSave, saving: saving, onCancel: { dismiss() }, onSave: save)
            }
        }
        .onAppear { draft = device.name }
        .task { focused = true }
    }

    private var canSave: Bool { !trimmed.isEmpty && trimmed != device.name }

    private func save() {
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                try await model.rename(device, to: trimmed)
                dismiss()
            } catch where isCancelled(error) {
                return
            } catch {
                notice = "Couldn't rename it. Try again."
            }
        }
    }
}

// The code on the device's screen and an optional name. An expired code clears the field: nothing is stuck.
struct PairDeviceSheet: View {
    let model: DevicesModel

    private enum Field { case code, name }

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Field?
    @State private var code = ""
    @State private var name = ""
    @State private var pairing = false
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Find the 8-character code on your device's screen.")
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "Code on the screen") {
                        TextField("K7QX-4TZP", text: Binding(get: { code }, set: { code = PairCode.formatted($0); notice = nil }))
                            .font(BobFont.code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .textContentType(.oneTimeCode)
                            .submitLabel(.next)
                            .focused($focus, equals: .code)
                            .onSubmit { focus = .name }
                            .accessibilityLabel("Code on the screen")
                    }
                    BobField(label: "Name, optional") {
                        TextField("Kitchen", text: Binding(get: { name }, set: { name = String($0.prefix(DeviceRules.nameLimit)) }))
                            .submitLabel(.done)
                            .focused($focus, equals: .name)
                            .onSubmit { if canPair { pair() } }
                            .accessibilityLabel("Name, optional")
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
                    Text("Pair a device").font(BobFont.caption).accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if pairing {
                        ProgressView().accessibilityLabel("Pairing")
                    } else {
                        Button("Pair", action: pair).disabled(!canPair)
                    }
                }
            }
        }
        .task { focus = .code }
    }

    private var canPair: Bool { PairCode.isComplete(code) }

    private func pair() {
        pairing = true
        notice = nil
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { pairing = false }
            do {
                try await model.pair(code: code, name: trimmed.isEmpty ? nil : trimmed)
                dismiss()
            } catch ApiError.notFound {
                code = ""
                focus = .code
                notice = "That code expired. Enter the new one on the screen."
            } catch ApiError.invalidRequest {
                notice = "Enter the 8-character code shown on the device."
            } catch ApiError.rateLimited(let seconds) {
                notice = "Too many attempts. Try again in \(PairCode.retryLabel(seconds: seconds ?? 900))."
            } catch where isCancelled(error) {
                return
            } catch {
                notice = "Couldn't pair right now. Try again."
            }
        }
    }
}
