import BobKit
import SwiftUI

// Who is signed in. Name and time zone are saved on the account, so the web and the server see them too.
struct ProfileView: View {
    let model: AccountModel

    @State private var editingName = false
    @State private var confirmingSignOut = false
    @State private var confirmingReset = false
    @State private var sendingReset = false
    @State private var resetNotice: String?
    @State private var resetTask: Task<Void, Never>?
    @State private var resetRequest: UUID?

    var body: some View {
        @Bindable var model = model
        List {
            BobFactRow(title: "Email", value: model.profile?.email ?? "Not available")
            if model.canEditProfile {
                Button { editingName = true } label: {
                    HStack(spacing: 12) {
                        Text("Display name").font(BobFont.rowTitle).foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        Text(model.profile?.name ?? "Not set").font(BobFont.subline).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .accessibilityHint("Edits your name")
                .bobListRow()
                NavigationLink(value: YouRoute.timeZone) {
                    HStack(spacing: 12) {
                        Text("Time zone").font(BobFont.rowTitle)
                        Spacer(minLength: 8)
                        Text(AccountProfile.zoneLabel(model.zone)).font(BobFont.subline).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                    }
                }
                .bobListRow()
            } else {
                BobFactRow(title: "Display name", value: model.profile?.name ?? "Not set")
                BobFactRow(title: "Time zone", value: AccountProfile.zoneLabel(model.zone))
                Text("Your name can't be changed when you're signed in this way.")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .bobListRow(divider: false)
            }
            if model.hasSession {
                if AppSession.authClient != nil, model.profile?.email != nil {
                    Button(sendingReset ? "Sending reset link…" : "Email password reset link") { confirmingReset = true }
                        .font(BobFont.rowTitle)
                        .frame(minHeight: 44)
                        .disabled(sendingReset)
                        .bobListRow()
                    if let resetNotice {
                        Text(resetNotice).font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
                    }
                }
                Button("Sign out everywhere", role: .destructive) { confirmingSignOut = true }
                    .font(BobFont.rowTitle)
                    .foregroundStyle(BobColor.dangerText)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .buttonStyle(BobPressStyle())
                    .disabled(model.signingOutEverywhere)
                    .accessibilityHint("Signs out on every device, including this one")
                    .padding(.top, 12)
                    .bobListRow(divider: false)
            }
        }
        .bobList()
        .privacySensitive()
        .bobNavTitle("Profile")
        .task { await model.loadProfile() }
        .sheet(isPresented: $editingName) {
            NameEditorSheet(model: model).bobSheet()
        }
        .alert("Sign out everywhere?", isPresented: $confirmingSignOut) {
            Button("Sign out everywhere", role: .destructive) { Task { await model.signOutEverywhere() } }
            Button("Stay signed in", role: .cancel) {}
        } message: {
            Text("You'll be signed out on every device, including this one, and need to sign in again.")
        }
        .bobErrorAlert(model.message) { model.message = nil }
        .confirmationDialog("Send a password reset link?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Send email") { sendReset() }
        } message: {
            Text("We'll email \(model.profile?.email ?? "your account"). The link opens Bob's password reset page in your browser.")
        }
        .onDisappear { resetTask?.cancel(); resetRequest = nil; sendingReset = false }
    }

    private func sendReset() {
        guard !sendingReset, let client = AppSession.authClient, let email = model.profile?.email else { return }
        sendingReset = true
        resetNotice = nil
        let requestID = UUID()
        resetRequest = requestID
        resetTask = Task {
            defer { if resetRequest == requestID { sendingReset = false } }
            do {
                try await client.requestPasswordReset(email: email)
                guard !Task.isCancelled else { return }
                resetNotice = "Check your email for the reset link. You'll choose your password in the browser."
            } catch {
                guard !Task.isCancelled else { return }
                resetNotice = "Couldn't send the reset link. Please wait a moment and try again."
            }
        }
    }
}

private struct NameEditorSheet: View {
    let model: AccountModel

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var draft = ""
    @State private var saving = false
    @State private var notice: String?

    private var canSave: Bool {
        guard let name = AccountProfile.validName(draft) else { return false }
        return name != model.profile?.name
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: "Display name") {
                        TextField("Display name", text: Binding(get: { draft }, set: { draft = String($0.prefix(AccountProfile.nameLimit)) }))
                            .textContentType(.name)
                            .submitLabel(.done)
                            .focused($focused)
                            .onSubmit { if canSave { save() } }
                    }
                    Text("Your name as your spaces see it. It also sets your @handle.")
                        .font(BobFont.subline)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 32)
            }
            .bobPage()
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(title: "Your name", canSave: canSave, saving: saving, onCancel: { dismiss() }, onSave: save)
            }
        }
        .onAppear { draft = model.profile?.name ?? "" }
        .task { focused = true }
    }

    private func save() {
        guard let name = AccountProfile.validName(draft) else { return }
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                try await model.saveName(name)
                dismiss()
            } catch where isCancelled(error) {
                return
            } catch {
                notice = "Your name couldn't be saved. Try again."
            }
        }
    }
}

// Every time zone, searchable. Choosing one saves it and goes back.
struct TimeZonePickerView: View {
    let model: AccountModel

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var saving: String?

    var body: some View {
        let zones = AccountProfile.zones(matching: query)
        List {
            if zones.isEmpty {
                ContentUnavailableView.search(text: query).bobListRow(divider: false)
            }
            ForEach(zones, id: \.self) { zone in
                Button { choose(zone) } label: {
                    HStack(spacing: 12) {
                        Text(AccountProfile.zoneLabel(zone)).font(BobFont.rowTitle).foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        if saving == zone {
                            ProgressView().accessibilityLabel("Saving")
                        } else if zone == model.zone {
                            Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(BobColor.accent).accessibilityHidden(true)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BobPressStyle())
                .disabled(saving != nil)
                .accessibilityAddTraits(zone == model.zone ? .isSelected : [])
                .bobListRow()
            }
        }
        .bobList()
        .bobNavTitle("Time zone")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search time zones")
        .bobErrorAlert(model.message) { model.message = nil }
    }

    private func choose(_ zone: String) {
        guard zone != model.zone else {
            dismiss()
            return
        }
        saving = zone
        Task {
            defer { saving = nil }
            do {
                try await model.saveZone(zone)
                dismiss()
            } catch where isCancelled(error) {
                return
            } catch {
                model.message = "Your time zone couldn't be saved."
            }
        }
    }
}
