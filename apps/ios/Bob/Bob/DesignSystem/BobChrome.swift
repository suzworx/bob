import SwiftUI
import UIKit
import BobKit

// An icon with its word under it. Every toolbar and inline icon action; icon-only controls are not allowed.
// See apps/ios/DESIGN.md §3–4.
struct BobBarButton: View {
    let title: String
    let systemImage: String
    var unread = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage)
                    .font(BobFont.body)
                    .overlay(alignment: .topTrailing) {
                        if unread > 0 {
                            Circle().fill(BobColor.dangerText)
                                .frame(width: 8, height: 8)
                                .offset(x: 6, y: -2)
                                .accessibilityHidden(true)
                        }
                    }
                Text(title).font(BobFont.control).lineLimit(1)
            }
            .foregroundStyle(BobColor.ink)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel(title)
        .accessibilityValue(unread > 0 ? "\(unread) unread" : "")
    }
}

extension View {
    // A tab root: large lowercase title on the page, inbox and at most one primary action top right.
    func bobRoot(_ title: String) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(BobColor.page, for: .navigationBar)
    }

    // A child page: native back, the title, and under it who can see this.
    func bobChild(_ title: String, scope: String? = nil) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(BobColor.page, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(title).font(BobFont.bodyStrong).lineLimit(1)
                        if let scope {
                            Text(scope).font(BobFont.label).foregroundStyle(BobColor.muted).lineLimit(1)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
            }
    }
}

// Navigation bar titles in Bob's face, set once at launch.
enum BobNavigationAppearance {
    static func apply(_ typeface: BobAppearance.Typeface) {
        guard typeface == .mono else { return }
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.shadowColor = .clear
        let large = UIFontMetrics(forTextStyle: .title1).scaledFont(for: .monospacedSystemFont(ofSize: 28, weight: .bold))
        let inline = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .monospacedSystemFont(ofSize: 15, weight: .bold))
        appearance.largeTitleTextAttributes = [.font: large]
        appearance.titleTextAttributes = [.font: inline]
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = appearance
        bar.scrollEdgeAppearance = appearance
        bar.compactAppearance = appearance
    }
}

// A section's label in a plain list. Opaque, so a pinned label never sits on top of the rows under it.
struct BobSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(BobFont.label)
            .foregroundStyle(BobColor.muted)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .bottomLeading)
            .padding(.horizontal, BobLayout.pageMargin)
            .padding(.bottom, 4)
            .background(BobColor.page)
            .listRowInsets(EdgeInsets())
            .accessibilityAddTraits(.isHeader)
    }
}
