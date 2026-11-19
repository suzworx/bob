import Foundation

// A server or network failure reduced to what the app needs: a kind, and a plain message a person can read.
public enum ApiError: Error, Equatable, Sendable {
    case unauthenticated
    case invalidRequest
    case notFound
    case audioTooLarge
    case noSpeechDetected
    case unsupportedAudio
    case rateLimited(retryAfterSeconds: Int?)
    case outOfCredit
    // Memory is switched off for this account.
    case memoryUnavailable
    // The server refuses to remember anything that looks like a password or PIN.
    case secretRefused
    // Deleting the account is refused until these shared spaces have another owner.
    case ownsGroups(count: Int)
    // The device has to be connected for this.
    case noDevice
    // The device's firmware has never reported these settings, so it could not apply them.
    case settingUnsupported
    // The person can see this but their role doesn't allow it.
    case forbidden
    // The server refused for a stated reason, named by its code.
    case conflict(code: String)
    case upstream
    case server
    case offline
    case cancelled
    case unknown(status: Int)
}

public enum ApiErrorMapper {
    private static let conflictCodes: Set<String> = ["group_full", "unsupported_history", "last_owner", "private_space", "space_archived"]

    // Maps an HTTP status and the server's `{"error":{"code":"...","message":"..."}}` body. Never throws.
    public static func map(status: Int, body: Data?, retryAfter: String?) -> ApiError {
        let code = errorCode(from: body)
        switch status {
        case 401:
            return .unauthenticated
        case 400:
            if code == "unsupported_format" || code == "invalid_audio" {
                return .unsupportedAudio
            }
            return .invalidRequest
        case 403:
            return .forbidden
        case 404:
            return .notFound
        case 409 where code.map(conflictCodes.contains) == true:
            return .conflict(code: code ?? "")
        case 409 where code == "owns_groups":
            return .ownsGroups(count: errorCount(from: body) ?? 1)
        case 409 where code == "no_device":
            return .noDevice
        case 409 where code == "ring_unsupported" || code == "wake_word_unsupported":
            return .settingUnsupported
        case 413:
            // Only /voice answers audio_too_large; any other oversized body is a plain invalid request.
            return code == "audio_too_large" ? .audioTooLarge : .invalidRequest
        case 422:
            if code == "no_speech_detected" {
                return .noSpeechDetected
            }
            return code == "secret_refused" ? .secretRefused : .invalidRequest
        case 429:
            return .rateLimited(retryAfterSeconds: retryAfterSeconds(from: retryAfter))
        case 503 where code == "out_of_credit":
            return .outOfCredit
        case 503 where code == "memory_unavailable":
            return .memoryUnavailable
        case 502:
            return .upstream
        case 500...599:
            return .server
        default:
            return .unknown(status: status)
        }
    }

    // A reply that fails mid-stream arrives as an SSE error part, not as an HTTP status.
    // A spent budget is "out_of_credit"; anything else is an upstream failure. The text itself is never shown.
    public static func mapStreamError(errorText: String?) -> ApiError {
        errorText == "out_of_credit" ? .outOfCredit : .upstream
    }

    public static func mapTransport(_ code: URLError.Code) -> ApiError {
        switch code {
        case .notConnectedToInternet,
             .networkConnectionLost,
             .dataNotAllowed,
             .internationalRoamingOff,
             .cannotFindHost,
             .cannotConnectToHost,
             .dnsLookupFailed:
            return .offline
        case .timedOut:
            return .upstream
        case .cancelled:
            return .cancelled
        default:
            return .unknown(status: 0)
        }
    }

    // Never includes the status number, the server's message or the error code.
    public static func userMessage(_ error: ApiError) -> String {
        switch error {
        case .unauthenticated:
            return "Please sign in again."
        case .invalidRequest:
            return "Bob couldn't read that. Try again."
        case .notFound:
            return "That isn't there any more."
        case .audioTooLarge:
            return "That recording was too long. Try a shorter one."
        case .noSpeechDetected:
            return "I didn't catch that."
        case .unsupportedAudio:
            return "I couldn't read that recording. Try again."
        case .rateLimited:
            return "Bob needs a short break. Try again in a moment."
        case .outOfCredit:
            return "Bob is out of credit right now."
        case .memoryUnavailable:
            return "Bob can't remember things on your account right now."
        case .secretRefused:
            return "That looks like a password, PIN or other secret. Bob never stores those."
        case .ownsGroups(let count):
            return "You own \(count) \(count == 1 ? "shared space" : "shared spaces"). Give each one to another member first, then try again."
        case .noDevice:
            return "That device is offline."
        case .settingUnsupported:
            return "That device needs a firmware update first."
        case .forbidden:
            return "Your role in this space doesn't allow that."
        case .conflict("group_full"):
            return "This chat is full."
        case .conflict("unsupported_history"):
            return "Some of this chat can't be shared yet."
        case .conflict("last_owner"):
            return "The owner can't leave. Make someone else the owner first."
        case .conflict("private_space"):
            return "You can't leave your private space."
        case .conflict("space_archived"):
            return "This space is archived."
        case .conflict:
            return "That didn't go through because something changed. Try again."
        case .upstream:
            return "Bob had trouble. Try again."
        case .server:
            return "Something went wrong on our side. Try again."
        case .offline:
            return "You're offline. Try again when you're back."
        case .cancelled:
            return ""
        case .unknown:
            return "Something went wrong. Try again."
        }
    }

    public static func isRetryable(_ error: ApiError) -> Bool {
        switch error {
        case .rateLimited, .upstream, .server, .offline:
            return true
        case .unknown(let status):
            return status >= 500
        case .unauthenticated, .invalidRequest, .notFound, .audioTooLarge,
             .noSpeechDetected, .unsupportedAudio, .outOfCredit, .memoryUnavailable, .secretRefused,
             .ownsGroups, .noDevice, .settingUnsupported, .forbidden, .conflict, .cancelled:
            return false
        }
    }

    private static func errorCode(from body: Data?) -> String? {
        guard let body, !body.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let error = object["error"] as? [String: Any],
              let code = error["code"] as? String else {
            return nil
        }
        return code
    }

    private static func errorCount(from body: Data?) -> Int? {
        guard let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let error = object["error"] as? [String: Any] else {
            return nil
        }
        return error["count"] as? Int
    }

    private static func retryAfterSeconds(from value: String?) -> Int? {
        guard let value, !value.isEmpty,
              value.unicodeScalars.allSatisfy({ $0.isASCII && $0.properties.numericType == .decimal }) else {
            return nil
        }
        return Int(value)
    }
}
