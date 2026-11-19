import AuthenticationServices
import BobKit
import SwiftUI

@MainActor final class GoogleAuthenticationSession: NSObject, GoogleAuthorizationBrowser, ASWebAuthenticationPresentationContextProviding {
    private static weak var active: GoogleAuthenticationSession?
    weak var window: UIWindow?
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var generation = 0

    static func cancelActive() { active?.cancel() }

    func open(_ url: URL) async throws -> URL {
        guard session == nil, window != nil else { throw ApiError.unknown(status: 0) }
        Self.active?.cancel()
        generation += 1
        let request = generation
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: GoogleAuthorizationCallback.scheme) { [weak self] callback, error in
                    Task { @MainActor in
                        guard let self, request == self.generation else { return }
                        if let callback { self.finish(.success(callback)) }
                        else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { self.finish(.failure(ApiError.cancelled)) }
                        else { self.finish(.failure(ApiError.unknown(status: 0))) }
                    }
                }
                auth.presentationContextProvider = self
                session = auth
                Self.active = self
                if !auth.start() { finish(.failure(ApiError.unknown(status: 0))) }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, request == self.generation else { return }
                self.cancel()
            }
        }
    }

    func cancel() {
        generation += 1
        session?.cancel()
        finish(.failure(ApiError.cancelled))
    }
    private func finish(_ result: Result<URL, Error>) {
        let callback = continuation
        continuation = nil
        session = nil
        if Self.active === self { Self.active = nil }
        callback?.resume(with: result)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }
}

/// Takes the actual presenting scene's window, rather than guessing a global key window.
struct GoogleAuthorizationAnchor: UIViewRepresentable {
    let browser: GoogleAuthenticationSession
    func makeUIView(context: Context) -> GoogleAuthorizationAnchorView {
        let view = GoogleAuthorizationAnchorView()
        view.browser = browser
        view.isUserInteractionEnabled = false
        return view
    }
    func updateUIView(_ uiView: GoogleAuthorizationAnchorView, context: Context) { uiView.browser = browser }
}
final class GoogleAuthorizationAnchorView: UIView {
    weak var browser: GoogleAuthenticationSession?
    override func didMoveToWindow() { super.didMoveToWindow(); browser?.window = window }
}
