import BobKit
import Foundation
import Observation
import SwiftUI

// The person's look, saved on this device and read by every screen.
@Observable final class BobAppearanceStore {
    static let shared = BobAppearanceStore()
    private static let key = "bob.appearance"

    var value: BobAppearance {
        didSet { UserDefaults.standard.set(value.encoded, forKey: Self.key) }
    }

    var colorScheme: ColorScheme? {
        switch value.mode {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    private init() {
        value = BobAppearance.decoded(from: UserDefaults.standard.data(forKey: Self.key))
    }
}
