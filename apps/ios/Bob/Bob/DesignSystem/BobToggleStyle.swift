import SwiftUI

// Label on the left, an ok-green or control-line track on the right. The whole row toggles,
// and VoiceOver still reads it as a switch with its on or off value.
struct BobToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        BobToggleRow(configuration: configuration)
    }
}

private struct BobToggleRow: View {
    let configuration: ToggleStyleConfiguration

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var trackWidth: CGFloat = 42
    @ScaledMetric(relativeTo: .subheadline) private var trackHeight: CGFloat = 25
    @ScaledMetric(relativeTo: .subheadline) private var knobInset: CGFloat = 2.5

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // At accessibility sizes the track moves under the label so the row stays on screen.
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            configuration.label
                .font(BobFont.rowTitle)
                .foregroundStyle(.primary)
                .lineLimit(nil)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            track
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .opacity(isEnabled ? 1 : 0.45)
        .onTapGesture {
            guard isEnabled else { return }
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                configuration.isOn.toggle()
            }
        }
        .accessibilityRepresentation {
            Toggle(isOn: configuration.$isOn) {
                configuration.label
            }
        }
    }

    private var track: some View {
        Capsule()
            .fill(configuration.isOn ? BobColor.okFill : BobColor.controlLine)
            .frame(width: trackWidth, height: trackHeight)
            .overlay(alignment: configuration.isOn ? .trailing : .leading) {
                Circle()
                    .fill(BobColor.surface)
                    .padding(knobInset)
                    .frame(width: trackHeight, height: trackHeight)
            }
    }
}

#Preview {
    @Previewable @State var remindMe = true
    @Previewable @State var share = false
    VStack(spacing: 8) {
        Toggle("Morning reminders", isOn: $remindMe)
        Toggle("Share location", isOn: $share)
    }
    .toggleStyle(BobToggleStyle())
    .padding()
    .bobPage()
}
