import BobKit
import SwiftUI
import UniformTypeIdentifiers

// Held in memory until the person picks where the file goes. The app keeps no copy.
private struct ExportDocument: FileDocument {
    nonisolated static let readableContentTypes: [UTType] = [.json]
    let data: Data

    nonisolated init(data: Data) {
        self.data = data
    }

    nonisolated init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    nonisolated func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

// Taking your data with you, and leaving.
struct YourDataView: View {
    let model: AccountModel

    private var showsExporter: Binding<Bool> {
        Binding(get: { model.pendingExport != nil }, set: { if !$0 { model.finishExport(saved: false) } })
    }

    var body: some View {
        List {
            Text("Download what you've created: conversations, memories, and the tasks, notes, events, reminders and timers you added. Other members' content is not included.")
                .font(BobFont.subline)
                .foregroundStyle(.secondary)
                .padding(.top, 8)
                .bobListRow(divider: false)
            Button {
                Task { await model.export() }
            } label: {
                HStack {
                    Text("Export my data").font(BobFont.rowTitle).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    if model.exporting {
                        ProgressView().accessibilityLabel("Exporting")
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .disabled(model.exporting)
            .bobListRow()
            if let problem = model.exportProblem {
                Text(problem).font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow(divider: false)
            }
            YouLink(title: "Delete account", route: .deleteAccount)
        }
        .bobList()
        .bobNavTitle("Your data")
        .fileExporter(
            isPresented: showsExporter,
            document: model.pendingExport.map { ExportDocument(data: $0.data) },
            contentType: .json,
            defaultFilename: model.pendingExport?.baseName
        ) { result in
            model.finishExport(saved: (try? result.get()) != nil)
        }
    }
}

// Deleting the account: what goes, the typed email, then one last question.
struct DeleteAccountView: View {
    let model: AccountModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var typed = ""
    @State private var confirming = false
    @State private var busy = false
    @State private var problem: String?
    @State private var notice: String?

    private var email: String? { model.profile?.email }
    private var phrase: String { AccountDeletion.phrase(email: email) }
    private var confirmed: Bool { AccountDeletion.isConfirmed(typed: typed, email: email) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Deletes your conversations, memories, paired devices, connected Google accounts and private spaces, and removes you from every shared space. Tasks, notes and messages you added to shared spaces stay, credited to a former member.")
                Text("Your sign-in address is removed separately by the Bob team.")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                if let notice {
                    Text(notice).font(BobFont.subline).foregroundStyle(BobColor.okText)
                }
                if let problem {
                    Text(problem).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                }
                BobField(label: "Type \(phrase) to confirm") {
                    TextField("Type \(phrase) to confirm", text: $typed)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .focused($focused)
                }
                Button { confirming = true } label: {
                    Text("Delete account")
                        .font(BobFont.caption)
                        .foregroundStyle(BobColor.dangerText)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(BobColor.wash, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(BobPressStyle())
                .disabled(!confirmed || busy)
                .opacity(confirmed && !busy ? 1 : 0.45)
                    .accessibilityHint(confirmed ? "Asks once more before deleting" : "Type \(phrase) first")
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .bobPage()
        .privacySensitive()
        .bobNavTitle("Delete account")
        .task {
            await model.loadProfile()
            focused = true
        }
        .alert(email.map { "Delete \($0)?" } ?? "Delete your account?", isPresented: $confirming) {
            Button("Delete account", role: .destructive) { remove() }
            Button("Keep my account", role: .cancel) {}
        } message: {
            Text("This can't be undone. Everything listed is deleted, and you'll be signed out on every device.")
        }
        .overlay {
            if busy { ProgressView().accessibilityLabel("Deleting your account") }
        }
    }

    private func remove() {
        busy = true
        problem = nil
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await model.service.deleteAccount()
                await finish()
            } catch let error as ApiError where error != .cancelled {
                if case .ownsGroups = error {
                    problem = "\(ApiErrorMapper.userMessage(error)) You can do that on the web."
                } else {
                    problem = "Your account couldn't be deleted. Try again."
                }
            } catch {
                problem = "Your account couldn't be deleted. Try again."
            }
        }
    }

    // Only a real session signs out. The demo and a developer token say what happened and stay.
    private func finish() async {
        if model.isDemo {
            typed = ""
            notice = "This is the demo, so nothing was deleted and you're still here."
        } else if model.hasSession {
            await model.finishDeletion()
        } else {
            typed = ""
            notice = "The account was deleted. A developer token can't sign out, so close the app."
        }
    }
}
