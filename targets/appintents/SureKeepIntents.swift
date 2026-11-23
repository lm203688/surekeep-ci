import AppIntents
import Foundation

// SureKeep：只做「打开 App」这一条，不带任何数据读取——该产品没有与扩展共享的存储。
@available(iOS 16.0, *)
struct SureKeepOpenIntent: AppIntent {
  static var title: LocalizedStringResource = "Open SureKeep"
  static var description: IntentDescription? = IntentDescription(
    "Opens SureKeep: your offline, passcode-protected documents and passwords."
  )
  static var openAppWhenRun: Bool = true

  func perform() async throws -> some IntentResult {
    return .result()
  }
}

@available(iOS 16.0, *)
struct SureKeepShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: SureKeepOpenIntent(),
      phrases: ["Open \(.applicationName)", "Launch \(.applicationName)"],
      shortTitle: "Open SureKeep",
      systemImageName: "lock.shield"
    )
  }
}
