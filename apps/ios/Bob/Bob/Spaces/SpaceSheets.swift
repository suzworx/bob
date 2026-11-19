import BobKit
import SwiftUI
import UIKit

// One name to type: a new or renamed space, thread or chat. The save happens in the caller, which throws to keep the text.
struct BobNameSheet: View {
    let title: String
    let label: String
    let limit: Int
    var initial = ""
    let onSave: (String) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var text = ""
    @State private var saving = false
    @State private var notice: String?

    private var clean: String? { SpaceRules.cleanName(text, limit: limit) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    BobField(label: label) {
                        TextField(label, text: Binding(get: { text }, set: { text = String($0.prefix(limit)) }))
                            .focused($focused)
                            .submitLabel(.done)
                            .onSubmit(save)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 12)
            }
            .bobPage()
            .toolbarBackground(.hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                BobSheetBar(title: title, canSave: clean != nil && clean != initial, saving: saving, onCancel: { dismiss() }, onSave: save)
            }
        }
        .task {
            text = initial
            focused = true
        }
    }

    private func save() {
        guard let clean, clean != initial, !saving else { return }
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                try await onSave(clean)
                dismiss()
            } catch {
                notice = productivityMessage(error)
            }
        }
    }
}

// An invitation link can't be read back later, so it's shown here once.
struct BobInviteLinkRow: View {
    let link: String
    var intro: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(intro).font(BobFont.subline).foregroundStyle(BobColor.ink2)
            Text(link).font(BobFont.code).textSelection(.enabled).privacySensitive()
            HStack(spacing: 8) {
                Button(copied ? "Copied" : "Copy link") {
                    UIPasteboard.general.string = link
                    copied = true
                    AccessibilityAnnouncer.say("Link copied")
                }
                .buttonStyle(BobSecondaryButtonStyle())
                if let url = URL(string: link) {
                    ShareLink("Share", item: url)
                        .buttonStyle(BobSecondaryButtonStyle())
                }
            }
        }
    }
}

// Invite by email into a space. The server's answer says whether mail went out; the link is there either way.
struct SpaceInviteSheet: View {
    let model: SpaceDetailModel
    let linkBase: URL

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var email = ""
    @State private var role = InviteRole.member
    @State private var saving = false
    @State private var notice: String?
    @State private var triedInvalid = false
    @State private var issued: IssuedInvitation?

    private var trimmed: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isValid: Bool { SpaceRules.isValidEmail(trimmed) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let issued {
                        Text(issued.emailSent ? "Invitation sent to \(issued.invitation.invitedEmail)." : "We couldn't email \(issued.invitation.invitedEmail). Share this link instead.")
                            .font(BobFont.body)
                        BobInviteLinkRow(link: InvitationCode.spaceLink(token: issued.token, base: linkBase), intro: issued.emailSent ? "Or share this link. It is shown once." : "It is shown once.")
                        Button("Invite someone else") {
                            self.issued = nil
                            email = ""
                            focused = true
                        }
                        .buttonStyle(BobSecondaryButtonStyle())
                    } else {
                        if let notice {
                            Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                        }
                        BobField(label: "Email") {
                            TextField("Email", text: $email)
                                .keyboardType(.emailAddress)
                                .textContentType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($focused)
                                .submitLabel(.send)
                                .onSubmit(send)
                        }
                        if triedInvalid, !isValid {
                            Text("That doesn't look like an email address. Check it and try again.")
                                .font(BobFont.subline)
                                .foregroundStyle(BobColor.dangerText)
                        }
                        Picker("Role", selection: $role) {
                            ForEach(InviteRole.allCases) { Text($0.title).tag($0) }
                        }
                        .bobChoicePicker()
                        .controlSize(.large)
                        Button(action: send) {
                            if saving {
                                ProgressView().accessibilityLabel("Sending")
                            } else {
                                Text("Send invite")
                            }
                        }
                        .buttonStyle(BobPrimaryButtonStyle())
                        .disabled(saving)
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
                ToolbarItem(placement: .principal) {
                    Text("Invite people").font(BobFont.caption).accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .task { focused = true }
    }

    private func send() {
        guard isValid else {
            triedInvalid = true
            return
        }
        guard !saving else { return }
        saving = true
        notice = nil
        Task {
            defer { saving = false }
            do {
                issued = try await model.invite(email: trimmed, role: role)
            } catch {
                notice = productivityMessage(error)
            }
        }
    }
}

// Joining with a token or a whole link pasted in. Nothing is joined until the person has seen what it is and says so.
struct JoinInvitationSheet: View {
    enum Joined {
        case space, chat(GroupChat)
    }

    private enum Found {
        case space(InvitationPreview, token: String)
        case chat(GroupChatPreview, token: String)
    }

    let spaces: SpacesService
    let chats: GroupChatsService
    let onJoined: (Joined) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var text = ""
    @State private var found: Found?
    @State private var working = false
    @State private var notice: String?

    private static let unusable = "This invitation can't be used. It may have expired, been revoked, or already been used."

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let notice {
                        Text(notice).font(BobFont.subline).foregroundStyle(BobColor.dangerText)
                    }
                    switch found {
                    case .none: entry
                    case .space(let preview, let token): spacePreview(preview, token: token)
                    case .chat(let preview, let token): chatPreview(preview, token: token)
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
                ToolbarItem(placement: .principal) {
                    Text("Join with an invitation").font(BobFont.caption).accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task { focused = true }
    }

    private var entry: some View {
        VStack(alignment: .leading, spacing: 12) {
            BobField(label: "Invitation link or code") {
                TextField("Invitation link or code", text: $text, axis: .vertical)
                    .lineLimit(1...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(lookUp)
            }
            HStack(spacing: 8) {
                PasteButton(payloadType: String.self) { strings in
                    if let first = strings.first {
                        Task { @MainActor in text = first }
                    }
                }
                .labelStyle(.titleOnly)
                Button(action: lookUp) {
                    if working {
                        ProgressView().accessibilityLabel("Checking the invitation")
                    } else {
                        Text("Continue")
                    }
                }
                .buttonStyle(BobPrimaryButtonStyle())
                .disabled(working || text.isEmpty)
            }
        }
    }

    private func spacePreview(_ preview: InvitationPreview, token: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(preview.spaceName).font(BobFont.heading).accessibilityAddTraits(.isHeader)
            Text("\(preview.inviterName) invited you\(preview.role.map { " as \($0.title.lowercased())" } ?? "").").font(BobFont.body)
            if preview.exposesHistory {
                Text("Joining lets you read what's already in this space.").font(BobFont.subline).foregroundStyle(BobColor.ink2)
            }
            joinButton("Join space") {
                let outcome = try await spaces.acceptInvitation(token: token)
                guard outcome.isJoined else {
                    notice = outcome.message
                    return
                }
                AccessibilityAnnouncer.say(outcome.message)
                onJoined(.space)
                dismiss()
            }
        }
    }

    private func chatPreview(_ preview: GroupChatPreview, token: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(preview.title).font(BobFont.heading).accessibilityAddTraits(.isHeader)
            Text("\(preview.inviterName) invited you to chat with Bob.").font(BobFont.body)
            Text("When you join, you can read the chat's earlier messages. Other participants will see your name and messages.")
                .font(BobFont.subline)
                .foregroundStyle(BobColor.ink2)
            Text("This invitation expires \(preview.expiresAt.formatted(date: .abbreviated, time: .omitted)).")
                .font(BobFont.subline)
                .foregroundStyle(BobColor.muted)
            joinButton("Join chat") {
                let chat = try await chats.accept(token: token)
                onJoined(.chat(chat))
                dismiss()
            }
        }
    }

    private func joinButton(_ title: String, action: @escaping () async throws -> Void) -> some View {
        Button {
            working = true
            notice = nil
            Task {
                defer { working = false }
                do {
                    try await action()
                } catch ApiError.notFound {
                    notice = Self.unusable
                } catch {
                    notice = productivityMessage(error)
                }
            }
        } label: {
            if working {
                ProgressView().accessibilityLabel("Joining")
            } else {
                Text(title)
            }
        }
        .buttonStyle(BobPrimaryButtonStyle())
        .disabled(working)
    }

    private func lookUp() {
        guard !working else { return }
        guard let code = InvitationCode(text) else {
            notice = "That doesn't look like an invitation. Paste the whole link, or the code from it."
            return
        }
        working = true
        notice = nil
        Task {
            defer { working = false }
            do {
                found = try await resolve(code)
            } catch ApiError.notFound {
                notice = Self.unusable
            } catch {
                notice = productivityMessage(error)
            }
        }
    }

    // A bare code could be either kind, so a space is tried first and then a chat.
    private func resolve(_ code: InvitationCode) async throws -> Found {
        switch code.kind {
        case .space:
            return .space(try await spaces.previewInvitation(token: code.token), token: code.token)
        case .groupChat:
            return .chat(try await chats.preview(token: code.token), token: code.token)
        case .unknown:
            do {
                return .space(try await spaces.previewInvitation(token: code.token), token: code.token)
            } catch ApiError.notFound {
                return .chat(try await chats.preview(token: code.token), token: code.token)
            }
        }
    }
}

// Tasks, Notes and Reminders work in one space at a time; this says which and changes it.
struct SpaceScopeRow: View {
    let store: ProductivityStore

    var body: some View {
        let scope = store.scope
        if scope.spaces.count > 1 {
            Menu {
                ForEach(scope.spaces) { space in
                    Button {
                        Task {
                            await store.switchSpace(to: space.id)
                            await store.tasks.refresh()
                            await store.notes.refresh()
                            await store.reminders.refresh()
                        }
                    } label: {
                        if space.id == scope.currentID {
                            Label(space.name, systemImage: "checkmark")
                        } else {
                            Text(space.name)
                        }
                    }
                }
            } label: {
                HStack {
                    Text("Space").font(BobFont.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(scope.current?.name ?? "Personal").font(BobFont.rowTitle).foregroundStyle(.primary)
                    Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Space: \(scope.current?.name ?? "Personal"). Change space")
            .bobListRow()
        }
    }
}
