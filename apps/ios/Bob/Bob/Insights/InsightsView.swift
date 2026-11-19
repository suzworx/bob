import BobKit
import SwiftUI

struct InsightsView: View {
    @State private var model = InsightServices.insights()

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 12) {
                Text("Saved insights from your connected accounts. Only you can see these.")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                Picker("Perspective", selection: $model.category) {
                    ForEach(InsightCategory.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .bobChoicePicker()
            }
            .padding(.vertical, 12)
            .bobListRow(divider: false)
            if model.category == .future {
                Text("Possibilities, not promises. Each outlook includes its sources and uncertainty.")
                    .font(BobFont.subline)
                    .foregroundStyle(.secondary)
                    .bobListRow(divider: false)
            }
            if model.category != .past {
                InsightPreparationView(category: model.category) { await model.refresh() }
                    .id(model.category)
            }
            results
        }
        .bobList()
        .bobNavTitle("Insights")
        .privacySensitive()
        .task(id: model.category) { await model.refresh() }
        .refreshable { await model.refresh() }
        .onDisappear { model.cancel() }
    }

    @ViewBuilder private var results: some View {
        switch model.phase {
        case .loading:
            ProgressView("Opening your insights…").bobListRow(divider: false)
        case .failed(let error):
            BobLoadFailure(title: "Couldn't load your insights", error: error) { await model.refresh() }
                .bobListRow(divider: false)
        case .loaded:
            if model.rows.isEmpty {
                ContentUnavailableView("A little perspective, soon", systemImage: "sparkles", description: Text("Saved \(model.category.title.lowercased()) insights will appear here when Bob prepares them from your connected accounts. Pull down to check again."))
                    .bobListRow(divider: false)
            }
            ForEach(model.rows) { insight in
                NavigationLink {
                    InsightDetailView(insight: insight)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(insight.title).font(BobFont.rowTitle)
                        Text(insight.generatedAt, format: .dateTime.month().day().hour().minute())
                            .font(BobFont.subline).foregroundStyle(.secondary)
                        if insight.partial {
                            Label("Partial coverage", systemImage: "info.circle").font(BobFont.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .bobListRow()
            }
        }
    }
}

private struct InsightDetailView: View {
    let insight: Insight

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 12) {
                Text(insight.title).font(BobFont.heading).accessibilityAddTraits(.isHeader)
                Text("Prepared \(ProductivityText.moment(insight.generatedAt))")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                Text("\(ProductivityText.day(insight.periodStart)) – \(ProductivityText.day(insight.periodEnd))")
                    .font(BobFont.subline).foregroundStyle(.secondary)
                if insight.partial {
                    Label("Some sources couldn't be included. This perspective may be incomplete.", systemImage: "info.circle")
                        .font(BobFont.body)
                }
                ChatMarkdownView(text: insight.summary)
                    .textSelection(.enabled)
            }
            .padding(.vertical, 12)
            .bobListRow(divider: false)
            BobGroupHeader(title: "Sources")
            ForEach(insight.sources) { source in
                if let url = source.safeURL {
                    Link(destination: url) { sourceLabel(source, linked: true) }.bobListRow()
                } else {
                    sourceLabel(source, linked: false).bobListRow()
                }
            }
            if insight.sources.isEmpty {
                Text("No source links were saved for this insight.").font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            }
        }
        .bobList()
        .bobNavTitle(insight.category.title)
        .privacySensitive()
    }

    private func sourceLabel(_ source: InsightSource, linked: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: source.kind == .gmail ? "envelope" : "calendar").accessibilityHidden(true)
            Text(source.label.isEmpty ? "Source" : source.label).font(BobFont.rowTitle)
            Spacer(minLength: 4)
            if linked { Image(systemName: "arrow.up.right").accessibilityHidden(true) }
        }
        .foregroundStyle(BobColor.ink)
    }
}
