import BobKit
import SwiftUI

// The message field and one button: the mic while there's nothing to send, Send when there is, and Stop while Bob is replying.
struct ChatComposer: View {
    @Bindable var model: ChatViewModel
    var onVoice: (() -> Void)?
    var audio: ChatAudioModel?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let matches = model.mentionMatches {
                mentionPicker(matches)
            }
            if model.preparingAttachments {
                ProgressView("Preparing attachments…").padding(.horizontal, BobLayout.pageMargin).padding(.vertical, 8)
            }
            if !model.attachments.isEmpty { stagedFiles }
            if let error = model.attachmentError {
                Text(error).font(BobFont.subline).foregroundStyle(BobColor.dangerText).padding(.horizontal, BobLayout.pageMargin)
            }
            if let audio {
                audioControls(audio)
            }
            field
        }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: model.transcript.messages.count)
    }

    // Who the @ being typed could mean, Bob among them.
    private func mentionPicker(_ matches: [RoomPerson]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(matches) { person in
                    Button {
                        model.insertMention(person)
                    } label: {
                        HStack(spacing: 10) {
                            BobAvatar(initials: person.initials, fillIndex: person.fillIndex)
                            Text(person.name).font(BobFont.rowTitle).foregroundStyle(.primary)
                            if let handle = person.handle {
                                Text("@\(handle)").font(BobFont.subline).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 44)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(BobPressStyle())
                    .accessibilityLabel("Mention \(person.name)")
                    BobDivider()
                }
            }
            .padding(.horizontal, BobLayout.pageMargin)
        }
        .frame(maxHeight: 176)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var field: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if model.room == nil {
                ChatAttachmentPicker(model: model, onDictate: audio.map { audio in { audio.startDictation() } })
                    .disabled(audio?.isDictating == true)
            } else {
                Menu {
                    Button("Mention someone", systemImage: "at") {
                        model.draft += (model.draft.isEmpty || model.draft.last?.isWhitespace == true) ? "@" : " @"
                    }
                    if let audio, !audio.isDictating {
                        Button("Dictate into message", systemImage: "mic") { audio.startDictation() }
                            .disabled(model.openPhase != .ready)
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.title3)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Message options")
            }
            TextField("Message", text: $model.draft, prompt: Text("Message").foregroundStyle(.secondary), axis: .vertical)
                .font(BobFont.body)
                .lineLimit(1...5)
                .submitLabel(.send)
                .onSubmit { if audio?.isDictating != true { model.send() } }
                .padding(.vertical, 11)
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .background(BobColor.surface, in: RoundedRectangle(cornerRadius: 22))
                .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(BobColor.controlLine.opacity(0.35), lineWidth: 1) }
                .accessibilityLabel("Message")
            if model.canStop {
                sendButton(symbol: "stop.fill", label: "Stop reply", isEnabled: true) { model.stop() }
            } else if let onVoice, model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.attachments.isEmpty {
                sendButton(symbol: "mic.fill", label: "Talk to Bob", isEnabled: model.isIdle && audio?.isDictating != true, action: onVoice)
            } else {
                sendButton(symbol: "arrow.up", label: "Send", isEnabled: model.canSend && audio?.isDictating != true) { model.send() }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(BobColor.page)
        .overlay(alignment: .top) { BobDivider() }
    }

    @ViewBuilder private func audioControls(_ audio: ChatAudioModel) -> some View {
        if let notice = audio.notice {
            HStack {
                Text(notice).font(BobFont.subline).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button("Dismiss") { audio.notice = nil }.frame(minHeight: 44)
            }.padding(.horizontal, BobLayout.pageMargin)
        }
        if audio.isDictating {
            HStack(spacing: 12) {
                if audio.dictation.phase == .recording {
                    Label("Listening…", systemImage: "mic.fill")
                    Spacer(minLength: 0)
                    Button("Done") { audio.finishDictation() }.frame(minHeight: 44)
                } else {
                    ProgressView(audio.dictation.phase == .transcribing ? "Adding your words…" : "Opening microphone…")
                    Spacer(minLength: 0)
                }
                Button("Cancel") { audio.cancelDictation() }.frame(minHeight: 44)
            }
            .font(BobFont.subline)
            .padding(.horizontal, BobLayout.pageMargin)
        }
        if audio.replayMessageID != nil {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    if audio.replayPhase == .preparing {
                        ProgressView().frame(width: 44, height: 44).accessibilityLabel("Preparing speech")
                    } else {
                        Button { audio.toggleReplay() } label: {
                            Image(systemName: audio.replayPhase == .playing ? "pause.fill" : "play.fill")
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel(audio.replayPhase == .playing ? "Pause spoken reply" : "Play spoken reply")
                        .disabled(!audio.canReplay)
                    }
                    if audio.replayPhase == .preparing {
                        Text("Preparing reply…").font(BobFont.subline)
                    } else {
                        TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                            Text("\(audioTime(audio.replayTime)) / \(audioTime(audio.replayDuration))")
                                .font(BobFont.subline).monospacedDigit()
                                .accessibilityLabel("Playback \(audioTime(audio.replayTime)) of \(audioTime(audio.replayDuration))")
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Stop") { audio.cancelAll() }.frame(minHeight: 44)
                        .accessibilityLabel("Stop and close spoken reply")
                }
                if audio.replayShortened {
                    Text("Reading the first part of this reply.")
                        .font(BobFont.caption).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, BobLayout.pageMargin)
        }
    }

    private func audioTime(_ seconds: TimeInterval) -> String {
        let value = seconds.isFinite ? Int(max(0, seconds)) : 0
        return String(format: "%d:%02d", value / 60, value % 60)
    }

    private var stagedFiles: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(model.attachments) { file in
                    HStack(spacing: 4) {
                        Image(systemName: file.mediaType.hasPrefix("image/") ? "photo" : "doc")
                        Text(file.name).font(BobFont.caption).lineLimit(1)
                        Button { model.removeAttachment(file.id) } label: {
                            Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44)
                        }.accessibilityLabel("Remove \(file.name)")
                    }
                    .padding(.leading, 12)
                    .background(BobColor.wash, in: RoundedRectangle(cornerRadius: 12))
                }
            }.padding(.horizontal, BobLayout.pageMargin)
        }
    }

    private func sendButton(symbol: String, label: String, isEnabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(isEnabled ? BobColor.onAccent : .secondary)
                .frame(width: 36, height: 36)
                .background(isEnabled ? BobColor.accent : Color.clear, in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .disabled(!isEnabled)
        .accessibilityLabel(label)
    }
}

#Preview {
    VStack {
        Spacer()
        ChatComposer(model: ChatViewModel(service: StubChatService()))
    }
    .bobPage()
}
