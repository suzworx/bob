import SwiftUI

// Every design system component in a realistic state, for review and previews only.
struct DesignCatalogView: View {
    @State private var remindMe = true

    @ScaledMetric(relativeTo: .body) private var sectionSpacing: CGFloat = 24
    @ScaledMetric(relativeTo: .body) private var verticalPadding: CGFloat = 20
    // Fixed so large text keeps the screen width for the words.
    private let pageMargin = BobLayout.pageMargin

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: sectionSpacing) {
                Text("Good morning, Alex")
                    .font(BobFont.greeting)
                    .accessibilityAddTraits(.isHeader)

                VStack(alignment: .leading, spacing: 4) {
                    BobSectionHeader(caption: "PEOPLE", actionTitle: "View all") {}
                    BobInsetGroup {
                        BobRow(title: "Maya Chen", subline: "Dinner on Friday?", meta: "2m", showsChevron: true)
                        BobRow(title: "Sam Okafor", subline: "Sent a photo", meta: "1h", showsChevron: true)
                        BobRow(title: "Reminders", subline: "3 due today", meta: "9:00", showsChevron: true, systemImage: "bell")
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Avatars and badge")
                        .font(BobFont.heading)
                        .accessibilityAddTraits(.isHeader)
                    // Avatars grow with Dynamic Type, so fall back to fewer per line rather than overflow.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) {
                            smallAvatars
                            largeAvatarAndBadge
                        }
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(spacing: 12) { smallAvatars }
                            HStack(spacing: 12) { largeAvatarAndBadge }
                        }
                        VStack(alignment: .leading, spacing: 12) {
                            smallAvatars
                            largeAvatarAndBadge
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Actions")
                        .font(BobFont.heading)
                        .accessibilityAddTraits(.isHeader)
                    BobPill(title: "Plan dinner", systemImage: "fork.knife") {}
                    Button("Save plan") {}
                        .buttonStyle(BobPrimaryButtonStyle(expands: true))
                    Button("Not now") {}
                        .buttonStyle(BobSecondaryButtonStyle(expands: true))
                    Toggle("Morning reminders", isOn: $remindMe)
                        .toggleStyle(BobToggleStyle())
                }

                VStack(spacing: 8) {
                    BobChatBubble(text: "You have dinner with Maya on Friday. Want me to book the usual place?", isFromBob: true)
                    BobChatBubble(text: "Yes please, 7pm.", isFromBob: false)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("type").font(BobFont.lead).accessibilityAddTraits(.isHeader)
                    Text("title").font(BobFont.title)
                    Text("lead").font(BobFont.lead)
                    Text("body strong").font(BobFont.bodyStrong)
                    Text("body").font(BobFont.body)
                    Text("secondary").font(BobFont.secondary).foregroundStyle(BobColor.muted)
                    Text("label").font(BobFont.label).foregroundStyle(BobColor.muted)
                    Text("control").font(BobFont.control)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("bar buttons and item actions").font(BobFont.lead).accessibilityAddTraits(.isHeader)
                    HStack {
                        BobBarButton(title: "inbox", systemImage: "bell", unread: 3) {}
                        BobBarButton(title: "new", systemImage: "square.and.pencil") {}
                    }
                    BobActionList(actions: catalogActions)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("states").font(BobFont.lead).accessibilityAddTraits(.isHeader)
                    BobLoading("loading chats")
                    BobStaleNote(message: "Couldn't refresh. Showing what Bob had.", retry: {})
                    BobEmpty(title: "No chats yet", message: "Your conversations with Bob stay here.", systemImage: "bubble.left", actionTitle: "New chat", action: {})
                }
            }
            .padding(.horizontal, pageMargin)
            .padding(.vertical, verticalPadding)
        }
        .bobPage()
    }

    private var catalogActions: [BobAction] {
        [
            BobAction("Pin", systemImage: "pin", inSwipe: true) {},
            BobAction("Rename", systemImage: "pencil") {},
            BobAction("Archive", systemImage: "archivebox", safety: .undo, inSwipe: true) {},
            BobAction(
                "Delete",
                systemImage: "trash",
                isDestructive: true,
                safety: .confirm(title: "Delete this chat?", message: "Its messages will be deleted. Memories saved from it stay.", button: "Delete"),
                inSwipe: true
            ) {}
        ]
    }

    @ViewBuilder private var smallAvatars: some View {
        BobAvatar(initials: "MC", fillIndex: 0)
        BobAvatar(initials: "SO", fillIndex: 1)
        BobAvatar(initials: "JL", fillIndex: 2)
    }

    @ViewBuilder private var largeAvatarAndBadge: some View {
        BobAvatar(initials: "AR", size: .large, fillIndex: 3)
        BobBadge(count: 3)
    }
}

#Preview {
    DesignCatalogView()
}
