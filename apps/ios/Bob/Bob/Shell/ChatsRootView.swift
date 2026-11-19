import BobKit
import SwiftUI

// Private history and group chats share one stable Chats stack.
struct ChatsRootView: View {
    let model: ConversationListModel
    let chat: ChatViewModel
    @Bindable var productivity: ProductivityStore
    var routing = ChatRouting()
    let notifications: NotificationsModel
    let onOpen: (String) -> Void
    let onNew: () -> Void
    let onNotifications: () -> Void

    var body: some View {
        NavigationStack(path: $productivity.path) {
            ConversationListView(
                model: model, chat: chat, onOpen: onOpen, onNew: onNew,
                onShared: { productivity.path.append(ProductivityRoute.groupChats) },
                onGlobalSearch: { productivity.path.append(ProductivityRoute.search) }
            )
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        BobNotificationsButton(model: notifications, action: onNotifications)
                    }
                }
                .navigationDestination(for: ProductivityRoute.self) { route in
                    ProductivityDestinationView(route: route, store: productivity, chat: routing)
                }
        }
    }
}
