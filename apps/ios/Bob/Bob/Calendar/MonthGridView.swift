import BobKit
import SwiftUI

// The month: previous and next, seven columns from Monday, and a dot on every day that holds something.
struct MonthGridView: View {
    let model: CalendarModel

    private var isOnToday: Bool { model.selectedDay == model.today && model.month == CalendarDays.month(of: model.today) }

    var body: some View {
        VStack(spacing: 4) {
            header
            HStack(spacing: 0) {
                ForEach(Array(CalendarDays.weekdaySymbols().enumerated()), id: \.offset) { _, symbol in
                    Text(symbol)
                        .font(BobFont.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .frame(maxWidth: .infinity)
                }
            }
            .accessibilityHidden(true)
            ForEach(CalendarDays.weeks(of: model.month), id: \.first) { week in
                HStack(spacing: 0) {
                    ForEach(week, id: \.self) { cell($0) }
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text(CalendarDays.monthTitle(model.month))
                .font(BobFont.heading)
                .accessibilityAddTraits(.isHeader)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 4)
            if !isOnToday {
                Button("Today") { model.goToToday() }
                    .font(BobFont.caption)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .buttonStyle(BobPressStyle())
            }
            chevron("chevron.left", label: "Previous month", months: -1)
            chevron("chevron.right", label: "Next month", months: 1)
        }
    }

    private func chevron(_ symbol: String, label: String, months: Int) -> some View {
        Button { model.moveMonth(months) } label: {
            Image(systemName: symbol).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel(label)
    }

    private func cell(_ day: String) -> some View {
        let isSelected = day == model.selectedDay
        let isToday = day == model.today
        let inMonth = CalendarDays.month(of: day) == model.month
        let count = model.byDay[day]?.count ?? 0
        return Button { model.select(day) } label: {
            VStack(spacing: 2) {
                Text(CalendarDays.dayNumber(day))
                    .font(BobFont.subline)
                    .fontWeight(isToday || isSelected ? .semibold : .regular)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .foregroundStyle(isSelected ? BobColor.onAccent : isToday ? BobColor.accent : inMonth ? Color.primary : Color.secondary)
                    .frame(minWidth: 32, minHeight: 32)
                    .background { if isSelected { Circle().fill(BobColor.accent) } }
                Circle()
                    .fill(count > 0 ? BobColor.accent : Color.clear)
                    .frame(width: 5, height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
        .accessibilityLabel(accessibilityText(day, count: count, isToday: isToday))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func accessibilityText(_ day: String, count: Int, isToday: Bool) -> String {
        var parts = [CalendarDays.fullTitle(day)]
        if isToday { parts.insert("Today", at: 0) }
        parts.append(count == 0 ? "nothing on" : count == 1 ? "1 item" : "\(count) items")
        return parts.joined(separator: ", ")
    }
}
