import BobKit
import SwiftUI

struct BobAppImprovementView: View {
    let app: SavedBobApp
    let session: BobAppImprovementSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if session.opening {
                    ProgressView("Opening your app conversation…")
                } else if let error = session.error {
                    BobLoadFailure(title: "Couldn't open this app conversation", error: error) { await session.open(app) }
                } else if let model = session.model {
                    VStack(spacing: 0) {
                        Text("Ask Bob to improve this app. Your saved work stays here.")
                            .font(.subheadline).foregroundStyle(.secondary)
                            .padding(.horizontal, 16).padding(.vertical, 8)
                        ChatView(model: model)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .bobPage().privacySensitive()
            .bobNavTitle(app.definition.title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { await session.open(app) }
            .onDisappear { session.cancel() }
        }
    }
}
