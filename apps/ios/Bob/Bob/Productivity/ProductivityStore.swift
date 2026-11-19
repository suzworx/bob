import BobKit
import Foundation
import Observation
import SwiftUI

enum ProductivityRoute: Hashable {
    case search, tasks, notes, reminders, memory, suggestions, insights, timeline, tools, integrations, routines
    case apps(spaceID: String?, canManage: Bool)
    case task(String)
    case note(String)
    case noteHistory(String)
    case noteRevision(NoteRevision)
    case deletedTasks, trashedNotes
    case spaces, archivedSpaces, groupChats
    case space(String)
    case threads(spaceID: String)
    case thread(id: String, spaceID: String)
    case members(spaceID: String)
    case groupChat(id: String)
}

// A reversible change just made, offered back for a few seconds.
struct UndoOffer: Identifiable {
    let id = UUID()
    let message: String
    let action: @MainActor () async -> Void
}

// A tab's navigation and shared account data; owned by the shell and discarded on sign-out.
@MainActor @Observable final class ProductivityStore {
    var path = NavigationPath()
    let tasks: TasksModel
    let notes: NotesModel
    let reminders: RemindersModel
    let calendar: CalendarModel
    let memory: MemoryModel
    let search: SearchModel
    let scope: ScopeModel
    let spaces: SpacesModel
    let chats: GroupChatsModel
    let shared: SharedServices

    init(services: ProductivityServices) {
        scope = ScopeModel(source: services.scope)
        shared = services.shared
        spaces = SpacesModel(service: services.shared.spaces, groupChats: services.shared.groupChats)
        chats = GroupChatsModel(service: services.shared.groupChats)
        tasks = TasksModel(service: services.tasks, scope: scope)
        notes = NotesModel(service: services.notes, scope: scope)
        reminders = RemindersModel(service: services.reminders, scope: scope)
        calendar = CalendarModel(service: services.calendar, tasks: tasks, reminders: reminders)
        memory = MemoryModel(service: services.memory)
        search = SearchModel(service: services.search)
    }

    // Each tab owns its route stack while reading the same account data models.
    init(sharing store: ProductivityStore) {
        tasks = store.tasks
        notes = store.notes
        reminders = store.reminders
        calendar = store.calendar
        memory = store.memory
        search = store.search
        scope = store.scope
        spaces = store.spaces
        chats = store.chats
        shared = store.shared
    }

    // Tasks, notes and reminders follow the space the person chose. Everything from the old one goes at once.
    func switchSpace(to spaceID: String) async {
        guard scope.currentID != spaceID else { return }
        tasks.forgetSpace()
        notes.forgetSpace()
        reminders.forgetSpace()
        await scope.select(spaceID)
        await scope.load()
    }

    // Opens one of a space's lists from that space.
    func openList(_ route: ProductivityRoute, in spaceID: String) {
        Task {
            await switchSpace(to: spaceID)
            path.append(route)
        }
    }

    // Opens a found or notified item: the detail screens look it up in the list, so the list is read first.
    func openItem(_ route: ProductivityRoute, in spaceID: String?) {
        Task {
            if let spaceID { await switchSpace(to: spaceID) }
            switch route {
            case .task: await tasks.refresh()
            case .note: await notes.refresh()
            default: break
            }
            path.append(route)
        }
    }
}

enum LoadPhase: Equatable {
    case loading, loaded, failed(ApiError)
}
