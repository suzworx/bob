import BobKit
import Charts
import SwiftUI

struct OperatorMetricsView: View {
    @State private var model = AdminServices.metrics()
    @Environment(\.scenePhase) private var scenePhase
    private var selection: String { model.lens.rawValue + model.range.rawValue }
    var body: some View {
        List {
            Text("Anonymous aggregates only: counts and times, never a person. Small user counts stay hidden.")
                .font(BobFont.subline).foregroundStyle(.secondary).bobListRow(divider: false)
            Picker("Lens", selection: $model.lens) {
                ForEach(OperatorMetricsLens.allCases, id: \.self) { Text($0.title).tag($0) }
            }.bobListRow()
            Picker("Time range", selection: $model.range) {
                ForEach(OperatorMetricsRange.allCases, id: \.self) { Text($0.title).tag($0) }
            }.bobListRow()
            switch model.phase {
            case .loading: ProgressView("Loading metrics…").bobListRow(divider: false)
            case .failed(let error):
                BobLoadFailure(title: "Metrics aren't available", error: error) { await model.refresh() }.bobListRow()
            case .loaded:
                ForEach(model.documents) { document in
                    BobGroupHeader(title: document.page.rawValue == "ai" ? "AI" : document.page.rawValue.capitalized)
                    Text("\(AdminServices.date(document.from)) – \(AdminServices.date(document.to)) · \(document.bucket) buckets")
                        .font(BobFont.caption).foregroundStyle(.secondary).bobListRow(divider: false)
                    ForEach(document.blocks) { block in
                        metricBlock(block)
                    }
                }
            }
        }
        .bobList().bobNavTitle("Metrics")
        .task(id: selection) { await model.refresh() }
        .refreshable { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refresh() } } }
        .onDisappear { model.cancel() }
    }
    private func metricBlock(_ block: OperatorMetricBlock) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(block.title).font(BobFont.rowTitle).accessibilityAddTraits(.isHeader)
            if !block.points.isEmpty {
                Chart(block.points) { point in
                    LineMark(x: .value("Date", point.date), y: .value(block.title, point.value))
                        .foregroundStyle(by: .value("Series", point.series))
                }
                .frame(height: 190)
                .accessibilityLabel(block.title)
                DisclosureGroup("Values") { facts(block.facts) }
                    .font(BobFont.subline)
            } else {
                facts(block.facts)
            }
            if block.facts.isEmpty { Text("No data in this period.").font(BobFont.subline).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 8).bobListRow()
    }
    private func facts(_ facts: [OperatorMetricFact]) -> some View {
        ForEach(facts) { fact in
            HStack(alignment: .firstTextBaseline) {
                Text(fact.label).font(BobFont.subline)
                Spacer(minLength: 12)
                Text(fact.value).font(BobFont.subline).monospacedDigit().foregroundStyle(.secondary).multilineTextAlignment(.trailing)
            }.accessibilityElement(children: .combine)
        }
    }
}
