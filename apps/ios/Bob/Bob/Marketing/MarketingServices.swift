import BobKit
import Foundation

@MainActor enum MarketingServices {
    static func make() -> (any MarketingService)? {
        if let live = AppSession.make({ MarketingClient(baseURL: $0, accessToken: $1, reauthenticate: $2) }) { return live }
        #if DEBUG
        return MarketingPreviewService.shared
        #else
        return nil
        #endif
    }
}

func marketingError(_ error: ApiError) -> String {
    switch error {
    case .unknown(status: 409), .conflict: "This changed while you were working. Refresh and review the latest version before trying again."
    case .forbidden: "Your access changed, or this app is paused. Refresh to check before saving."
    default: ApiErrorMapper.userMessage(error)
    }
}
