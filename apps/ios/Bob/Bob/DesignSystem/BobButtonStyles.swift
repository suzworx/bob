import SwiftUI

// The main call to action: ink with white text, as on the web.
struct BobPrimaryButtonStyle: ButtonStyle {
    var expands: Bool = false

    init(expands: Bool = false) {
        self.expands = expands
    }

    func makeBody(configuration: Configuration) -> some View {
        BobCapsuleButton(
            configuration: configuration,
            fill: BobColor.accent,
            text: BobColor.onAccent,
            expands: expands
        )
    }
}

// A quieter action: an ink outline on the page. See apps/ios/DESIGN.md §4.
struct BobSecondaryButtonStyle: ButtonStyle {
    var expands: Bool = false

    init(expands: Bool = false) {
        self.expands = expands
    }

    func makeBody(configuration: Configuration) -> some View {
        BobCapsuleButton(
            configuration: configuration,
            fill: BobColor.page,
            text: BobColor.ink,
            stroke: BobColor.ink,
            expands: expands
        )
    }
}

// Shared body for both styles, a view so it can read the environment and scaled metrics.
private struct BobCapsuleButton: View {
    let configuration: ButtonStyleConfiguration
    let fill: Color
    let text: Color
    var stroke: Color? = nil
    let expands: Bool

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var minHeight: CGFloat = 50
    // Fixed so large text keeps the width for the words.
    private let horizontalPadding: CGFloat = 20

    private var opacity: Double {
        if !isEnabled { return 0.45 }
        return configuration.isPressed ? 0.85 : 1
    }

    private var scale: CGFloat {
        configuration.isPressed && !reduceMotion ? 0.97 : 1
    }

    var body: some View {
        configuration.label
            .font(BobFont.bodyStrong)
            .foregroundStyle(text)
            .multilineTextAlignment(.center)
            .padding(.horizontal, horizontalPadding)
            .frame(maxWidth: expands ? .infinity : nil, minHeight: minHeight)
            .background(fill, in: RoundedRectangle(cornerRadius: BobLayout.controlRadius, style: .continuous))
            .overlay {
                if let stroke {
                    RoundedRectangle(cornerRadius: BobLayout.controlRadius, style: .continuous).strokeBorder(stroke, lineWidth: 1.5)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: BobLayout.controlRadius, style: .continuous))
            .frame(minWidth: 44)
            .opacity(opacity)
            .scaleEffect(scale)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

#Preview {
    VStack(spacing: 16) {
        Button("Save plan") {}
            .buttonStyle(BobPrimaryButtonStyle(expands: true))
        Button("Not now") {}
            .buttonStyle(BobSecondaryButtonStyle())
        Button("Unavailable") {}
            .buttonStyle(BobPrimaryButtonStyle())
            .disabled(true)
    }
    .padding()
    .bobPage()
}
