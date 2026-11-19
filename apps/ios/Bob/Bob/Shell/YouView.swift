import BobKit
import SwiftUI

// How the You tab reaches the other tabs and the chat.
struct YouRouting {
    var openTarget: (NotificationTarget, String?) -> Void = { _, _ in }
    var openMemory: () -> Void = {}
    var openChat: (String) -> Void = { _ in }
    var openDestination: (ProductivityRoute) -> Void = { _ in }
}

// The You tab: who is signed in, and a short list of rows that drill in.
struct YouView: View {
    @Bindable var store: AccountStore
    var routing = YouRouting()
    var productivity: ProductivityStore?
    var chat = ChatRouting()

    @State private var administrativeAccess = AdminServices.access()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(ShellStore.self) private var shell

    var body: some View {
        NavigationStack(path: $store.path) {
            List {
                profileRow
                Section {
                    YouLink(title: "Appearance", detail: "System, light or dark", route: .appearance)
                    notificationsRow
                    YouLink(title: "Notification settings", detail: "Choose what reaches you", route: .notificationSettings)
                    YouLink(title: "Siri and Shortcuts", route: .siri)
                } header: {
                    BobSectionTitle("Your preferences")
                }
                Section {
                    featureRow("Memory", detail: "What Bob remembers about you", icon: "brain", route: .memory)
                    featureRow("My Apps", detail: "Useful little spaces", icon: "square.grid.2x2", route: .apps(spaceID: nil, canManage: true))
                    featureRow("Routines", detail: "Recaps on your schedule", icon: "repeat", route: .routines)
                    featureRow("Insights", detail: "A little perspective", icon: "sparkles", route: .insights)
                } header: {
                    BobSectionTitle("With Bob")
                }
                Section {
                    YouLink(title: "Devices", detail: store.devices.summary, route: .devices)
                    featureRow("Integrations", detail: "Your connected accounts", icon: "link", route: .integrations)
                    featureRow("Tools", detail: "Choose what Bob can help with", icon: "slider.horizontal.3", route: .tools)
                } header: {
                    BobSectionTitle("Connections")
                }
                Section {
                    YouLink(title: "Usage", route: .usage)
                    YouLink(title: "Your data", route: .yourData)
                } header: {
                    BobSectionTitle("Your account")
                }
                if administrativeAccess.admin || administrativeAccess.metrics || administrativeAccess.error != nil {
                    Section {
                        if administrativeAccess.admin { YouLink(title: "Administration", route: .administration) }
                        if administrativeAccess.metrics { YouLink(title: "Metrics", route: .operatorMetrics) }
                        if administrativeAccess.error != nil {
                            Button("Retry account access check") { Task { await administrativeAccess.refresh() } }
                                .font(BobFont.subline).bobListRow()
                        }
                    } header: {
                    BobSectionTitle("Administration")
                }
                }
                if store.account.hasSession {
                    Button("Sign out", role: .destructive) {
                        Task { await AppSession.gate.signOut() }
                    }
                    .font(BobFont.rowTitle)
                    .foregroundStyle(BobColor.dangerText)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .buttonStyle(BobPressStyle())
                    .padding(.top, 12)
                    .bobListRow(divider: false)
                }
                #if DEBUG
                Button("Design catalog") { shell.present(.designCatalog) }
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .buttonStyle(BobPressStyle())
                    .bobListRow(divider: false)
                #endif
            }
            .bobList()
            .bobNavTitle("You")
            .toolbar {
                if store.path.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        BobNotificationsButton(model: store.notifications) {
                            store.path.append(YouRoute.notifications)
                        }
                    }
                }
            }
            .task { await store.account.loadProfile() }
            .task { await administrativeAccess.refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await administrativeAccess.refresh() } }
            }
            .task { await store.devices.refresh(quiet: true) }
            .navigationDestination(for: YouRoute.self) { destination($0) }
            .navigationDestination(for: ProductivityRoute.self) { route in
                if let productivity { ProductivityDestinationView(route: route, store: productivity, chat: chat) }
            }
        }
        .tint(BobColor.accent)
        .onAppear { productivity?.path = store.path }
        .onChange(of: store.path) { _, path in
            if productivity?.path != path { productivity?.path = path }
        }
        .onChange(of: productivity?.path) { _, path in
            if let path, store.path != path { store.path = path }
        }
    }

    private var identity: String? {
        guard let profile = store.account.profile else { return nil }
        return profile.name ?? profile.email
    }

    private var profileRow: some View {
        NavigationLink(value: YouRoute.profile) {
            HStack(spacing: 14) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(BobColor.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(identity ?? "Your profile").font(.title3.weight(.semibold))
                    if let email = store.account.profile?.email, email != identity {
                        Text(email).font(BobFont.subline).foregroundStyle(.secondary)
                    } else {
                        Text("Personal details and time zone").font(BobFont.subline).foregroundStyle(.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 14)
        }
        .bobListRow(divider: false)
        .accessibilityHint("Edit your profile")
    }

    private func featureRow(_ title: String, detail: String, icon: String, route: ProductivityRoute) -> some View {
        Button { routing.openDestination(route) } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).frame(width: 26).foregroundStyle(.secondary).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(BobFont.rowTitle)
                    Text(detail).font(BobFont.subline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary).accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .bobListRow()
    }

    private var notificationsRow: some View {
        let unread = store.notifications.unread
        return NavigationLink(value: YouRoute.notifications) {
            HStack(spacing: 8) {
                Text("Notifications").font(BobFont.rowTitle)
                Spacer(minLength: 8)
                if unread > 0 {
                    Text(NotificationRules.unreadLabel(unread))
                        .font(BobFont.caption)
                        .foregroundStyle(BobColor.accent)
                }
            }
            .padding(.vertical, 4)
        }
        .accessibilityLabel("Notifications")
        .accessibilityValue(unread > 0 ? "\(unread) unread" : "")
        .bobListRow()
    }

    @ViewBuilder private func destination(_ route: YouRoute) -> some View {
        switch route {
        case .administration: AdminView()
        case .operatorMetrics: OperatorMetricsView()
        case .profile: ProfileView(model: store.account)
        case .timeZone: TimeZonePickerView(model: store.account)
        case .usage: UsageView(service: store.account.service, openMemory: routing.openMemory)
        case .notifications: NotificationsView(model: store.notifications, zone: store.account.zone, open: { open($0, spaceID: $1) })
        case .notificationSettings: NotificationSettingsView(service: store.notifications.service)
        case .appearance: AppearanceView()
        case .siri: SiriShortcutsView()
        case .yourData: YourDataView(model: store.account)
        case .deleteAccount: DeleteAccountView(model: store.account)
        case .devices: DevicesView(model: store.devices)
        case .device(let id): DeviceDetailView(id: id, model: store.devices, openChat: routing.openChat, onRemoved: { popDeviceDetail() })
        case .deviceSound(let id): DeviceSoundView(id: id, model: store.devices)
        case .deviceListening(let id): DeviceListeningView(id: id, model: store.devices)
        case .deviceTalkingIn(let id):
            DeviceTalkingInView(id: id, model: store.devices, openChat: routing.openChat, openThread: { thread, space in
                routing.openTarget(.thread(id: thread, spaceID: space), space)
            })
        case .deviceStartsIn(let id): DeviceStartsInView(id: id, model: store.devices)
        }
    }

    // A device opens right here in this tab; everything else lives on another tab.
    private func open(_ target: NotificationTarget, spaceID: String?) {
        switch target {
        case .device(let id):
            store.path.append(YouRoute.device(id))
        case .devices:
            store.path.append(YouRoute.devices)
        default:
            routing.openTarget(target, spaceID)
        }
    }

    private func popDeviceDetail() {
        if !store.path.isEmpty { store.path.removeLast() }
    }
}

// How the app looks.
struct AppearanceView: View {
    @State private var appearance = BobAppearanceStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                modePicker
                Button("Use Bob’s look") {
                    let mode = appearance.value.mode
                    appearance.value = .standard
                    appearance.value.mode = mode
                }
                .buttonStyle(BobPrimaryButtonStyle())
                choices("Where Bob lives", BobAppearance.BobPlace.allCases, title: \.title, selection: $appearance.value.bobPlace)
                choices("Colour", BobAppearance.Palette.allCases, title: \.title, selection: $appearance.value.palette)
                choices("Font", BobAppearance.Typeface.allCases, title: \.title, selection: $appearance.value.typeface)
            }
            .padding(.horizontal, BobLayout.pageMargin)
            .padding(.top, 16)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .bobPage()
        .bobNavTitle("Appearance")
    }

    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Appearance").font(BobFont.caption).accessibilityAddTraits(.isHeader)
            Picker("Appearance", selection: $appearance.value.mode) {
                ForEach(BobAppearance.Mode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .bobChoicePicker()
            Text(appearance.value.mode == .system ? "Matches your iPhone's appearance." : "Always uses \(appearance.value.mode.title.lowercased()) appearance.")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
            HStack(spacing: 14) {
                BobFaceBadge(size: 44)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Make yourself at home.").font(BobFont.rowTitle)
                    Text("A little more you. Still Bob.").font(BobFont.subline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(BobColor.wash, in: RoundedRectangle(cornerRadius: BobLayout.controlRadius))
        }
    }

    private func choices<Option: Identifiable & Equatable>(_ heading: String, _ options: [Option], title: KeyPath<Option, String>, selection: Binding<Option>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(heading).font(BobFont.caption).accessibilityAddTraits(.isHeader)
            ForEach(options) { option in
                Button {
                    selection.wrappedValue = option
                } label: {
                    HStack {
                        Text(option[keyPath: title])
                        Spacer()
                        if selection.wrappedValue == option {
                            Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(BobColor.accent)
                        }
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .accessibilityAddTraits(selection.wrappedValue == option ? .isSelected : [])
                BobDivider()
            }
        }
    }
}
