import BobKit
import CoreText
import SwiftUI
import UIKit

struct MarketingCreativeView: View {
    let draft: MarketingDraft
    let package: MarketingPackage?
    @State private var image: UIImage?
    @State private var failed = false
    @State private var sharing = false
    @State private var previewing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let image {
                Button { previewing = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 260)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityLabel("Preview image for this post")
                Button("Share image", systemImage: "square.and.arrow.up") { sharing = true }
                    .buttonStyle(.bordered)
            } else if failed {
                Text("Bob couldn't draw this image. Your post is safe.").font(BobFont.subline).foregroundStyle(.secondary)
                Button("Try drawing again") { render() }
            } else { ProgressView("Drawing your image…") }
        }
        .task(id: "\(draft.id):\(draft.contentRevision)") { render() }
        .sheet(isPresented: $sharing) { if let image { MarketingImageShare(image: image) } }
        .sheet(isPresented: $previewing) {
            NavigationStack {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().padding().bobNavTitle("Post image")
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { previewing = false } } }
                }
            }.bobSheet()
        }
    }
    private func render() {
        failed = false; image = nil
        let playful = package?.assets.contains { draft.approvedAssetIds.contains($0.id) && $0.url.contains("bob-playful") } ?? false
        image = MarketingCreativeRenderer.render(text: draft.body, channel: draft.channel, assetName: playful ? "BobPlayful" : "BobHelper")
        failed = image == nil
    }
}

private struct MarketingImageShare: UIViewControllerRepresentable {
    let image: UIImage
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [image], applicationActivities: nil) }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

/// A portable brand image, using the original bundled art at or below its original dimensions.
@MainActor private enum MarketingCreativeRenderer {
    private static let registered: Bool = {
        guard let url = Bundle.main.url(forResource: "Nunito", withExtension: "ttf") else { return false }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        return UIFont(name: "Nunito-ExtraLight", size: 20) != nil
    }()
    static func render(text: String, channel: MarketingChannel, assetName: String) -> UIImage? {
        guard registered, let art = UIImage(named: assetName), art.size.width > 0, art.size.height > 0 else { return nil }
        let instagram = channel == .instagram
        let width: CGFloat = instagram ? 1080 : 1200, height: CGFloat = instagram ? 1080 : 627
        let margin: CGFloat = instagram ? 72 : 56, gap: CGFloat = 48
        let fontSize: CGFloat = instagram ? 56 : 48, lineHeight: CGFloat = instagram ? 72 : 62
        let maxLines = instagram ? 4 : 6
        let descriptor = UIFontDescriptor(fontAttributes: [.name: "Nunito-ExtraLight", UIFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String): [NSNumber(value: 0x77676874): NSNumber(value: 700)]])
        let font = UIFont(descriptor: descriptor, size: fontSize)
        let artWidth = instagram ? width - 2 * margin : width * 0.45
        let artHeight = instagram ? height - 2 * margin - gap - CGFloat(maxLines) * lineHeight : height - 2 * margin
        let scale = min(1, artWidth / art.size.width, artHeight / art.size.height)
        let size = CGSize(width: (art.size.width * scale).rounded(), height: (art.size.height * scale).rounded())
        let captionWidth = instagram ? width - 2 * margin : width - 2 * margin - gap - size.width
        let lines = wrap(text, width: captionWidth, maxLines: maxLines, font: font)
        let totalHeight = size.height + (lines.isEmpty ? 0 : gap + CGFloat(lines.count) * lineHeight)
        let bobX = instagram || lines.isEmpty ? (width - size.width) / 2 : width - margin - size.width
        let bobY = instagram ? (height - totalHeight) / 2 : (height - size.height) / 2
        let textY = instagram ? bobY + size.height + gap : (height - CGFloat(lines.count) * lineHeight) / 2
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            // Fixed export colors match the web creative; appearance preferences affect the surrounding app.
            UIColor(red: 187 / 255, green: 221 / 255, blue: 240 / 255, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            art.draw(in: CGRect(origin: CGPoint(x: bobX, y: bobY), size: size))
            let style = NSMutableParagraphStyle(); style.alignment = instagram ? .center : .left
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(red: 23 / 255, green: 62 / 255, blue: 87 / 255, alpha: 1), .paragraphStyle: style]
            for (index, line) in lines.enumerated() {
                (line as NSString).draw(in: CGRect(x: margin, y: textY + CGFloat(index) * lineHeight, width: captionWidth, height: lineHeight), withAttributes: attributes)
            }
        }
    }
    private static func wrap(_ text: String, width: CGFloat, maxLines: Int, font: UIFont) -> [String] {
        func fits(_ value: String) -> Bool { (value as NSString).size(withAttributes: [.font: font]).width <= width }
        var lines: [String] = [], current = ""
        for word in text.split(whereSeparator: \.isWhitespace).map(String.init) {
            if lines.count > maxLines { break }
            let combined = current.isEmpty ? word : "\(current) \(word)"
            if fits(combined) { current = combined; continue }
            if !current.isEmpty { lines.append(current) }
            var remainder = word
            while !fits(remainder) && lines.count <= maxLines {
                var head = ""
                for character in remainder { if !head.isEmpty && !fits(head + String(character)) { break }; head.append(character) }
                if head.isEmpty { break }
                lines.append(head); remainder.removeFirst(head.count)
            }
            current = remainder
        }
        if !current.isEmpty { lines.append(current) }
        guard lines.count > maxLines else { return lines }
        var last = lines[maxLines - 1]
        while !last.isEmpty && !fits(last + "…") { last.removeLast() }
        return Array(lines.prefix(maxLines - 1)) + [last.trimmingCharacters(in: .whitespaces) + "…"]
    }
}
