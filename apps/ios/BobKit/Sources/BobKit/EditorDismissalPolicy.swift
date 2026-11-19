/// User-initiated exits must not lose an unsaved draft or interrupt its save.
/// A successful save dismisses directly; a failed save keeps this protection.
public struct EditorDismissalPolicy: Sendable {
    public enum CancelAction: Equatable, Sendable {
        case dismiss, confirmDiscard, blocked
    }

    public let hasUnsavedChanges: Bool
    public let isSaving: Bool

    public init(hasUnsavedChanges: Bool, isSaving: Bool) {
        self.hasUnsavedChanges = hasUnsavedChanges
        self.isSaving = isSaving
    }

    public var cancelAction: CancelAction {
        if isSaving { return .blocked }
        return hasUnsavedChanges ? .confirmDiscard : .dismiss
    }

    public var preventsInteractiveDismissal: Bool { hasUnsavedChanges || isSaving }
}
