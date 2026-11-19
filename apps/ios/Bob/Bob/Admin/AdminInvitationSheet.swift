import BobKit
import SwiftUI

struct AdminInvitationSheet: View {
    let model: NativeAdminModel
    @State private var email: String
    @State private var confirmation = false
    @State private var retryEmail: String?
    @State private var error: String?
    @State private var notice: String?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    init(model: NativeAdminModel, initialEmail: String) { self.model = model; _email = State(initialValue: initialEmail) }
    var body: some View {
        NavigationStack {
            Form {
                Text("Give this person sign-in access and send a Bob invitation.").font(BobFont.body).bobListRow()
                TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    .autocorrectionDisabled().disabled(saving || retryEmail != nil).bobListRow()
                if let error { Text(error).font(BobFont.subline).foregroundStyle(BobColor.dangerText).bobListRow() }
                if let notice { Text(notice).font(BobFont.subline).bobListRow() }
                if notice == nil {
                    Button(saving ? "Sending…" : retryEmail == nil ? "Add person" : "Retry invitation") { confirmation = true }
                        .disabled(saving || !AdminClient.validEmail(email) || !model.allowed).bobListRow()
                }
            }
            .bobList().bobNavTitle("Add person").privacySensitive()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(notice == nil ? "Cancel" : "Done") { dismiss() }.disabled(saving) } }
            .confirmationDialog(retryEmail == nil ? "Add this person?" : "Retry this invitation?", isPresented: $confirmation, titleVisibility: .visible) {
                Button(retryEmail == nil ? "Add person and invite" : "Retry invitation") { Task { await send() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text(email.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }.interactiveDismissDisabled(saving)
    }
    private func send() async {
        guard !saving else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let address = retryEmail ?? email.trimmingCharacters(in: .whitespacesAndNewlines)
            let result = try await model.invite(email: address, retry: retryEmail != nil)
            switch result.invitation {
            case .failed:
                retryEmail = address; error = "The account is ready, but the invitation didn't send. Retry the invitation."
            case .queued:
                notice = result.status == .created ? "Account created. The invitation is queued." : "This person already has an account. The invitation is queued."
            case .sent:
                notice = result.status == .created ? "Account created and invitation sent." : "This person already has an account. Invitation sent."
            }
        } catch { self.error = ApiErrorMapper.userMessage((error as? ApiError) ?? .unknown(status: 0)) }
    }
}
