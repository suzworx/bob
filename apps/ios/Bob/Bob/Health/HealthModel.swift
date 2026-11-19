import BobKit
import HealthKit
import Observation

@MainActor @Observable final class HealthModel {
    var rows: [HealthSummary] = []
    var selected: Set<String> = []
    var days = 7
    var busy = false
    var accessRequested = false
    var clinicalRequested = false
    var error: String?
    var progress = 0
    private(set) var readWindow: HealthReadWindow?
    private var generation = 0
    private let reader = HealthReader()
    let available = HKHealthStore.isHealthDataAvailable()
    var supportsClinical: Bool { reader.store.supportsHealthRecords() }
    var perObjectTypes: [HKObjectType] { HealthTypeCatalog.allReadTypes.filter { $0.requiresPerObjectAuthorization() }.sorted { $0.identifier < $1.identifier } }
    var period: String { days == 1 ? "Today" : "Last \(days) calendar days" }
    var draft: String? {
        guard let readWindow else { return nil }
        return HealthShareDraft.make(rows: rows, selected: selected, window: readWindow)
    }

    func connect() async {
        guard available, !busy else { return }
        busy = true
        error = nil
        let attempt = generation
        do {
            try await reader.requestAccess()
            guard attempt == generation else { return }
            accessRequested = true
            busy = false
            await refresh()
        } catch {
            guard attempt == generation else { return }
            busy = false
            self.error = "Apple Health couldn't open access. Please try again on an unlocked iPhone, or review Bob's access in the Health app."
        }
    }

    func refresh() async {
        guard accessRequested, !busy else { return }
        busy = true
        error = nil
        rows = []; selected = []; progress = 0
        generation += 1
        let attempt = generation
        let window = HealthReadWindow(days: days, now: .now)
        readWindow = window
        for type in HealthTypeCatalog.samples + (clinicalRequested ? HealthTypeCatalog.clinical : []) {
            guard attempt == generation, !Task.isCancelled else { return }
            let summary = await reader.read(type, window: window)
            guard attempt == generation, !Task.isCancelled else { return }
            rows.append(summary)
            progress += 1
        }
        let activity = await reader.activity(window: window)
        guard attempt == generation, !Task.isCancelled else { return }
        rows.append(activity)
        rows += HealthCharacteristics.read(store: reader.store)
        if #available(iOS 26.0, *) {
            let medications = await HealthMedicationReader.read(store: reader.store)
            guard attempt == generation, !Task.isCancelled else { return }
            rows.append(medications)
        }
        rows.sort { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        busy = false
    }

    func connectClinical() async {
        guard supportsClinical, !busy else { return }
        if await authorize({ try await self.reader.requestClinicalAccess() }) {
            clinicalRequested = true
            await refresh()
        }
    }

    func chooseRecords(_ type: HKObjectType) async {
        guard !busy else { return }
        if await authorize({ try await self.reader.requestRecordAccess(type) }) { await refresh() }
    }

    func chooseVerifiable(_ credential: HKVerifiableClinicalRecordCredentialType, title: String) async {
        guard available, !busy else { return }
        busy = true
        error = nil
        let attempt = generation
        do {
            let query = HKVerifiableClinicalRecordQueryDescriptor(recordTypes: [credential], sourceTypes: [.smartHealthCard, .euDigitalCOVIDCertificate])
            let records = try await query.result(for: reader.store)
            guard attempt == generation else { return }
            if readWindow == nil { readWindow = HealthReadWindow(days: days, now: .now) }
            let id = "verifiable-" + credential.rawValue
            let latest = records.map(\.startDate).max()?.formatted(date: .abbreviated, time: .omitted)
            let detail = latest.map { "\(records.count) selected verifiable records · latest \($0) · one-time selection, independent of selected period. Certificate payloads stay in Health." } ?? "No records selected or readable."
            rows.removeAll { $0.id == id }
            selected.remove(id)
            rows.append(HealthSummary(id: id, title: title, detail: detail, hasData: !records.isEmpty))
        } catch {
            guard attempt == generation else { return }
            self.error = "Couldn't open selected health certificates. You can try again when your iPhone is unlocked."
        }
        busy = false
    }

    private func authorize(_ request: () async throws -> Void) async -> Bool {
        busy = true
        error = nil
        let attempt = generation
        do {
            try await request()
            guard attempt == generation else { return false }
            accessRequested = true
        } catch {
            guard attempt == generation else { return false }
            self.error = "Couldn't open Health access. You can try again or review Bob in the Health app."
        }
        busy = false
        return error == nil
    }

    func clear() {
        generation += 1
        rows = []; selected = []; busy = false; progress = 0; error = nil
        readWindow = nil
    }
}
