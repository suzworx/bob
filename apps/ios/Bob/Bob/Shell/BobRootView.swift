import BobKit
import SwiftUI

// The companion entry uses the shell's real private conversation and its saved draft.
struct BobRootView: View {
    @Bindable var productivity: ProductivityStore
    var routing = ChatRouting()
    let chat: ChatViewModel
    let chats: ConversationListModel
    let notifications: NotificationsModel
    let onVoice: () -> Void
    let onChat: () -> Void
    let onNotifications: () -> Void
    let onDestination: (ProductivityRoute) -> Void
    let onDevices: () -> Void

    @State private var choosingConversation = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        NavigationStack(path: $productivity.path) {
            ScrollView {
                VStack(spacing: 28) {
                    introduction
                    actions
                    shortcuts
                }
                .padding(.horizontal, BobLayout.pageMargin)
                .padding(.vertical, 24)
                .frame(maxWidth: 600)
                .frame(maxWidth: .infinity)
            }
            .bobPage()
            .bobNavTitle("Bob")
            .privacySensitive()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    BobNotificationsButton(model: notifications, action: onNotifications)
                }
            }
            .navigationDestination(for: ProductivityRoute.self) { route in
                ProductivityDestinationView(route: route, store: productivity, chat: routing)
            }
            .navigationDestination(isPresented: $choosingConversation) {
                ConversationListView(model: chats, chat: chat, onOpen: { id in
                    chat.open(id)
                    choosingConversation = false
                }, onNew: {
                    chat.newChat()
                    choosingConversation = false
                })
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("New chat") {
                            chat.newChat()
                            choosingConversation = false
                        }
                    }
                }
            }
        }
    }

    private var introduction: some View {
        VStack(spacing: 16) {
            Image("BobHelper")
                .resizable()
                .scaledToFit()
                .frame(height: dynamicTypeSize.isAccessibilitySize ? 120 : 180)
                .accessibilityHidden(true)
            Label("Just you and Bob", systemImage: "lock")
                .font(BobFont.subline)
                .foregroundStyle(BobColor.muted)
            Text("A little company?")
                .font(BobFont.greeting)
                .foregroundStyle(BobColor.ink)
                .multilineTextAlignment(.center)
            Text("Talk it out, make a plan, or just say hello.")
                .font(BobFont.body)
                .foregroundStyle(BobColor.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button(action: onVoice) { Label("Talk to Bob", systemImage: "waveform") }
                .buttonStyle(BobPrimaryButtonStyle(expands: true))
                .accessibilityHint("Starts voice in your selected private conversation")
            Button(action: onChat) { Label("Open chat", systemImage: "bubble.left") }
                .buttonStyle(BobSecondaryButtonStyle(expands: true))
            Button { choosingConversation = true } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Conversation").font(BobFont.subline).foregroundStyle(BobColor.muted)
                        Text(chat.transcript.title ?? "New conversation")
                            .font(BobFont.rowTitle).foregroundStyle(BobColor.ink).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").foregroundStyle(BobColor.muted).accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: 60)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityHint("Choose a private conversation without losing its draft")
            if !chat.draft.isEmpty || !chat.attachments.isEmpty {
                Text("Your unfinished message is waiting in this conversation.")
                    .font(BobFont.subline).foregroundStyle(BobColor.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var shortcuts: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Explore").font(BobFont.caption).foregroundStyle(BobColor.muted)
            shortcut("My Apps", symbol: "square.grid.2x2", route: .apps(spaceID: nil, canManage: true))
            shortcut("Routines", symbol: "arrow.2.squarepath", route: .routines)
            shortcut("Memory", symbol: "sparkles", route: .memory)
            shortcut("Integrations", symbol: "link", route: .integrations)
            shortcut("Insights", symbol: "lightbulb", route: .insights)
            shortcut("Timeline", symbol: "clock", route: .timeline)
            shortcut("Tools", symbol: "slider.horizontal.3", route: .tools)
            shortcut("Devices", symbol: "desktopcomputer", action: onDevices)
        }
    }

    private func shortcut(_ title: String, symbol: String, route: ProductivityRoute) -> some View {
        shortcut(title, symbol: symbol, action: { onDestination(route) })
    }

    private func shortcut(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol).frame(width: 24).accessibilityHidden(true)
                Text(title).font(BobFont.rowTitle)
                Spacer()
                Image(systemName: "chevron.right").accessibilityHidden(true)
            }
            .foregroundStyle(BobColor.ink)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
    }
}
