import BobKit
import SwiftUI

// A plain row: no card and no system separator, with the one hairline along its foot.
private struct BobListRowModifier: ViewModifier {
    var divider = true

    func body(content: Content) -> some View {
        content
            .frame(minHeight: 44)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                if divider { BobDivider() }
            }
            .listRowInsets(EdgeInsets(top: 0, leading: BobLayout.pageMargin, bottom: 0, trailing: BobLayout.pageMargin))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }
}

extension View {
    func bobListRow(divider: Bool = true) -> some View {
        modifier(BobListRowModifier(divider: divider))
    }

    func bobList() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .bobPage()
    }

    func bobForm() -> some View {
        formStyle(.grouped)
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .bobPage()
    }

    // Native titles and a stable background keep every navigation bar familiar.
    func bobNavigationChrome() -> some View {
        navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(BobColor.page, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .tint(BobColor.accent)
    }

    // Every inline title, in Bob's type. Same header as `bobChild` without a scope line.
    func bobNavTitle(_ title: String) -> some View {
        bobChild(title)
            .bobNavigationChrome()
    }

    func bobErrorAlert(_ message: String?, clear: @escaping () -> Void) -> some View {
        alert(
            "That didn't work",
            isPresented: Binding(get: { message != nil }, set: { if !$0 { clear() } }),
            actions: { Button("OK", role: .cancel) { clear() } },
            message: { Text(message ?? "") }
        )
    }

    func bobUndoBar(_ offer: UndoOffer?, clear: @escaping () -> Void) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            BobUndoBar(offer: offer, clear: clear)
        }
    }

    func bobSheet() -> some View {
        presentationDragIndicator(.visible)
            .presentationBackground { BobSky() }
            .tint(BobColor.accent)
    }
}

// A short choice as a segmented control, or a menu once accessibility sizes would truncate its segments.
private struct BobChoicePickerModifier: ViewModifier {
    @Environment(\.dynamicTypeSize) private var size

    func body(content: Content) -> some View {
        if size.isAccessibilitySize {
            content.pickerStyle(.menu)
        } else {
            content.pickerStyle(.segmented)
        }
    }
}

extension Picker {
    func bobChoicePicker() -> some View {
        modifier(BobChoicePickerModifier())
    }
}

// A group's name, a row of its own so it scrolls with the list.
struct BobGroupHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(BobFont.caption)
            .foregroundStyle(BobColor.muted)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, 16)
            .bobListRow(divider: false)
    }
}

// What was just done and a way back. It stays while VoiceOver is on, so the person can reach it.
private struct BobUndoBar: View {
    let offer: UndoOffer?
    let clear: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    var body: some View {
        Group {
            if let offer {
                VStack(spacing: 0) {
                    BobDivider()
                    HStack(spacing: 12) {
                        Text(offer.message)
                            .font(BobFont.subline)
                            .lineLimit(2)
                        Spacer(minLength: 8)
                        Button("Undo") {
                            clear()
                            Task { await offer.action() }
                        }
                        .font(BobFont.caption)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                        .buttonStyle(BobPressStyle())
                    }
                    .padding(.horizontal, BobLayout.pageMargin)
                    .padding(.vertical, 4)
                }
                .background(BobColor.page)
                .transition(.opacity)
                .task(id: offer.id) {
                    AccessibilityNotification.Announcement(offer.message).post()
                    guard !voiceOver else { return }
                    try? await Task.sleep(for: .seconds(8))
                    if !Task.isCancelled { clear() }
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: offer?.id)
    }
}

// A label above its control, with the hairline below: the editors' one field shape.
struct BobField<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(BobFont.caption).foregroundStyle(BobColor.muted).accessibilityHidden(true)
            content.frame(minHeight: 44)
            BobDivider()
        }
    }
}

// Cancel and Save in a sheet's bar. Save is off until the form can be saved.
struct BobSheetBar: ToolbarContent {
    let title: String
    let canSave: Bool
    let saving: Bool
    let onCancel: () -> Void
    let onSave: () -> Void

    var body: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", action: onCancel).disabled(saving)
        }
        ToolbarItem(placement: .principal) {
            Text(title).font(BobFont.navigationTitle).accessibilityAddTraits(.isHeader)
        }
        ToolbarItem(placement: .confirmationAction) {
            if saving {
                ProgressView().accessibilityLabel("Saving")
            } else {
                Button("Save", action: onSave).disabled(!canSave)
            }
        }
    }
}

// A failed screen, with the one thing that can help.
struct BobLoadFailure: View {
    let title: String
    let error: ApiError
    let retry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: error.stateSymbol)
        } description: {
            Text(ApiErrorMapper.userMessage(error))
        } actions: {
            Button("Try again") { Task { await retry() } }
                .buttonStyle(BobPrimaryButtonStyle())
        }
    }
}
