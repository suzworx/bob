import BobKit
import SwiftUI

// Six cells over one real text field, so autofill, paste and VoiceOver all see a single field.
struct SignInCodeField: View {
    @Binding var code: String
    var focus: FocusState<Bool>.Binding
    let onSubmit: () -> Void

    // The field's own text. Cleaning a binding to an unchanged value would not reach the text field, so this is written back.
    @State private var draft = ""
    @ScaledMetric(relativeTo: .title) private var cellHeight: CGFloat = 52

    var body: some View {
        ZStack {
            HStack(spacing: 8) {
                ForEach(0..<SignInFlow.codeLength, id: \.self) { index in
                    cell(index)
                }
            }
            .accessibilityHidden(true)

            TextField("", text: $draft)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .focused(focus)
                .onSubmit(onSubmit)
                .foregroundStyle(.clear)
                .tint(.clear)
                .frame(maxWidth: .infinity, minHeight: cellHeight)
                .accessibilityLabel("Six-digit code")
                .accessibilityValue(code)
        }
        .contentShape(Rectangle())
        .onTapGesture { focus.wrappedValue = true }
        .onAppear { draft = code }
        .onChange(of: draft) { _, value in
            code = value
            if draft != code {
                draft = code
            }
        }
        .onChange(of: code) { _, value in
            if draft != value {
                draft = value
            }
        }
    }

    private func cell(_ index: Int) -> some View {
        let digits = Array(code)
        let isFilled = index < digits.count
        let isActive = focus.wrappedValue && index == min(digits.count, SignInFlow.codeLength - 1)
        return Text(isFilled ? String(digits[index]) : " ")
            .font(.title2.weight(.medium))
            .foregroundStyle(isFilled ? BobColor.ink : BobColor.muted)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .frame(maxWidth: .infinity, minHeight: cellHeight)
            .background(BobColor.wash, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(BobColor.ink, lineWidth: isActive ? 1.5 : 0)
            }
    }
}
