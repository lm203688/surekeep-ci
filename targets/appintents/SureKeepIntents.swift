import AppIntents
import Foundation

// SureKeep：离线、带口令保护的证件与密码保险库。
// 证件最容易出事的不是"找不到"，而是"到期忘了"——所以意图层把有效期算术做成
// 可被 Siri / 快捷指令直接调用的功能：从到期日算提醒日，或从签发日按证件法定
// 有效期算到期日。文档本体不读，避免在锁屏语境下泄露任何内容。

@available(iOS 16.0, *)
struct DocumentKindEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "Document kind")
  static var defaultQuery = DocumentKindQuery()

  let id: String
  let summary: String
  /// Nominal validity in months, used when only the issue date is known. 0 = no standard.
  let validityMonths: Int

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(summary)", subtitle: "\(validityMonths) months")
  }

  static let all: [DocumentKindEntity] = [
    DocumentKindEntity(id: "passport", summary: "Passport", validityMonths: 120),
    DocumentKindEntity(id: "driving-licence", summary: "Driving licence", validityMonths: 96),
    DocumentKindEntity(id: "id-card", summary: "National ID card", validityMonths: 120),
    DocumentKindEntity(id: "insurance", summary: "Insurance policy", validityMonths: 12),
    DocumentKindEntity(id: "lease", summary: "Lease or rental contract", validityMonths: 12),
    DocumentKindEntity(id: "other", summary: "Other document", validityMonths: 0),
  ]
}

@available(iOS 16.0, *)
struct DocumentKindQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [DocumentKindEntity] {
    DocumentKindEntity.all.filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [DocumentKindEntity] {
    DocumentKindEntity.all
  }

  func defaultResult() async -> DocumentKindEntity? {
    DocumentKindEntity.all.first
  }
}

@available(iOS 16.0, *)
private enum SKDate {
  static let day: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "d MMM yyyy"
    return f
  }()

  static func days(from: Date, to: Date) -> Int {
    let cal = Calendar.current
    return cal.dateComponents([.day], from: cal.startOfDay(for: from), to: cal.startOfDay(for: to)).day ?? 0
  }
}

@available(iOS 16.0, *)
struct DocExpiryIntent: AppIntent {
  static var title: LocalizedStringResource = "When does this document expire"
  static var description: IntentDescription? = IntentDescription(
    "Tells you how long a passport, licence or policy has left and when to start renewing it, based on the expiry date you already know."
  )
  static var openAppWhenRun: Bool = false

  @Parameter(title: "Document")
  var kind: DocumentKindEntity

  @Parameter(title: "Expiry date", requestValueDialog: "When does it expire?")
  var expiry: Date

  @Parameter(title: "Start reminding this many days before", default: 90)
  var leadDays: Int

  static var parameterSummary: some ParameterSummary {
    Summary("When does my \(\.$kind) expire")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let lead = min(max(leadDays, 0), 365)
    let left = SKDate.days(from: Date(), to: expiry)
    let remindOn = Calendar.current.date(byAdding: .day, value: -lead, to: expiry) ?? expiry
    let renew = "Start renewing on \(SKDate.day.string(from: remindOn)), \(lead) days ahead."
    if left < 0 {
      return .result(
        dialog: "Your \(kind.summary) expired \(-left) days ago (on \(SKDate.day.string(from: expiry))). \(renew)"
      )
    }
    if left == 0 {
      return .result(dialog: "Your \(kind.summary) expires today. \(renew)")
    }
    if left <= lead {
      return .result(
        dialog: "Your \(kind.summary) expires on \(SKDate.day.string(from: expiry)) — \(left) days left, inside your \(lead)-day window. \(renew)"
      )
    }
    return .result(
      dialog: "Your \(kind.summary) expires on \(SKDate.day.string(from: expiry)) — \(left) days left. \(renew)"
    )
  }
}

@available(iOS 16.0, *)
struct DocValidityIntent: AppIntent {
  static var title: LocalizedStringResource = "When should I renew this document"
  static var description: IntentDescription? = IntentDescription(
    "Works out the expiry date and renewal start from the issue date, using the usual validity period for that document type."
  )
  static var openAppWhenRun: Bool = false

  @Parameter(title: "Document")
  var kind: DocumentKindEntity

  @Parameter(title: "Issue date", requestValueDialog: "When was it issued?")
  var issued: Date

  @Parameter(title: "Renewal lead time in days", default: 120)
  var leadDays: Int

  static var parameterSummary: some ParameterSummary {
    Summary("Renewal date for my \(\.$kind)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard kind.validityMonths > 0 else {
      return .result(
        dialog: "\(kind.summary) has no standard validity period, so give me the expiry date instead and I will count the days."
      )
    }
    guard let expires = Calendar.current.date(byAdding: .month, value: kind.validityMonths, to: issued) else {
      return .result(dialog: "I could not work out a date from \(SKDate.day.string(from: issued)).")
    }
    let lead = min(max(leadDays, 0), 365)
    let remindOn = Calendar.current.date(byAdding: .day, value: -lead, to: expires) ?? expires
    let left = SKDate.days(from: Date(), to: expires)
    let today = SKDate.day.string(from: Date())
    let status: String
    if left > 0 {
      status = String(left) + " days left."
    } else if left == 0 {
      status = "It runs out today."
    } else {
      status = "It lapsed on " + SKDate.day.string(from: expires) + "."
    }
    let lines = "A " + kind.summary + " issued on " + SKDate.day.string(from: issued)
      + " runs " + String(kind.validityMonths) + " months, to " + SKDate.day.string(from: expires) + ". "
      + status + " Start renewing on " + SKDate.day.string(from: remindOn) + " (today is " + today + ")."
    return .result(dialog: IntentDialog(stringLiteral: lines))
  }
}

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
      intent: DocExpiryIntent(),
      phrases: [
        "When does my passport expire in \(.applicationName)",
        "Check a document expiry in \(.applicationName)",
      ],
      shortTitle: "Document expiry",
      systemImageName: "calendar.badge.clock"
    )
    AppShortcut(
      intent: DocValidityIntent(),
      phrases: [
        "When should I renew my licence in \(.applicationName)",
        "Renewal date in \(.applicationName)",
      ],
      shortTitle: "Renewal date",
      systemImageName: "arrow.triangle.2.circlepath"
    )
    AppShortcut(
      intent: SureKeepOpenIntent(),
      phrases: ["Open \(.applicationName)", "Launch \(.applicationName)"],
      shortTitle: "Open SureKeep",
      systemImageName: "lock.shield"
    )
  }
}
