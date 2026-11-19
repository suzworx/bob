import BobKit
import SwiftUI

struct HomeDashboard: View {
    let store: ProductivityStore
    @Environment(\.dynamicTypeSize) private var typeSize

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 4), count: typeSize.isAccessibilitySize ? 1 : 2)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            NavigationLink(value: ProductivityRoute.search) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").accessibilityHidden(true)
                    Text("Search anything").font(.body)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(BobColor.wash, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
            }
            .buttonStyle(BobPressStyle())
            .accessibilityHint("Searches chats, notes, tasks and more")

            VStack(alignment: .leading, spacing: 10) {
                heading("Everyday")
                LazyVGrid(columns: columns, spacing: 4) {
                    everyday("Tasks", icon: "checkmark.circle", route: .tasks)
                    everyday("Notes", icon: "note.text", route: .notes)
                    everyday("Reminders", icon: "bell", route: .reminders)
                    everyday("My Apps", icon: "square.grid.2x2", route: .apps(spaceID: nil, canManage: true))
                }
                .padding(6)
                .background(BobColor.surface, in: RoundedRectangle(cornerRadius: 14))
                if let space = store.scope.current {
                    Text("Tasks, notes and reminders in \(space.name)")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    heading("Recent spaces")
                    Spacer(minLength: 12)
                    NavigationLink("See all", value: ProductivityRoute.spaces)
                        .font(.subheadline.weight(.medium))
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("See all spaces")
                }
                recentSpaces
                HomeDestinationRow(title: "Group chats", icon: "bubble.left.and.bubble.right", route: .groupChats)
            }

            VStack(alignment: .leading, spacing: 2) {
                heading("With Bob").padding(.bottom, 6)
                HomeDestinationRow(title: "Memory", icon: "brain", route: .memory)
                HomeDestinationRow(title: "Insights", icon: "sparkles", route: .insights)
                HomeDestinationRow(title: "Timeline", icon: "clock.arrow.circlepath", route: .timeline)
            }

            VStack(alignment: .leading, spacing: 2) {
                heading("Connect & automate").padding(.bottom, 6)
                HomeDestinationRow(title: "Integrations", icon: "link", route: .integrations)
                HomeDestinationRow(title: "Routines", icon: "repeat", route: .routines)
                HomeDestinationRow(title: "Tools", icon: "slider.horizontal.3", route: .tools)
            }
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
    }

    private func everyday(_ title: String, icon: String, route: ProductivityRoute) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.body).foregroundStyle(BobColor.accent)
                    .frame(width: 22).accessibilityHidden(true)
                Text(title).font(.body.weight(.medium)).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
    }

    @ViewBuilder private var recentSpaces: some View {
        switch store.spaces.phase {
        case .loading:
            ProgressView("Loading spaces…").font(.subheadline).frame(minHeight: 52)
        case .failed(let error):
            VStack(alignment: .leading, spacing: 6) {
                Text(ApiErrorMapper.userMessage(error)).font(.subheadline).foregroundStyle(.secondary)
                Button("Try again") { Task { await store.spaces.refresh() } }.frame(minHeight: 44)
            }
        case .loaded:
            if store.spaces.sorted.isEmpty {
                NavigationLink(value: ProductivityRoute.spaces) {
                    Label("Create or join a space", systemImage: "plus")
                        .font(.body).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                }
            }
            ForEach(store.spaces.sorted.prefix(3)) { space in
                NavigationLink(value: ProductivityRoute.space(space.id)) {
                    HomeSpaceLabel(space: space)
                }
                .buttonStyle(BobPressStyle())
            }
        }
    }
}

struct HomeDestinationRow: View {
    let title: String
    let icon: String
    let route: ProductivityRoute

    var body: some View {
        NavigationLink(value: route) {
            HStack(spacing: 12) {
                Image(systemName: icon).font(.body).foregroundStyle(.secondary)
                    .frame(width: 24).accessibilityHidden(true)
                Text(title).font(.body).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary).accessibilityHidden(true)
            }
            .padding(.vertical, 8)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(BobPressStyle())
    }
}

struct HomeSpaceLabel: View {
    let space: SpaceSummary

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: space.kind == .private ? "lock" : "person.2")
                .font(.body).foregroundStyle(.secondary).frame(width: 24).accessibilityHidden(true)
            Text(space.name).font(.body).foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if space.unreadCount > 0 { BobBadge(count: space.unreadCount) }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary).accessibilityHidden(true)
        }
        .padding(.vertical, 8)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(space.unreadCount > 0 ? "\(space.unreadCount) unread" : "")
    }
}
