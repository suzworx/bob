import BobKit
import SwiftUI

// A filled circle with a person's initials. Decorative: the row beside it reads the name.
struct BobAvatar: View {
    enum Size {
        case small
        case large
    }

    let initials: String
    var size: Size = .small
    var fillIndex: Int = 0

    @ScaledMetric(relativeTo: .caption2) private var smallDiameter: CGFloat = 26
    @ScaledMetric(relativeTo: .title3) private var largeDiameter: CGFloat = 54

    private var diameter: CGFloat {
        switch size {
        case .small: smallDiameter
        case .large: largeDiameter
        }
    }

    private var font: Font {
        switch size {
        case .small: BobFont.caption
        case .large: BobFont.heading
        }
    }

    var body: some View {
        Text(initials)
            .font(font)
            .foregroundStyle(Color(BobPalette.ink))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(width: diameter, height: diameter)
            .background(BobColor.avatarFill(fillIndex), in: Circle())
            .accessibilityHidden(true)
    }
}

#Preview {
    HStack(spacing: 12) {
        BobAvatar(initials: "MC", fillIndex: 0)
        BobAvatar(initials: "SO", fillIndex: 1)
        BobAvatar(initials: "JL", fillIndex: 2)
        BobAvatar(initials: "AR", fillIndex: -1)
        BobAvatar(initials: "MC", size: .large, fillIndex: 3)
    }
    .padding()
    .bobPage()
}
