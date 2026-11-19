import AppIntents
import BobKit
import Foundation

// What Siri reads when something fails. Thrown so a shortcut stops rather than carrying an error into its next step.
nonisolated struct BobIntentError: Error, CustomLocalizedStringResourceConvertible {
    let line: String

    var localizedStringResource: LocalizedStringResource { "\(line)" }
}

// The app's own services, built for one run of an intent. The session is the app's, as intents run in the app's process. Built fresh each time: the space they cache belongs to whoever is signed in now.
struct IntentServices {
    let chat: ChatStreaming
    let productivity: ProductivityServices

    static func make() -> IntentServices {
        let chat = ChatServiceFactory.make()
        return IntentServices(chat: chat.chat, productivity: ProductivityServices.make(conversations: chat.conversations))
    }

    // Signs the failure in plain words, and looks for a session before any work starts. A cancelled run stays cancelled.
    static func run<Result>(_ work: (IntentServices) async throws -> Result) async throws -> Result {
        do {
            if let manager = AppSession.manager, try await !manager.isSignedIn() {
                throw ApiError.unauthenticated
            }
            return try await work(make())
        } catch where SiriLines.isCancelled(error) {
            throw CancellationError()
        } catch {
            throw BobIntentError(line: SiriLines.failure(error))
        }
    }
}
