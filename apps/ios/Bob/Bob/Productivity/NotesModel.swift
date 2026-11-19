import BobKit
import Foundation
import Observation

// Notes and their trash live in one array, as on the web, and search results sit beside them.
@MainActor @Observable final class NotesModel {
    private(set) var phase: LoadPhase = .loading
    private(set) var all: [Note] = []
    private(set) var results: [Note]?
    private(set) var searchFailed = false
    var query = ""
    var message: String?
    var undo: UndoOffer?

    private var detailTargets: [String: Note] = [:]
    private var targetGeneration = 0

    let service: NotesService
    let scope: ScopeModel?

    init(service: NotesService, scope: ScopeModel? = nil) {
        self.service = service
        self.scope = scope
    }

    func forgetSpace() {
        targetGeneration += 1
        detailTargets = [:]
        all = []
        results = nil
        query = ""
        phase = .loading
    }

    var groups: [ProductivityGroup<Note>] { NoteRules.groups(all) }
    var trashed: [Note] { NoteRules.trashed(all) }

    func note(id: String) -> Note? {
        let listed = all.first { $0.id == id } ?? results?.first { $0.id == id }
        guard let resolved = detailTargets[id] else { return listed }
        return (listed?.revision ?? -1) > resolved.revision ? listed : resolved
    }

    // Keep directly resolved targets even when a later list page doesn't include them.
    func loadTarget(id: String) async throws {
        let generation = targetGeneration
        let spaceGeneration = scope?.generation
        let spaceID = scope?.currentID
        let found = try await service.note(id: id)
        try Task.checkCancellation()
        guard generation == targetGeneration, spaceGeneration == scope?.generation else { throw CancellationError() }
        guard found.id == id else { throw ApiError.invalidRequest }
        if let spaceID, found.spaceID != spaceID { throw ApiError.forbidden }
        guard found.trashedAt == nil else { throw ApiError.notFound }
        let current = note(id: id)
        detailTargets[id] = (current?.revision ?? -1) > found.revision ? current : found
    }

    func refresh() async {
        let generation = scope?.generation
        do {
            let found = try await service.notes()
            guard generation == scope?.generation else { return }
            all = found
            phase = .loaded
        } catch where isCancelled(error) {
            return
        } catch {
            if all.isEmpty {
                phase = .failed(apiError(error))
            } else {
                message = productivityMessage(error)
            }
        }
    }

    // Called a moment after the last key; an empty query brings the whole list back.
    func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            results = nil
            searchFailed = false
            return
        }
        do {
            let found = try await service.search(query: text)
            guard !Task.isCancelled else { return }
            results = found
            searchFailed = false
        } catch where isCancelled(error) {
            return
        } catch {
            results = nil
            searchFailed = true
        }
    }

    func create(title: String, body: String) async throws {
        upsert(try await service.create(title: title, body: body))
    }

    // Throws so the editor keeps its text; on a conflict the latest version is fetched for it.
    func save(id: String, revision: Int, title: String, body: String) async throws {
        upsert(try await service.update(id: id, revision: revision, title: title, body: body))
    }

    func latest(id: String) async -> Note? {
        do { try await loadTarget(id: id); return note(id: id) }
        catch { return nil }
    }

    func togglePin(_ note: Note) async {
        do {
            upsert(try await service.setPinned(id: note.id, pinned: !note.pinned))
        } catch {
            message = productivityMessage(error)
        }
    }

    func trash(_ note: Note) async {
        do {
            try await service.delete(id: note.id)
            var gone = note
            gone.trashedAt = Date()
            upsert(gone)
            results?.removeAll { $0.id == note.id }
            undo = UndoOffer(message: "Moved \(note.title) to trash") { [weak self] in
                await self?.restore(note)
            }
        } catch {
            message = productivityMessage(error)
        }
    }

    func restore(_ note: Note) async {
        do {
            upsert(try await service.restore(id: note.id))
        } catch {
            message = productivityMessage(error)
        }
    }

    private func upsert(_ note: Note) {
        if detailTargets[note.id] != nil { detailTargets[note.id] = note }
        if let index = all.firstIndex(where: { $0.id == note.id }) {
            all[index] = note
        } else {
            all.insert(note, at: 0)
        }
        if let index = results?.firstIndex(where: { $0.id == note.id }) {
            results?[index] = note
        }
    }
}
