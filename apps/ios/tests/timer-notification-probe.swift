import BobKit
import Foundation
import UserNotifications

@main struct TimerNotificationProbe {
    static func main() {
        let account = "test-account"
        let timer = "test-timer"
        let alert = TimerAlert(id: TimerAlert.identifier(accountID: account, timerID: timer),
            accountID: account, timerID: timer, sourceFireAt: Date(timeIntervalSince1970: 1_800_000_000),
            title: "Tea is ready", delay: 12.5)
        let request = TimerNotificationScheduler.request(for: alert)
        precondition(request.identifier == alert.id)
        precondition(request.content.title == alert.title)
        precondition(request.content.sound != nil, "Timer requests must ask iOS to play a sound")
        precondition(request.content.badge == nil, "Timer alerts must not overwrite the inbox badge")
        let trigger = request.trigger as? UNTimeIntervalNotificationTrigger
        precondition(trigger?.timeInterval == 12.5 && trigger?.repeats == false)
        precondition(TimerNotificationScheduler.alert(request) == alert, "Persisted metadata must round-trip")

        let forged = UNNotificationRequest(identifier: "unrelated-notification", content: request.content, trigger: trigger)
        precondition(TimerNotificationScheduler.alert(forged) == nil, "Must not take ownership of another feature's alerts")
        let wrongAccount = request.content.mutableCopy() as! UNMutableNotificationContent
        wrongAccount.userInfo["accountID"] = "different-account"
        precondition(TimerNotificationScheduler.alert(UNNotificationRequest(identifier: alert.id, content: wrongAccount, trigger: trigger)) == nil)
        let incomplete = UNMutableNotificationContent()
        incomplete.userInfo = ["bobType": "timer"]
        precondition(TimerNotificationScheduler.alert(UNNotificationRequest(identifier: alert.id, content: incomplete, trigger: nil)) == nil)
        let nearDeadline = TimerAlert(id: alert.id, accountID: account, timerID: timer,
            sourceFireAt: alert.sourceFireAt, title: alert.title, delay: 0.1)
        precondition((TimerNotificationScheduler.request(for: nearDeadline).trigger as? UNTimeIntervalNotificationTrigger)?.timeInterval == 1)
        print("PASS: native timer request sound, badge, relative deadline, metadata, ownership and malformed payload checks")
    }
}
